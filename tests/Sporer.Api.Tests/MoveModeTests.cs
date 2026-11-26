using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Sporer.Api.Features.Moves;
using Sporer.Api.Features.Timeline;
using Sporer.Testing;
using Sporer.Timeline;
using static Sporer.Api.Tests.TimelineSeeder;

namespace Sporer.Api.Tests;

/// <summary>
/// The owner's mode of a move (transit spec sections 4 and 5): <c>PUT</c> and <c>DELETE /api/moves/{id}/mode</c>, the day's
/// <c>modeEdited</c>, and the edits being put over the detected modes by every rebuild, a full one included.
/// </summary>
[Collection("db")]
public class MoveModeTests(DatabaseFixture db)
{
    private static readonly DateTime Day = new(2026, 10, 23, 0, 0, 0, DateTimeKind.Utc);
    private static readonly DateTimeOffset Now = new(2026, 10, 25, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Every2min = TimeSpan.FromMinutes(2);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime T(int hour, int minute = 0, int day = 0) => Day.AddDays(day).AddHours(hour).AddMinutes(minute);

    private static DateOnly D(int month, int day) => new(2026, month, day);

    /// <summary>Home 1 h, a walk to the cafe at 5 km/h, the cafe 25 min, a ride to the office at 18 km/h, the office 8 h.</summary>
    private static List<TrackPoint> CommuteDay() => new TrackBuilder(T(7), Spots.Home)
        .Stay(TimeSpan.FromHours(1), Every2min)
        .Travel(Spots.Cafe, 5, Every10s)
        .Stay(TimeSpan.FromMinutes(25), Every2min)
        .Travel(Spots.Office, 18, Every10s)
        .Stay(TimeSpan.FromHours(8), Every2min)
        .Build();

    private sealed record MoveRow(long Id, DateTime StartUtc, DateTime EndUtc, string? Mode, bool ModeEdited, double? DistanceM, string? GeometryDetail);

    private static Task<IReadOnlyList<MoveRow>> MovesAsync(string cs) => Sql.QueryAsync<MoveRow>(cs,
        """
        select id as Id, start_utc as StartUtc, end_utc as EndUtc, mode as Mode, mode_edited as ModeEdited, distance_m as DistanceM,
               geometry_detail::text as GeometryDetail
        from segment where kind = 'move' order by start_utc
        """, ct: Ct);

    private sealed record EditRow(DateTime FromUtc, DateTime ToUtc, string Mode);

    private static Task<IReadOnlyList<EditRow>> EditsAsync(string cs) => Sql.QueryAsync<EditRow>(cs,
        "select from_utc as FromUtc, to_utc as ToUtc, mode as Mode from mode_edit order by from_utc, id", ct: Ct);

    private sealed record DirtyRow(DateTime FromUtc, DateTime ToUtc, DateTime CreatedAt);

    private static Task<IReadOnlyList<DirtyRow>> DirtyAsync(string cs) => Sql.QueryAsync<DirtyRow>(cs,
        "select from_utc as FromUtc, to_utc as ToUtc, created_at as CreatedAt from dirty_range order by from_utc, id", ct: Ct);

    private static Task<HttpResponseMessage> PutModeAsync(HttpClient client, object id, string body)
        => client.PutAsync($"/api/moves/{id}/mode", new StringContent(body, Encoding.UTF8, "application/json"), Ct);

    private static async Task<JsonDocument> DayAsync(HttpClient client, string date)
    {
        var response = await client.GetAsync($"/api/day/{date}", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct));
    }

    private sealed class Harness(ApiFactory api, string cs, FakeTimeProvider clock) : IAsyncDisposable
    {
        public ApiFactory Api { get; } = api;
        public string Cs { get; } = cs;
        public FakeTimeProvider Clock { get; } = clock;
        public HttpClient Client { get; } = api.CreateClient(); // starting the host runs the migrations
        public ITimelineProcessor Processor => Api.Services.GetRequiredService<ITimelineProcessor>();
        public TimelineWorker Worker => Api.Services.GetRequiredService<TimelineWorker>();

        /// <summary>Records the version the worker would, so that its pass works on the dirty ranges and does not start a backfill.</summary>
        public Task SettleVersionAsync() => Sql.ExecAsync(Cs, "update processing_state set algorithm_version = @version",
            new { version = AlgorithmVersion.Compute(Api.Services.GetRequiredService<DetectionOptions>()) }, Ct);

        /// <summary>Runs worker passes until one finds nothing to do.</summary>
        public async Task DrainAsync()
        {
            for (var pass = 0; await Worker.RunOnceAsync(Ct); pass++)
                Assert.True(pass < 100, "the worker keeps finding work");
        }

