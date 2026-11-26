using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Time.Testing;
using Sporer.Api.Configuration;
using Sporer.Api.Database;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Transit;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// The background fetcher of railway and bus-route tiles (transit spec section 3): one tile at a time, the most recent travels first, at least
/// the interval apart, backing a failing tile off and pausing every request after a failure, setting a tile aside after five, and asking
/// for the stretch that waited for a tile to be rebuilt once it is in. The requests go to a <see cref="FakeOverpass"/>.
/// </summary>
[Collection("db")]
public class TransitFetcherTests(DatabaseFixture db)
{
    private const string UserAgent = "SporerTests/1.0 (tests@example.invalid)";
    private const string DisabledWarning = "Railway and bus lines are not fetched: set Transit:UserAgent or Nominatim:UserAgent";

    private static readonly DateTimeOffset Start = new(2026, 11, 26, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(10);

    private static readonly TransitTile Oslo = new(TransitKind.Rail, 599, 107);
    private static readonly TransitTile Lisbon = new(TransitKind.Rail, 387, -92);
    private static readonly TransitTile Tokyo = new(TransitKind.Rail, 355, 1397);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime Utc(int month, int day, int hour = 0) => new(2026, month, day, hour, 0, 0, DateTimeKind.Utc);

    private sealed class Harness(ApiFactory api, string cs, FakeOverpass overpass, FakeTimeProvider clock) : IAsyncDisposable
    {
        public ApiFactory Api { get; } = api;
        public string Cs { get; } = cs;
        public FakeOverpass Overpass { get; } = overpass;
        public FakeTimeProvider Clock { get; } = clock;
        public TransitFetcher Fetcher { get; } = api.Services.GetRequiredService<TransitFetcher>(); // starting the host runs the migrations
        public ProcessingQueue Queue => Api.Services.GetRequiredService<ProcessingQueue>();

        public async Task<TransitSeeder.TileRow> TileAsync(TransitTile tile)
            => (await TransitSeeder.TilesAsync(Cs)).Single(t => t.Kind == TransitTileStore.KindName(tile.Kind) && t.LatIndex == tile.LatIndex && t.LonIndex == tile.LonIndex);

        public ValueTask DisposeAsync() => Api.DisposeAsync();
    }

    /// <summary>
    /// The real app on a fresh database, with fetching on (and a user agent) and Overpass faked. Background work is off unless
    /// <paramref name="settings"/> turns it on.
    /// </summary>
    private async Task<Harness> StartAsync(IDictionary<string, string?>? settings = null, bool fakeClock = true)
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var overpass = new FakeOverpass();
        var clock = new FakeTimeProvider(Start);
        var all = new Dictionary<string, string?> { ["Transit:Enabled"] = "true", ["Transit:UserAgent"] = UserAgent };
        if (settings is not null)
            foreach (var (key, value) in settings)
                all[key] = value;

        var api = new ApiFactory(cs, all, fakeClock ? clock : null, services =>
            services.AddHttpClient<OverpassClient>().ConfigurePrimaryHttpMessageHandler(() => overpass));
        return new Harness(api, cs, overpass, clock);
    }

    private sealed record DirtyRow(DateTime FromUtc, DateTime ToUtc, DateTime CreatedAt);

    private static Task<IReadOnlyList<DirtyRow>> DirtyAsync(string cs) => Sql.QueryAsync<DirtyRow>(cs,
        "select from_utc as FromUtc, to_utc as ToUtc, created_at as CreatedAt from dirty_range order by from_utc", ct: Ct);

    private sealed record ReadyRow(DateTime? FromUtc, DateTime? ToUtc, DateTime? FlushedAt);

    /// <summary>The stretch waiting to be rebuilt for the tiles that have arrived, and the last time it was asked for.</summary>
    private static async Task<ReadyRow> ReadyAsync(string cs) => (await Sql.QueryAsync<ReadyRow>(cs,
        "select transit_ready_from as FromUtc, transit_ready_to as ToUtc, transit_flushed_at as FlushedAt from processing_state where id = 1",
        ct: Ct)).Single();

