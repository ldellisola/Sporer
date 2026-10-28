using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Npgsql;
using Sporer.Api.Features.Timeline;
using Sporer.Testing;
using Sporer.Timeline;
using static Sporer.Api.Tests.TripSeeder;

namespace Sporer.Api.Tests;

/// <summary>
/// What the owner does to places: naming one (<c>PUT /api/places/{id}/name</c>). A name is the owner's own and is shown in place of
/// OpenStreetMap's wherever the place is, so it is set on the one row of the place that survives merges and is read from there.
/// </summary>
[Collection("db")]
public class RenameMergeTests(DatabaseFixture db)
{
    private const string Lisbon = "Europe/Lisbon";

    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Every2min = TimeSpan.FromMinutes(2);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Task<HttpResponseMessage> RenameAsync(HttpClient client, object id, string? name) =>
        client.PutAsJsonAsync($"/api/places/{id}/name", new { name }, Ct);

    private static async Task<JsonDocument> JsonOf(HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{response.RequestMessage?.RequestUri} gave {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text);
    }

    private static async Task<JsonDocument> GetAsync(HttpClient client, string url) => await JsonOf(await client.GetAsync(url, Ct));

    private static Task<string?> UserNameAsync(string cs, long place) =>
        Sql.ScalarAsync<string?>(cs, "select user_name from place where id = @place", new { place }, Ct);

    /// <summary>A place that is on the timeline (one stay at it), so that it can be asked for.</summary>
    private static async Task<long> OnTheTimelineAsync(
        string cs, string? userName = null, string? osmName = null, long? mergedInto = null, int day = 22)
    {
        var place = await TimelineSeeder.InsertPlaceAsync(cs, userName: userName, osmName: osmName, mergedInto: mergedInto);
        await TimelineSeeder.InsertSegmentAsync(
            cs, "stay", Utc(10, day, 6), Utc(10, day, 7), D(10, day), D(10, day), placeId: place);
        return place;
    }

    // ---- the name is shown wherever the place is ---------------------------------------------------------------------