        public ValueTask DisposeAsync() => Api.DisposeAsync();
    }

    private async Task<Harness> StartAsync()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(Now);
        var api = new ApiFactory(cs, new Dictionary<string, string?> { ["Processing:BackfillPause"] = "00:00:00" }, clock);
        return new Harness(api, cs, clock);
    }

    /// <summary>A stay, a drive, a stay and a walk on 2026-10-22 (Oslo), as stored; returns the ids of the drive and the walk.</summary>
    private static async Task<(long Drive, long Walk)> SeedDayAsync(string cs)
    {
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 8), D(10, 22), D(10, 22));
        var drive = await InsertSegmentAsync(cs, "move", Utc(10, 22, 8), Utc(10, 22, 8, 30), D(10, 22), D(10, 22), mode: "drive",
            distance: 9_000, geometry: "[[10.75,59.92],[10.85,59.95]]");
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 8, 30), Utc(10, 22, 17), D(10, 22), D(10, 22));
        var walk = await InsertSegmentAsync(cs, "move", Utc(10, 22, 17), Utc(10, 22, 17, 20), D(10, 22), D(10, 22), mode: "walk",
            distance: 1_500, geometry: "[[10.85,59.95],[10.86,59.95]]");
        return (drive, walk);
    }

    private static DateTime Utc(int month, int day, int hour, int minute = 0) => new(2026, month, day, hour, minute, 0, DateTimeKind.Utc);

    [Fact]
    public async Task Setting_a_mode_changes_the_stored_move_at_once_and_asks_for_its_stretch_to_be_rebuilt()
    {
        await using var h = await StartAsync();
        var (drive, walk) = await SeedDayAsync(h.Cs);

        using var response = await PutModeAsync(h.Client, drive, """{"mode":"train"}""");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using (var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct)))
        {
            Assert.Equal(drive, body.RootElement.GetProperty("id").GetInt64());
            Assert.Equal("train", body.RootElement.GetProperty("mode").GetString());
            Assert.True(body.RootElement.GetProperty("modeEdited").GetBoolean());
            Assert.Equal(3, body.RootElement.EnumerateObject().Count());
        }

        var moves = await MovesAsync(h.Cs);
        Assert.Equal(("train", true), (moves[0].Mode, moves[0].ModeEdited));
        Assert.Equal(("walk", false), (moves[1].Mode, moves[1].ModeEdited));
        Assert.Equal([new EditRow(Utc(10, 22, 8), Utc(10, 22, 8, 30), "train")], await EditsAsync(h.Cs));
        var dirty = Assert.Single(await DirtyAsync(h.Cs));
        Assert.Equal((Utc(10, 22, 8), Utc(10, 22, 8, 30)), (dirty.FromUtc, dirty.ToUtc));
        Assert.Equal(Now.UtcDateTime - TimeSpan.FromMinutes(1), dirty.CreatedAt); // due at once: recorded a debounce ago

        using var day = await DayAsync(h.Client, "2026-10-22");
        var segments = day.RootElement.GetProperty("segments");
        Assert.Equal("pending", day.RootElement.GetProperty("state").GetString());
        Assert.Equal(("train", true), (segments[1].GetProperty("mode").GetString(), segments[1].GetProperty("modeEdited").GetBoolean()));
        Assert.Equal(("walk", false), (segments[3].GetProperty("mode").GetString(), segments[3].GetProperty("modeEdited").GetBoolean()));
        Assert.False(segments[0].TryGetProperty("modeEdited", out _)); // a stay has no mode
        Assert.Equal(walk, segments[3].GetProperty("id").GetInt64());
    }

    [Theory]
    [InlineData("walk")]
    [InlineData("cycle")]
    [InlineData("drive")]
    [InlineData("bus")]
    [InlineData("train")]
    [InlineData("flight")]
    public async Task Each_of_the_six_modes_can_be_set(string mode)
    {
        await using var h = await StartAsync();
        var (drive, _) = await SeedDayAsync(h.Cs);

        using var response = await PutModeAsync(h.Client, drive, $$"""{"mode":"{{mode}}"}""");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal((mode, true), ((await MovesAsync(h.Cs))[0].Mode, (await MovesAsync(h.Cs))[0].ModeEdited));
    }

    [Fact]
    public async Task A_new_mode_replaces_the_edits_that_overlapped_the_move_and_no_other()
    {
        await using var h = await StartAsync();
        var (drive, walk) = await SeedDayAsync(h.Cs);
        await Sql.ExecAsync(h.Cs,
            """
            insert into mode_edit (from_utc, to_utc, mode) values
              ('2026-10-22T07:00:00Z', '2026-10-22T08:10:00Z', 'walk'),   -- overlaps the drive's start
              ('2026-10-22T08:30:00Z', '2026-10-22T09:00:00Z', 'cycle'),  -- only touches its end
              ('2026-10-22T17:00:00Z', '2026-10-22T17:20:00Z', 'train')   -- the walk's
            """, ct: Ct);

        using (var first = await PutModeAsync(h.Client, drive, """{"mode":"train"}"""))
            Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        using (var second = await PutModeAsync(h.Client, drive, """{"mode":"bus"}"""))
            Assert.Equal(HttpStatusCode.OK, second.StatusCode);

        Assert.Equal(
            [
                new EditRow(Utc(10, 22, 8), Utc(10, 22, 8, 30), "bus"),
                new EditRow(Utc(10, 22, 8, 30), Utc(10, 22, 9), "cycle"),
                new EditRow(Utc(10, 22, 17), Utc(10, 22, 17, 20), "train"),
            ],
            await EditsAsync(h.Cs));
        Assert.Equal("bus", (await MovesAsync(h.Cs))[0].Mode);
        Assert.Equal("walk", (await MovesAsync(h.Cs)).Single(m => m.Id == walk).Mode); // its own edit is no reason to change it
    }

    [Theory]
    [InlineData("""{"mode":"boat"}""")]
    [InlineData("""{"mode":"Train"}""")] // the names are lower case, exactly
    [InlineData("""{"mode":" train"}""")]
    [InlineData("""{"mode":""}""")]
    [InlineData("""{"mode":null}""")]
    [InlineData("""{"mode":5}""")]
    [InlineData("""{"mode":["train"]}""")]
    [InlineData("{}")]
    [InlineData("")]
    [InlineData("[]")]
    [InlineData("train")]
    public async Task A_mode_that_is_not_one_of_the_six_is_a_400(string body)
    {
        await using var h = await StartAsync();
        var (drive, _) = await SeedDayAsync(h.Cs);

        using var response = await PutModeAsync(h.Client, drive, body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("drive", (await MovesAsync(h.Cs))[0].Mode);
        Assert.Empty(await EditsAsync(h.Cs));
        Assert.Empty(await DirtyAsync(h.Cs));
    }

    [Fact]
    public async Task A_mode_in_the_query_is_no_mode()
    {
        await using var h = await StartAsync();
        var (drive, _) = await SeedDayAsync(h.Cs);

        using var response = await h.Client.PutAsync($"/api/moves/{drive}/mode?mode=train", new StringContent("{}", Encoding.UTF8, "application/json"), Ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(await EditsAsync(h.Cs));
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-3")]
    [InlineData("abc")]
    [InlineData("1.5")]
    [InlineData("99999999999999999999")]
    public async Task An_id_that_is_not_a_positive_whole_number_is_a_400(string id)
    {
        await using var h = await StartAsync();
        await SeedDayAsync(h.Cs);

        using var put = await PutModeAsync(h.Client, id, """{"mode":"train"}""");
        using var delete = await h.Client.DeleteAsync($"/api/moves/{id}/mode", Ct);

        Assert.Equal(HttpStatusCode.BadRequest, put.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, delete.StatusCode);
        Assert.Empty(await EditsAsync(h.Cs));
    }

    [Fact]
    public async Task A_move_that_is_not_stored_is_a_404()
    {
        await using var h = await StartAsync();
        var (drive, _) = await SeedDayAsync(h.Cs);
        var stay = await Sql.ScalarAsync<long>(h.Cs, "select min(id) from segment where kind = 'stay'", ct: Ct);

        foreach (var id in new[] { drive + 1000, stay }) // no segment, and a stay
        {
            using var put = await PutModeAsync(h.Client, id, """{"mode":"train"}""");
            using var delete = await h.Client.DeleteAsync($"/api/moves/{id}/mode", Ct);
            Assert.Equal(HttpStatusCode.NotFound, put.StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, delete.StatusCode);
        }

        Assert.Empty(await EditsAsync(h.Cs));
        Assert.Empty(await DirtyAsync(h.Cs));
    }

    [Fact]
    public async Task Setting_a_mode_must_be_sent_as_json()
    {
        await using var h = await StartAsync();
        var (drive, _) = await SeedDayAsync(h.Cs);

        using var response = await h.Client.PutAsync($"/api/moves/{drive}/mode",
            new FormUrlEncodedContent([new KeyValuePair<string, string>("mode", "train")]), Ct);

        Assert.Equal(HttpStatusCode.UnsupportedMediaType, response.StatusCode);
        Assert.Empty(await EditsAsync(h.Cs));
    }

    [Fact]
    public async Task Taking_a_mode_back_deletes_the_edits_over_the_move_and_asks_for_its_stretch()
    {
        await using var h = await StartAsync();
        var (drive, _) = await SeedDayAsync(h.Cs);
        await Sql.ExecAsync(h.Cs,
            """
            insert into mode_edit (from_utc, to_utc, mode) values
              ('2026-10-22T07:00:00Z', '2026-10-22T08:10:00Z', 'walk'),
              ('2026-10-22T08:10:00Z', '2026-10-22T08:30:00Z', 'train'),
              ('2026-10-22T17:00:00Z', '2026-10-22T17:20:00Z', 'train')
            """, ct: Ct);

        using var response = await h.Client.DeleteAsync($"/api/moves/{drive}/mode", Ct);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal([new EditRow(Utc(10, 22, 17), Utc(10, 22, 17, 20), "train")], await EditsAsync(h.Cs));
        var dirty = Assert.Single(await DirtyAsync(h.Cs));
        Assert.Equal((Utc(10, 22, 8), Utc(10, 22, 8, 30), Now.UtcDateTime - TimeSpan.FromMinutes(1)), (dirty.FromUtc, dirty.ToUtc, dirty.CreatedAt));

        // Nothing to take back is no error.
        using var again = await h.Client.DeleteAsync($"/api/moves/{drive}/mode", Ct);
        Assert.Equal(HttpStatusCode.NoContent, again.StatusCode);
    }

    [Fact]
    public async Task The_owners_mode_survives_rebuilds_and_taking_it_back_brings_the_detected_one_back()
    {
        await using var h = await StartAsync();
        await PointSeeder.InsertAsync(h.Cs, CommuteDay(), Ct);
        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);
        await h.SettleVersionAsync();
        var walk = (await MovesAsync(h.Cs))[0];
        Assert.Equal(("walk", false), (walk.Mode, walk.ModeEdited));

        using (var put = await PutModeAsync(h.Client, walk.Id, """{"mode":"bus"}"""))
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        await h.DrainAsync(); // the stretch is rebuilt, with the edit put over what is detected

        var rebuilt = await MovesAsync(h.Cs);
        Assert.NotEqual(walk.Id, rebuilt[0].Id); // ids change on every rebuild
        Assert.Equal((walk.StartUtc, walk.EndUtc, "bus", true), (rebuilt[0].StartUtc, rebuilt[0].EndUtc, rebuilt[0].Mode, rebuilt[0].ModeEdited));
        Assert.Equal(("cycle", false), (rebuilt[1].Mode, rebuilt[1].ModeEdited));

        // Any later rebuild of the day keeps it.
        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);
        Assert.Equal(("bus", true), ((await MovesAsync(h.Cs))[0].Mode, (await MovesAsync(h.Cs))[0].ModeEdited));
        using (var day = await DayAsync(h.Client, "2026-10-23"))
        {
            var move = day.RootElement.GetProperty("segments")[1];
            Assert.Equal(("bus", true), (move.GetProperty("mode").GetString(), move.GetProperty("modeEdited").GetBoolean()));
        }

        // Taken back by the id the day gives now: the detected mode is back once the stretch is rebuilt.
        var id = (await MovesAsync(h.Cs))[0].Id;
        using (var delete = await h.Client.DeleteAsync($"/api/moves/{id}/mode", Ct))
            Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);
        Assert.Equal(("bus", true), ((await MovesAsync(h.Cs))[0].Mode, (await MovesAsync(h.Cs))[0].ModeEdited)); // until then, as it was
        await h.DrainAsync();
        Assert.Equal(("walk", false), ((await MovesAsync(h.Cs))[0].Mode, (await MovesAsync(h.Cs))[0].ModeEdited));
    }

    [Fact]
    public async Task The_owners_mode_survives_a_rebuild_of_the_whole_timeline()
    {
        await using var h = await StartAsync();
        await PointSeeder.InsertAsync(h.Cs, CommuteDay(), Ct);
        await h.DrainAsync(); // the first backfill
        var cycle = (await MovesAsync(h.Cs))[1];
        Assert.Equal("cycle", cycle.Mode);
        using (var put = await PutModeAsync(h.Client, cycle.Id, """{"mode":"train"}"""))
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);

        // A new algorithm version: every segment is deleted and the history is backfilled again.
        await Sql.ExecAsync(h.Cs, "update processing_state set algorithm_version = 'an older one'", ct: Ct);
        await h.DrainAsync();

        Assert.NotEqual("an older one", await Sql.ScalarAsync<string>(h.Cs, "select algorithm_version from processing_state", ct: Ct));
        var moves = await MovesAsync(h.Cs);
        Assert.Equal([("walk", false), ("train", true)], moves.Select(m => (m.Mode, m.ModeEdited)));
        Assert.Equal((cycle.StartUtc, cycle.EndUtc), (moves[1].StartUtc, moves[1].EndUtc));
        Assert.Single(await EditsAsync(h.Cs));
    }

    [Fact]
    public async Task A_move_set_to_flight_is_drawn_as_an_arc_and_one_set_back_along_its_path()
    {
        await using var h = await StartAsync();
        await PointSeeder.InsertAsync(h.Cs, CommuteDay(), Ct);
        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);
        await h.SettleVersionAsync();
        var walk = (await MovesAsync(h.Cs))[0];

        using (var put = await PutModeAsync(h.Client, walk.Id, """{"mode":"flight"}"""))
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        await h.DrainAsync();

        var flight = (await MovesAsync(h.Cs))[0];
        Assert.Equal("flight", flight.Mode);
        var arc = JsonSerializer.Deserialize<double[][]>(flight.GeometryDetail!)!;
        Assert.Equal(MoveGeometry.ArcPoints, arc.Length);
        Assert.NotEqual(walk.GeometryDetail, flight.GeometryDetail);
        var crowFlies = Geo.DistanceMeters(new GeoPoint(arc[0][1], arc[0][0]), new GeoPoint(arc[^1][1], arc[^1][0]));
        Assert.InRange(flight.DistanceM!.Value, crowFlies - 1, crowFlies + 1); // from take-off to landing (the arc's ends are rounded to 0.1 m)

        using (var put = await PutModeAsync(h.Client, flight.Id, """{"mode":"walk"}"""))
            Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        await h.DrainAsync();

        var back = (await MovesAsync(h.Cs))[0];
        Assert.Equal(("walk", true, walk.DistanceM, walk.GeometryDetail), (back.Mode, back.ModeEdited, back.DistanceM, back.GeometryDetail));
    }

    // --- Which edit a move takes ----------------------------------------------------------------------------------

    private static ModeEdit Edit(int fromMinute, int toMinute, TravelMode mode) => new(T(8, fromMinute), T(8, toMinute), mode);

    [Fact]
    public void A_move_takes_the_mode_of_an_edit_that_covers_more_than_half_of_it()
    {
        // The move is 08:00 to 08:20.
        Assert.Equal(TravelMode.Train, ModeEditStore.Find([Edit(0, 20, TravelMode.Train)], T(8), T(8, 20)));
        Assert.Equal(TravelMode.Train, ModeEditStore.Find([Edit(-30, 11, TravelMode.Train)], T(8), T(8, 20)));
        Assert.Null(ModeEditStore.Find([Edit(-30, 10, TravelMode.Train)], T(8), T(8, 20))); // half is not more than half
        Assert.Null(ModeEditStore.Find([Edit(20, 40, TravelMode.Train)], T(8), T(8, 20))); // touching is not covering
        Assert.Null(ModeEditStore.Find([], T(8), T(8, 20)));
    }

    [Fact]
    public void Of_several_edits_the_one_that_covers_most_of_the_move_wins()
    {
        Assert.Equal(TravelMode.Bus,
            ModeEditStore.Find([Edit(0, 4, TravelMode.Train), Edit(4, 20, TravelMode.Bus)], T(8), T(8, 20)));
        Assert.Equal(TravelMode.Bus, // a train over a third and a bus over two thirds of a longer span: the bus covers most of it
            ModeEditStore.Find([Edit(-60, 7, TravelMode.Train), Edit(7, 60, TravelMode.Bus)], T(8), T(8, 20)));
        Assert.Null( // neither covers more than half
            ModeEditStore.Find([Edit(0, 10, TravelMode.Train), Edit(10, 20, TravelMode.Bus)], T(8), T(8, 20)));
    }

    [Fact]
    public void Mode_names_are_the_six_in_lower_case()
    {
        Assert.Equal(["walk", "cycle", "drive", "bus", "train", "flight"], TravelModeNames.All);
        foreach (var mode in Enum.GetValues<TravelMode>())
        {
            Assert.True(TravelModeNames.TryParse(TravelModeNames.Name(mode), out var parsed));
            Assert.Equal(mode, parsed);
        }
        Assert.Equal(Enum.GetValues<TravelMode>().Length, TravelModeNames.All.Count);
        Assert.False(TravelModeNames.TryParse("Walk", out _));
        Assert.False(TravelModeNames.TryParse(null, out _));
    }
}