    [Fact]
    public async Task Fetches_a_waiting_tile_keeps_its_lines_and_asks_for_the_stretch_that_waited_for_it()
    {
        await using var h = await StartAsync();
        await TransitSeeder.WaitingAsync(h.Cs, Oslo, Utc(10, 3, 8), Utc(11, 20, 18));
        var line = TransitMap.Along(new GeoPoint(59.95, 10.71), new GeoPoint(59.95, 10.79));
        h.Overpass.ReplyLines(line, [new GeoPoint(59.91, 10.75)]);

        Assert.True(await h.Fetcher.RunOnceAsync(Ct));

        var request = Assert.Single(h.Overpass.Requests);
        Assert.Equal(("POST", TransitOptions.DefaultOverpassUrl, UserAgent), (request.Method, request.Uri.AbsoluteUri, request.UserAgent));
        Assert.Equal(OverpassClient.Query(Oslo), request.Query);

        var tile = await h.TileAsync(Oslo);
        Assert.Equal(("done", 2, 0, (string?)null), (tile.State, tile.LineCount, tile.Attempts, tile.LastError));
        Assert.Equal((Start.UtcDateTime, (DateTime?)null, (DateTime?)null), (tile.FetchedAt!.Value, tile.WaitingFrom, tile.WaitingTo));
        var stored = await TransitSeeder.LinesAsync(h.Cs, Oslo);
        Assert.NotNull(stored);
        Assert.Equal([line.Length, 1], stored.Select(l => l.Count));
        Assert.All(line.Zip(stored[0]), pair => Assert.True(Geo.DistanceMeters(pair.First, pair.Second) < 0.2));

        // The stretch waits to be rebuilt with the tiles that arrive soon after. None is due, so the worker's next pass asks for it, due at
        // once: recorded a debounce ago.
        Assert.Empty(await DirtyAsync(h.Cs));
        Assert.Equal(new ReadyRow(Utc(10, 3, 8), Utc(11, 20, 18), Start.UtcDateTime), await ReadyAsync(h.Cs));
        Assert.Equal((Utc(10, 3, 8), Utc(11, 20, 18)), await h.Queue.FlushTransitReadyAsync(Start.UtcDateTime, Ct));
        Assert.Equal([new DirtyRow(Utc(10, 3, 8), Utc(11, 20, 18), Start.UtcDateTime - TimeSpan.FromMinutes(1))], await DirtyAsync(h.Cs));
        Assert.Equal(new ReadyRow(null, null, Start.UtcDateTime), await ReadyAsync(h.Cs));

        // Fetched once: it is not asked for again.
        h.Clock.Advance(TimeSpan.FromDays(2));
        Assert.False(await h.Fetcher.RunOnceAsync(Ct));
        Assert.Equal(1, h.Overpass.Calls);
    }

    [Fact]
    public async Task A_tile_with_no_line_is_kept_as_one()
    {
        await using var h = await StartAsync();
        await TransitSeeder.WaitingAsync(h.Cs, Oslo, Utc(10, 3), Utc(10, 4));
        h.Overpass.ReplyLines();

        Assert.True(await h.Fetcher.RunOnceAsync(Ct));

        var tile = await h.TileAsync(Oslo);
        Assert.Equal(("done", 0), (tile.State, tile.LineCount));
        Assert.Empty((await TransitSeeder.LinesAsync(h.Cs, Oslo))!);
    }

    [Fact]
    public async Task The_tiles_of_the_most_recent_travels_come_first_railways_before_bus_routes()
    {
        await using var h = await StartAsync();
        await TransitSeeder.WaitingAsync(h.Cs, Lisbon, Utc(6, 1), Utc(6, 9));
        await TransitSeeder.WaitingAsync(h.Cs, Tokyo, Utc(9, 1), Utc(9, 20));
        await TransitSeeder.WaitingAsync(h.Cs, Oslo with { Kind = TransitKind.Bus }, Utc(1, 1), Utc(11, 25));
        await TransitSeeder.WaitingAsync(h.Cs, Oslo, Utc(11, 25), Utc(11, 25));

        for (var k = 0; k < 4; k++)
        {
            h.Overpass.ReplyLines();
            Assert.True(await h.Fetcher.RunOnceAsync(Ct));
            h.Clock.Advance(Interval);
        }

        Assert.Equal(
            [OverpassClient.Query(Oslo), OverpassClient.Query(Oslo with { Kind = TransitKind.Bus }), OverpassClient.Query(Tokyo), OverpassClient.Query(Lisbon)],
            h.Overpass.Requests.Select(r => r.Query));
        Assert.False(await h.Fetcher.RunOnceAsync(Ct));
    }