    [Fact]
    public async Task Rename_sets_the_name_everywhere()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // starting the host runs the migrations
        var hotel = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal", osmName: "Hotel Avenida");
        var market = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 500, 500), "Lisbon", "Portugal", osmName: "Mercado da Ribeira");
        await StoreAsync(api,
            [Stay(D(9, 12), hotel, Spots.Lisbon), Stay(D(9, 13), hotel, Spots.Lisbon)], [],
            Trip(D(9, 12), D(9, 13), Utc(9, 12, 8), Utc(9, 14, 10)));
        await StayAsync(cs, hotel, Utc(9, 12, 13), Utc(9, 13, 8));
        await StayAsync(cs, market, Utc(9, 13, 8, 20), Utc(9, 13, 10, 20));
        await StayAsync(cs, hotel, Utc(9, 13, 12), Utc(9, 14, 7));

        // The name of the market as each of the views gives it: its place, the day, a range with the day in it, and the line of the
        // trip's day where it is a highlight (the hotel is where the nights were spent, so it is not one).
        async Task<string?[]> NamesAsync()
        {
            using var place = await GetAsync(client, $"/api/places/{market}");
            using var day = await GetAsync(client, "/api/day/2026-09-13");
            using var range = await GetAsync(client, "/api/range?from=2026-09-13&to=2026-09-13");
            using var trip = await GetAsync(client, "/api/trips/2026-09-12");

            var onTheDay = day.RootElement.GetProperty("segments").EnumerateArray()
                .Where(s => s.GetProperty("kind").GetString() == "stay" && s.GetProperty("place").GetProperty("id").GetInt64() == market)
                .Select(s => s.GetProperty("place").GetProperty("name").GetString())
                .Single();
            var inTheRange = range.RootElement.GetProperty("places").EnumerateArray()
                .Where(p => p.GetProperty("id").GetInt64() == market)
                .Select(p => p.GetProperty("name").GetString())
                .Single();
            var highlights = trip.RootElement.GetProperty("days")[1].GetProperty("highlights").EnumerateArray().Select(h => h.GetString()).Single();
            return [place.RootElement.GetProperty("name").GetString(), onTheDay, inTheRange, highlights];
        }

        Assert.All(await NamesAsync(), name => Assert.Equal("Mercado da Ribeira", name));

        using var renamed = await JsonOf(await RenameAsync(client, market, "Time Out Market"));

        Assert.Equal("Time Out Market", renamed.RootElement.GetProperty("name").GetString());
        Assert.All(await NamesAsync(), name => Assert.Equal("Time Out Market", name));
        Assert.Equal("Time Out Market", await UserNameAsync(cs, market));
    }

    [Fact]
    public async Task Rename_answers_with_the_place_detail()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await TimelineSeeder.InsertPlaceAsync(cs, osmName: "OpenStreetMap's name", address: "1 Main St", city: "Oslo", country: "Norway", lat: 59.5, lon: 10.5);
        await TimelineSeeder.InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 8), D(10, 22), D(10, 22), placeId: place);
        await TimelineSeeder.InsertSegmentAsync(cs, "stay", Utc(10, 25, 10), Utc(10, 25, 11), D(10, 25), D(10, 25), placeId: place);

        using var renamed = await JsonOf(await RenameAsync(client, place, "Mine"));

        // Exactly what GET /api/places/{id} says, the new name in it.
        using var read = await GetAsync(client, $"/api/places/{place}");
        Assert.Equal(read.RootElement.GetRawText(), renamed.RootElement.GetRawText());
        Assert.Equal("Mine", read.RootElement.GetProperty("name").GetString());
        Assert.Equal(3 * 3600, read.RootElement.GetProperty("totalSeconds").GetInt64());
        Assert.Equal(2, read.RootElement.GetProperty("visits").GetInt32());
    }

    [Fact]
    public async Task Rename_of_a_merged_id_names_the_survivor()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // Merged in two steps, and each with a stay: the place that stands for them all is the survivor, whichever id is used.
        var survivor = await OnTheTimelineAsync(cs, userName: "Survivor's old name", osmName: "Survivor OSM", day: 22);
        var middle = await OnTheTimelineAsync(cs, userName: "Middle", mergedInto: survivor, day: 23);
        var absorbed = await OnTheTimelineAsync(cs, userName: "Absorbed", mergedInto: middle, day: 24);

        using var renamed = await JsonOf(await RenameAsync(client, absorbed, "New name"));

        Assert.Equal(survivor, renamed.RootElement.GetProperty("id").GetInt64());
        Assert.Equal("New name", renamed.RootElement.GetProperty("name").GetString());
        Assert.Equal(3, renamed.RootElement.GetProperty("visits").GetInt32()); // the survivor's, with the stays of those merged into it
        Assert.Equal("New name", await UserNameAsync(cs, survivor));
        Assert.Equal("Middle", await UserNameAsync(cs, middle)); // the names of the others are left as they are
        Assert.Equal("Absorbed", await UserNameAsync(cs, absorbed));
        foreach (var id in new[] { survivor, middle, absorbed })
        {
            using var read = await GetAsync(client, $"/api/places/{id}");
            Assert.Equal("New name", read.RootElement.GetProperty("name").GetString());
        }
    }

    [Fact]
    public async Task Rename_while_a_merge_lands_names_the_survivor()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        _ = api.Services; // starting the host runs the migrations
        var survivor = await OnTheTimelineAsync(cs, osmName: "Survivor OSM", day: 22);
        var merging = await OnTheTimelineAsync(cs, userName: "Merging", day: 23);
        var places = api.Services.GetRequiredService<PlaceStore>();

        // A merge of the place that is not committed yet: the rename does not see it, finds the place to be a survivor, and waits for
        // the row that it is about to name. When the merge commits, the place is no longer one, and the name must not stay on it.
        await using var merger = new NpgsqlConnection(cs);
        await merger.OpenAsync(Ct);
        await using var merge = await merger.BeginTransactionAsync(Ct);
        await using (var command = new NpgsqlCommand("update place set merged_into_id = @survivor where id = @merging", merger, merge))
        {
            command.Parameters.AddWithValue("survivor", survivor);
            command.Parameters.AddWithValue("merging", merging);
            await command.ExecuteNonQueryAsync(Ct);
        }

        var rename = places.RenameAsync(merging, "New name", Ct);
        var until = DateTime.UtcNow.AddSeconds(20);
        while (await Sql.ScalarAsync<long>(cs,
                   "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'", ct: Ct) == 0)
        {
            Assert.False(rename.IsCompleted, "the rename did not wait for the merge");
            Assert.True(DateTime.UtcNow < until, "timed out waiting for the rename to wait for the row");
            await Task.Delay(20, Ct);
        }
        await merge.CommitAsync(Ct);

        var named = await rename;

        Assert.NotNull(named);
        Assert.Equal(survivor, named.Id);
        Assert.Equal("New name", named.Name);
        Assert.Equal("New name", await UserNameAsync(cs, survivor));
        Assert.Equal("Merging", await UserNameAsync(cs, merging)); // the place that was merged is as it was
    }

    // ---- the name's own rules ----------------------------------------------------------------------------------------

    [Fact]
    public async Task Rename_empty_resets_to_the_osm_name()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs, osmName: "OpenStreetMap's name");

        // Nothing, an empty name and one of spaces all mean "back to the automatic name".
        foreach (var reset in new string?[] { null, "", "   ", " \t " })
        {
            await RenameAsync(client, place, "Mine");
            Assert.Equal("Mine", await UserNameAsync(cs, place));

            using var renamed = await JsonOf(await RenameAsync(client, place, reset));

            Assert.Equal("OpenStreetMap's name", renamed.RootElement.GetProperty("name").GetString());
            Assert.Null(await UserNameAsync(cs, place));
        }

        // A place OpenStreetMap has not named is left with no name at all.
        var unnamed = await OnTheTimelineAsync(cs, userName: "Mine", day: 23);
        using var none = await JsonOf(await RenameAsync(client, unnamed, ""));
        Assert.Equal(JsonValueKind.Null, none.RootElement.GetProperty("name").ValueKind);
        Assert.Null(await UserNameAsync(cs, unnamed));
    }

    [Fact]
    public async Task Rename_trims_the_name_and_allows_exactly_100_characters()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs);

        using var trimmed = await JsonOf(await RenameAsync(client, place, "  \tTime Out Market \n"));
        Assert.Equal("Time Out Market", trimmed.RootElement.GetProperty("name").GetString());
        Assert.Equal("Time Out Market", await UserNameAsync(cs, place));

        // The length is that of the name as it is kept: the spaces around it do not count.
        var longest = new string('x', 100);
        using var accepted = await JsonOf(await RenameAsync(client, place, $"  {longest}  "));
        Assert.Equal(longest, accepted.RootElement.GetProperty("name").GetString());
        Assert.Equal(longest, await UserNameAsync(cs, place));
    }

    [Fact]
    public async Task Rename_too_long_is_400()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs, userName: "Mine");

        using var response = await RenameAsync(client, place, new string('x', 101));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("Mine", await UserNameAsync(cs, place)); // not shortened, not set
    }

    [Fact]
    public async Task Rename_with_a_body_that_is_not_a_name_is_400()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs, userName: "Mine");

        foreach (var body in new[] { """{"name":5}""", """{"name":["a"]}""", "not json", "[" })
        {
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            using var response = await client.PutAsync($"/api/places/{place}/name", content, Ct);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"{body} gave {(int)response.StatusCode}");
        }

        Assert.Equal("Mine", await UserNameAsync(cs, place));
    }

    [Fact]
    public async Task Rename_without_a_name_is_400()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs, userName: "Mine");

        // Taking the name back is asked for with "name": null. A body that says nothing of it is no such request.
        var bodies = new (string What, string Body)[]
        {
            ("an empty object", "{}"), ("an empty body", ""), ("another property", """{"nom":"x"}"""), ("an array", "[]"),
        };
        foreach (var (what, body) in bodies)
        {
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            using var response = await client.PutAsync($"/api/places/{place}/name", content, Ct);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"{what} gave {(int)response.StatusCode}");
        }

        Assert.Equal("Mine", await UserNameAsync(cs, place));

        using var reset = await client.PutAsync(
            $"/api/places/{place}/name", new StringContent("""{"name":null}""", Encoding.UTF8, "application/json"), Ct);
        Assert.Equal(HttpStatusCode.OK, reset.StatusCode);
        Assert.Null(await UserNameAsync(cs, place));
    }

    [Fact]
    public async Task Rename_does_not_take_the_name_from_the_query()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs, osmName: "OpenStreetMap's name");

        // The body says "no name"; a query that says another is no part of the request.
        using var response = await client.PutAsJsonAsync($"/api/places/{place}/name?name=Hacked", new { name = (string?)null }, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Null(await UserNameAsync(cs, place));
    }

    // ---- which place -------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Rename_unknown_is_404()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await OnTheTimelineAsync(cs);
        // A place that exists, but is on no day: no segment shows it, as with the place's own view.
        var orphan = await TimelineSeeder.InsertPlaceAsync(cs, osmName: "Left behind");

        using var unknown = await RenameAsync(client, 999_999, "Mine");
        using var notOnTheTimeline = await RenameAsync(client, orphan, "Mine");

        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, notOnTheTimeline.StatusCode);
        Assert.Null(await UserNameAsync(cs, orphan));
    }

    [Fact]
    public async Task Rename_rejects_an_id_that_is_not_a_positive_whole_number()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs);

        foreach (var id in new[] { "abc", "0", "-1", "1.5", "+1", "%201", "1%20", "1e3", "99999999999999999999" })
        {
            using var response = await client.PutAsJsonAsync($"/api/places/{id}/name", new { name = "Mine" }, Ct);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"/api/places/{id}/name gave {(int)response.StatusCode}");
        }

        Assert.Null(await UserNameAsync(cs, place));
    }

    // ---- the name outlasts the timeline ------------------------------------------------------------------------------

    private static readonly DateTime Day = new(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc);

    /// <summary>Home 1 h -> walk to the cafe -> cafe 25 min -> cycle to the office -> office 8 h, starting 07:00 UTC on a day of October.</summary>
    private static List<TrackPoint> CommuteDay(int day) => new TrackBuilder(Day.AddDays(day).AddHours(7), Spots.Home)
        .Stay(TimeSpan.FromHours(1), Every2min)
        .Travel(Spots.Cafe, 5, Every10s)
        .Stay(TimeSpan.FromMinutes(25), Every2min)
        .Travel(Spots.Office, 18, Every10s)
        .Stay(TimeSpan.FromHours(8), Every2min)
        .Build();

    /// <summary>Runs passes of the worker until one finds nothing to do: the backfill is finished.</summary>
    private static async Task FinishBackfillAsync(ApiFactory api)
    {
        var worker = api.Services.GetRequiredService<TimelineWorker>();
        for (var pass = 0; await worker.RunOnceAsync(Ct); pass++)
            Assert.True(pass < 100, "the worker keeps finding work");
    }

    [Fact]
    public async Task Rename_survives_a_rebuild()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(Day.AddDays(22)));

        long office;
        string firstVersion;
        await using (var first = new ApiFactory(cs, time: clock))
        {
            var client = first.CreateClient(); // starting the host runs the migrations
            await PointSeeder.InsertAsync(cs, Enumerable.Range(0, 3).SelectMany(CommuteDay), Ct);
            await FinishBackfillAsync(first);
            office = await Sql.ScalarAsync<long>(cs, "select place_id from segment where kind = 'stay' order by start_utc desc limit 1", ct: Ct);
            firstVersion = (await Sql.ScalarAsync<string>(cs, "select algorithm_version from processing_state where id = 1", ct: Ct))!;

            using var renamed = await JsonOf(await RenameAsync(client, office, "My office"));
            Assert.Equal("My office", renamed.RootElement.GetProperty("name").GetString());
        }
        var places = await Sql.ScalarAsync<long>(cs, "select count(*) from place", ct: Ct);
        Assert.Equal(3, places);

        // Another algorithm version: the segments, nights and trips are cleared and the timeline is built again from the points.
        clock.Advance(TimeSpan.FromHours(1));
        await using var second = new ApiFactory(cs, new Dictionary<string, string?> { ["Detection:StayRadiusMeters"] = "150" }, clock);
        var client2 = second.CreateClient();
        await FinishBackfillAsync(second);

        Assert.NotEqual(firstVersion, await Sql.ScalarAsync<string>(cs, "select algorithm_version from processing_state where id = 1", ct: Ct));
        Assert.Equal(3, await Sql.ScalarAsync<long>(cs, "select count(distinct place_id) from segment where kind = 'stay'", ct: Ct)); // it was rebuilt
        Assert.Equal(places, await Sql.ScalarAsync<long>(cs, "select count(*) from place", ct: Ct));
        Assert.Equal("My office", await UserNameAsync(cs, office));
        using var place = await GetAsync(client2, $"/api/places/{office}");
        Assert.Equal("My office", place.RootElement.GetProperty("name").GetString());
        using var day = await GetAsync(client2, "/api/day/2026-10-01");
        var names = day.RootElement.GetProperty("segments").EnumerateArray()
            .Where(s => s.GetProperty("kind").GetString() == "stay")
            .Select(s => s.GetProperty("place").GetProperty("name").GetString());
        Assert.Equal([null, null, "My office"], names);
    }

    /// <summary>A stay at <paramref name="place"/>, with the local dates of its start and end in Lisbon.</summary>
    private static Task<long> StayAsync(string cs, long place, DateTime start, DateTime end) =>
        TimelineSeeder.InsertSegmentAsync(
            cs, "stay", start, end, LocalTime.LocalDate(start, Lisbon), LocalTime.LocalDate(end, Lisbon), Lisbon, placeId: place);
}