    [Fact]
    public async Task Requests_are_at_least_the_interval_apart()
    {
        await using var h = await StartAsync();
        await TransitSeeder.WaitingAsync(h.Cs, Oslo, Utc(10, 3), Utc(10, 4));
        await TransitSeeder.WaitingAsync(h.Cs, Lisbon, Utc(10, 1), Utc(10, 2));
        h.Overpass.ReplyLines();
        h.Overpass.ReplyLines();

        Assert.True(await h.Fetcher.RunOnceAsync(Ct));
        Assert.False(await h.Fetcher.RunOnceAsync(Ct));
        h.Clock.Advance(Interval - TimeSpan.FromMilliseconds(1));
        Assert.False(await h.Fetcher.RunOnceAsync(Ct));
        Assert.Equal(1, h.Overpass.Calls);

        h.Clock.Advance(TimeSpan.FromMilliseconds(1));
        Assert.True(await h.Fetcher.RunOnceAsync(Ct));
        Assert.Equal(2, h.Overpass.Calls);
    }

    [Fact]
    public async Task A_failure_backs_the_tile_off_and_pauses_every_request()
    {
        await using var h = await StartAsync();
        await TransitSeeder.WaitingAsync(h.Cs, Oslo, Utc(10, 3), Utc(10, 4));
        await TransitSeeder.WaitingAsync(h.Cs, Lisbon, Utc(10, 1), Utc(10, 2));

        // Oslo first, refused: it waits 2 minutes, and every request waits a minute.
        h.Overpass.Reply(HttpStatusCode.TooManyRequests, "slow down");
        Assert.True(await h.Fetcher.RunOnceAsync(Ct));
        var oslo = await h.TileAsync(Oslo);
        Assert.Equal(("pending", 1, Start.UtcDateTime + TimeSpan.FromMinutes(2)), (oslo.State, oslo.Attempts, oslo.NextAttemptAt!.Value));
        Assert.Contains("429", oslo.LastError);
        Assert.Equal((Utc(10, 3), Utc(10, 4)), (oslo.WaitingFrom!.Value, oslo.WaitingTo!.Value)); // still waiting for it
        Assert.Empty(await DirtyAsync(h.Cs));

        h.Clock.Advance(TimeSpan.FromSeconds(59));
        Assert.False(await h.Fetcher.RunOnceAsync(Ct)); // Lisbon is due, but everything is paused
        Assert.Equal(1, h.Overpass.Calls);

        // After the pause Lisbon is asked for, and fails too: the pause doubles.
        h.Clock.Advance(TimeSpan.FromSeconds(1));
        h.Overpass.Reply(HttpStatusCode.GatewayTimeout);
        Assert.True(await h.Fetcher.RunOnceAsync(Ct));
        Assert.Equal(("pending", 1), ((await h.TileAsync(Lisbon)).State, (await h.TileAsync(Lisbon)).Attempts));
        h.Clock.Advance(TimeSpan.FromMinutes(2) - TimeSpan.FromSeconds(1));
        Assert.False(await h.Fetcher.RunOnceAsync(Ct));

        // A success after the pause takes it back to the start: the next failure pauses for a minute again.
        h.Clock.Advance(TimeSpan.FromSeconds(1));
        h.Overpass.ReplyLines();
        Assert.True(await h.Fetcher.RunOnceAsync(Ct)); // Oslo, due again since 12:02
        Assert.Equal("done", (await h.TileAsync(Oslo)).State);
        h.Clock.Advance(TimeSpan.FromMinutes(2));
        h.Overpass.Throw(new HttpRequestException("connection refused"));
        Assert.True(await h.Fetcher.RunOnceAsync(Ct)); // Lisbon again, failing a second time
        var lisbon = await h.TileAsync(Lisbon);
        Assert.Equal((2, h.Clock.GetUtcNow().UtcDateTime + TimeSpan.FromMinutes(4)), (lisbon.Attempts, lisbon.NextAttemptAt!.Value));
        Assert.Contains("connection refused", lisbon.LastError);
        h.Clock.Advance(TimeSpan.FromMinutes(1));
        await TransitSeeder.WaitingAsync(h.Cs, Tokyo, Utc(10, 1), Utc(10, 2));
        h.Overpass.ReplyLines();
        Assert.True(await h.Fetcher.RunOnceAsync(Ct)); // a minute later, not two
        Assert.Equal("done", (await h.TileAsync(Tokyo)).State);
    }

    [Fact]
    public async Task A_tile_that_failed_five_times_is_set_aside_and_tried_once_a_day()
    {
        await using var h = await StartAsync();
        await TransitSeeder.WaitingAsync(h.Cs, Oslo, Utc(10, 3), Utc(10, 4), attempts: 4);
        h.Overpass.Reply(HttpStatusCode.InternalServerError);

        Assert.True(await h.Fetcher.RunOnceAsync(Ct));

        var tile = await h.TileAsync(Oslo);
        Assert.Equal(("failed", 5, Start.UtcDateTime + TimeSpan.FromDays(1)), (tile.State, tile.Attempts, tile.NextAttemptAt!.Value));
        Assert.Equal((Utc(10, 3), Utc(10, 4)), (tile.WaitingFrom!.Value, tile.WaitingTo!.Value));

        h.Clock.Advance(TimeSpan.FromDays(1) - TimeSpan.FromSeconds(1));
        Assert.False(await h.Fetcher.RunOnceAsync(Ct));
        h.Clock.Advance(TimeSpan.FromSeconds(1));
        h.Overpass.ReplyLines([new GeoPoint(59.95, 10.71), new GeoPoint(59.96, 10.72)]);
        Assert.True(await h.Fetcher.RunOnceAsync(Ct));

        tile = await h.TileAsync(Oslo);
        Assert.Equal(("done", 1, 0, (DateTime?)null), (tile.State, tile.LineCount, tile.Attempts, tile.NextAttemptAt));
        await h.Queue.FlushTransitReadyAsync(h.Clock.GetUtcNow().UtcDateTime, Ct);
        Assert.Equal([(Utc(10, 3), Utc(10, 4))], (await DirtyAsync(h.Cs)).Select(d => (d.FromUtc, d.ToUtc)));
    }

    [Fact]
    public async Task An_answer_that_cannot_be_used_is_a_failure_of_the_tile()
    {
        await using var h = await StartAsync();
        await TransitSeeder.WaitingAsync(h.Cs, Oslo, Utc(10, 3), Utc(10, 4));
        h.Overpass.ReplyJson("""{"elements":[],"remark":"runtime error: Query timed out in \"query\" at line 3 after 91 seconds."}""");

        Assert.True(await h.Fetcher.RunOnceAsync(Ct));

        var tile = await h.TileAsync(Oslo);
        Assert.Equal(("pending", 1), (tile.State, tile.Attempts));
        Assert.Contains("timed out", tile.LastError);
    }

    [Fact]
    public async Task Tiles_that_are_fetched_or_not_due_are_not_asked_for()
    {
        await using var h = await StartAsync();
        await TransitSeeder.StoreAsync(h.Cs, Oslo, []);
        await TransitSeeder.WaitingAsync(h.Cs, Lisbon, Utc(10, 1), Utc(10, 2), attempts: 2, nextAttemptAt: Start.UtcDateTime.AddMinutes(3));

        Assert.False(await h.Fetcher.RunOnceAsync(Ct));

        Assert.Equal(0, h.Overpass.Calls);
    }

    [Theory]
    [InlineData("false", UserAgent, "")] // switched off
    [InlineData("true", "", "")] // nobody to say who asks
    [InlineData("true", "   ", "")]
    public async Task Nothing_is_asked_for_when_fetching_is_off_or_has_no_user_agent(string enabled, string transitUserAgent, string nominatimUserAgent)
    {
        await using var h = await StartAsync(new Dictionary<string, string?>
        {
            ["Transit:Enabled"] = enabled, ["Transit:UserAgent"] = transitUserAgent, ["Nominatim:UserAgent"] = nominatimUserAgent,
        });
        await TransitSeeder.WaitingAsync(h.Cs, Oslo, Utc(10, 3), Utc(10, 4));

        Assert.False(await h.Fetcher.RunOnceAsync(Ct));

        Assert.Equal(0, h.Overpass.Calls);
        Assert.Equal("pending", (await h.TileAsync(Oslo)).State);
    }

    [Theory]
    [InlineData("true", "true", UserAgent, "", true, false)]
    [InlineData("true", "true", "", UserAgent, true, false)] // the naming user agent will do
    [InlineData("false", "true", UserAgent, "", false, false)] // processing off: nothing runs in the background
    [InlineData("true", "false", UserAgent, "", false, false)]
    [InlineData("true", "true", "", "", false, true)]
    [InlineData("true", "true", "   ", "  ", false, true)]
    [InlineData("false", "true", "", "", false, true)] // the warning does not depend on processing
    [InlineData("false", "false", "", "", false, false)]
    public async Task The_fetcher_runs_in_the_background_only_when_enabled_with_a_user_agent(
        string processing, string transit, string transitUserAgent, string nominatimUserAgent, bool hosted, bool warned)
    {
        await using var h = await StartAsync(new Dictionary<string, string?>
        {
            ["Processing:Enabled"] = processing, ["Transit:Enabled"] = transit,
            ["Transit:UserAgent"] = transitUserAgent, ["Nominatim:UserAgent"] = nominatimUserAgent,
        });

        Assert.Equal(hosted, h.Api.Services.GetServices<IHostedService>().Any(s => s is TransitFetcher));
        Assert.Equal(warned, h.Api.Services.GetRequiredService<DatabaseWarnings>().Items.Contains(DisabledWarning));
    }

    [Fact]
    public async Task The_background_loop_fetches_what_processing_asks_for()
    {
        await using var h = await StartAsync(new Dictionary<string, string?>
        {
            ["Processing:Enabled"] = "true", ["Transit:MinInterval"] = "00:00:01",
        }, fakeClock: false);
        h.Overpass.ReplyLines([new GeoPoint(59.95, 10.71), new GeoPoint(59.96, 10.72)]);

        await TransitSeeder.WaitingAsync(h.Cs, Oslo, Utc(10, 3), Utc(10, 4));

        var until = DateTime.UtcNow.AddSeconds(20);
        while ((await TransitSeeder.TilesAsync(h.Cs)).Single().State != "done")
        {
            Assert.True(DateTime.UtcNow < until, "timed out waiting for the tile to be fetched");
            await Task.Delay(20, Ct);
        }
        Assert.Equal(1, h.Overpass.Calls);
    }

    [Fact]
    public void A_failing_tile_waits_two_four_eight_and_sixteen_minutes_then_a_day()
    {
        Assert.Equal(
            [TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(4), TimeSpan.FromMinutes(8), TimeSpan.FromMinutes(16), TimeSpan.FromDays(1), TimeSpan.FromDays(1)],
            new[] { 1, 2, 3, 4, 5, 6 }.Select(TransitFetcher.Backoff));
        Assert.Equal(TimeSpan.FromDays(1), TransitFetcher.Backoff(int.MaxValue));
        Assert.Equal(TimeSpan.FromMinutes(1), TransitFetcher.Backoff(0));
    }

    [Fact]
    public void Every_request_pauses_one_two_four_minutes_up_to_an_hour()
    {
        Assert.Equal(
            [TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(4), TimeSpan.FromMinutes(32), TimeSpan.FromHours(1)],
            new[] { 1, 2, 3, 6, 7 }.Select(TransitFetcher.Pause));
        Assert.Equal(TimeSpan.FromHours(1), TransitFetcher.Pause(int.MaxValue));
    }
}
