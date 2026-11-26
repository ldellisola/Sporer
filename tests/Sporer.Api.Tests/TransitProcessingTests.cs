using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Transit;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// Trains and buses in processing (transit spec section 2): the rules run in the processor with the lines cached in <c>transit_tile</c>
/// (written here by <see cref="TransitSeeder"/>, or brought by the fetcher from a <see cref="FakeOverpass"/>), never with a request of
/// their own. The lines are made up, along the tracks the tests drive.
/// </summary>
[Collection("db")]
public class TransitProcessingTests(DatabaseFixture db)
{
    private const string UserAgent = "SporerTests/1.0 (tests@example.invalid)";

    private static readonly DateTime Day = new(2026, 11, 2, 0, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Every20s = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan Every2min = TimeSpan.FromMinutes(2);

    /// <summary>A station in tile (59.9, 10.7) of Oslo, and a stop 4 km east of it in the same tile: everything within 150 m of the way is in it.</summary>
    private static readonly GeoPoint Station = new(59.95, 10.71);
    private static readonly GeoPoint Downtown = Geo.Offset(Station, 0, 4_000);
    private static readonly TransitTile StationRail = new(TransitKind.Rail, 599, 107);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime T(int hour, int minute = 0, int day = 0) => Day.AddDays(day).AddHours(hour).AddMinutes(minute);

    private sealed record MoveRow(long Id, DateTime StartUtc, DateTime EndUtc, string? Mode, bool ModeEdited, double? DistanceM, string GeometryDetail, int PointCount);

    private static Task<IReadOnlyList<string>> KindsAsync(string cs)
        => Sql.QueryAsync<string>(cs, "select kind from segment order by start_utc, id", ct: Ct);

    private static Task<IReadOnlyList<MoveRow>> MovesAsync(string cs) => Sql.QueryAsync<MoveRow>(cs,
        """
        select id as Id, start_utc as StartUtc, end_utc as EndUtc, mode as Mode, mode_edited as ModeEdited, distance_m as DistanceM,
               geometry_detail::text as GeometryDetail, point_count as PointCount
        from segment where kind = 'move' order by start_utc
        """, ct: Ct);

    private static double[][] Coordinates(string json) => JsonSerializer.Deserialize<double[][]>(json)!;

    private sealed record ReadyRow(DateTime? FromUtc, DateTime? ToUtc, DateTime? FlushedAt);

    /// <summary>The stretch waiting to be rebuilt for the tiles that have arrived, and the last time it was asked for.</summary>
    private static async Task<ReadyRow> ReadyAsync(string cs) => (await Sql.QueryAsync<ReadyRow>(cs,
        "select transit_ready_from as FromUtc, transit_ready_to as ToUtc, transit_flushed_at as FlushedAt from processing_state where id = 1",
        ct: Ct)).Single();

    private sealed record DirtyRow(DateTime FromUtc, DateTime ToUtc, DateTime CreatedAt);

    private static Task<IReadOnlyList<DirtyRow>> DirtyAsync(string cs) => Sql.QueryAsync<DirtyRow>(cs,
        "select from_utc as FromUtc, to_utc as ToUtc, created_at as CreatedAt from dirty_range order by from_utc, id", ct: Ct);

    /// <summary>Half an hour at the station, a drive to the stop at 60 km/h, half an hour there.</summary>
    private static List<TrackPoint> Ride(GeoPoint from, GeoPoint to, double kmh = 60) => new TrackBuilder(T(8), from)
        .Stay(TimeSpan.FromMinutes(30), Every2min)
        .Travel(to, kmh, Every10s)
        .Stay(TimeSpan.FromMinutes(30), Every2min)
        .Build();

    /// <summary>The sum of the hops between consecutive points of a stored move's track, from its first point to its last.</summary>
    private static double PathMeters(IReadOnlyList<TrackPoint> track, DateTime from, DateTime to)
    {
        var points = track.Where(p => p.TimeUtc >= from && p.TimeUtc <= to).ToList();
        return points.Zip(points.Skip(1), (a, b) => Geo.DistanceMeters(a.Position, b.Position)).Sum();
    }

    private sealed class Harness(ApiFactory api, string cs, FakeOverpass overpass, FakeTimeProvider clock) : IAsyncDisposable
    {
        public ApiFactory Api { get; } = api;
        public string Cs { get; } = cs;
        public FakeOverpass Overpass { get; } = overpass;
        public FakeTimeProvider Clock { get; } = clock;
        public ITimelineProcessor Processor { get; } = api.Services.GetRequiredService<ITimelineProcessor>(); // starting the host runs the migrations
        public TransitFetcher Fetcher => Api.Services.GetRequiredService<TransitFetcher>();
        public TimelineWorker Worker => Api.Services.GetRequiredService<TimelineWorker>();
        public ProcessingQueue Queue => Api.Services.GetRequiredService<ProcessingQueue>();
        public TransitTileStore Store => Api.Services.GetRequiredService<TransitTileStore>();
        public DateTime Now => Clock.GetUtcNow().UtcDateTime;

        /// <summary>Records the version the worker would, so that its pass works on the dirty ranges and does not start a backfill.</summary>
        public Task SettleVersionAsync() => Sql.ExecAsync(Cs, "update processing_state set algorithm_version = @version",
            new { version = AlgorithmVersion.Compute(Api.Services.GetRequiredService<DetectionOptions>()) }, Ct);

        public ValueTask DisposeAsync() => Api.DisposeAsync();
    }

    /// <summary>The real app on a fresh database, with fetching on and Overpass faked. Nothing runs in the background.</summary>
    private async Task<Harness> StartAsync()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var overpass = new FakeOverpass();
        var clock = new FakeTimeProvider(new DateTimeOffset(T(12, 0, 2)));
        var api = new ApiFactory(cs, new Dictionary<string, string?> { ["Transit:Enabled"] = "true", ["Transit:UserAgent"] = UserAgent }, clock,
            services => services.AddHttpClient<OverpassClient>().ConfigurePrimaryHttpMessageHandler(() => overpass));
        return new Harness(api, cs, overpass, clock);
    }

    [Fact]
    public async Task A_drive_along_a_cached_railway_is_a_train_along_its_path()
    {
        await using var h = await StartAsync();
        var map = new TransitMap().Rail(TransitMap.Along(Station, Downtown));
        await TransitSeeder.SeedAsync(h.Cs, map, TransitKind.Rail, Station, Downtown);
        var track = Ride(Station, Downtown);
        await PointSeeder.InsertAsync(h.Cs, track, Ct);

        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        Assert.Equal(["stay", "move", "stay"], await KindsAsync(h.Cs));
        var move = Assert.Single(await MovesAsync(h.Cs));
        Assert.Equal("train", move.Mode);
        Assert.False(move.ModeEdited);
        Assert.Equal(PathMeters(track, move.StartUtc, move.EndUtc), move.DistanceM!.Value, 3);
        Assert.InRange(move.DistanceM!.Value, 3_990, 4_010);
        Assert.DoesNotContain(await TransitSeeder.TilesAsync(h.Cs), t => t.State != "done"); // nothing was missing
        Assert.Equal(0, h.Overpass.Calls);
    }

    [Fact]
    public async Task A_drive_beside_no_railway_is_a_bus_when_it_is_short()
    {
        await using var h = await StartAsync();
        var map = new TransitMap().Rail(TransitMap.Along(Station, Downtown, northMeters: 500)); // a railway, but 500 m away
        await TransitSeeder.SeedAsync(h.Cs, map, TransitKind.Rail, Station, Downtown);
        await PointSeeder.InsertAsync(h.Cs, Ride(Station, Downtown), Ct);

        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        Assert.Equal("bus", Assert.Single(await MovesAsync(h.Cs)).Mode);
        Assert.All(await TransitSeeder.TilesAsync(h.Cs), t => Assert.Equal("done", t.State)); // a short drive needs no bus routes
    }

    [Fact]
    public async Task A_missing_railway_tile_is_asked_for_and_the_move_becomes_a_train_when_it_arrives()
    {
        await using var h = await StartAsync();
        var track = Ride(Station, Downtown);
        await PointSeeder.InsertAsync(h.Cs, track, Ct);

        // Nothing is cached: the short drive is a bus at once, and its railway tile waits to be fetched, for the time of the move.
        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        var before = Assert.Single(await MovesAsync(h.Cs));
        Assert.Equal("bus", before.Mode);
        var waiting = Assert.Single(await TransitSeeder.TilesAsync(h.Cs));
        Assert.Equal(("rail", 599, 107, "pending"), (waiting.Kind, waiting.LatIndex, waiting.LonIndex, waiting.State));
        Assert.Equal((before.StartUtc, before.EndUtc), (waiting.WaitingFrom, waiting.WaitingTo));
        Assert.Equal(0, h.Overpass.Calls); // processing never asks the network

        // The fetcher brings the tile, and the stretch of the move waits to be rebuilt with whatever other tiles arrive soon after.
        h.Overpass.ReplyLines(TransitMap.Along(Geo.Offset(Station, 0, -1_000), Geo.Offset(Downtown, 0, 1_000)));
        Assert.True(await h.Fetcher.RunOnceAsync(Ct));
        var fetched = Assert.Single(await TransitSeeder.TilesAsync(h.Cs));
        Assert.Equal(("done", 1, (DateTime?)null, (DateTime?)null), (fetched.State, fetched.LineCount, fetched.WaitingFrom, fetched.WaitingTo));
        Assert.Equal(new ReadyRow(before.StartUtc, before.EndUtc, h.Now), await ReadyAsync(h.Cs));
        Assert.Empty(await DirtyAsync(h.Cs));

        // No other tile is coming: the worker's next pass asks for the stretch and rebuilds it.
        await h.SettleVersionAsync();
        Assert.True(await h.Worker.RunOnceAsync(Ct));

        var after = Assert.Single(await MovesAsync(h.Cs));
        Assert.Equal("train", after.Mode);
        Assert.Equal((before.StartUtc, before.EndUtc, before.DistanceM), (after.StartUtc, after.EndUtc, after.DistanceM));
        Assert.Equal(0, await Sql.ScalarAsync<long>(h.Cs, "select count(*) from dirty_range", ct: Ct));
        Assert.Equal(new ReadyRow(null, null, h.Now), await ReadyAsync(h.Cs));
        Assert.Equal(["done"], (await TransitSeeder.TilesAsync(h.Cs)).Select(t => t.State)); // nothing more to fetch
    }

    [Fact]
    public async Task Tiles_that_arrive_while_the_backfill_is_open_are_rebuilt_once_it_is_done_as_one_stretch()
    {
        await using var h = await StartAsync();
        await h.SettleVersionAsync();
        var bus = new TransitTile(TransitKind.Bus, 599, 107);
        await TransitSeeder.WaitingAsync(h.Cs, StationRail, T(8), T(9));
        await TransitSeeder.WaitingAsync(h.Cs, bus, T(7, 0, 1), T(10, 0, 1));
        await Sql.ExecAsync(h.Cs, "update processing_state set backfill_from = @from, backfill_to = @to, backfill_cursor = @cursor, paused = true",
            new { from = T(0, 0, -30), to = T(12, 0, 2), cursor = T(0, 0, -10) }, Ct);

        h.Overpass.ReplyLines();
        h.Overpass.ReplyLines();
        Assert.True(await h.Fetcher.RunOnceAsync(Ct));
        var first = h.Now;
        h.Clock.Advance(TimeSpan.FromSeconds(10));
        Assert.True(await h.Fetcher.RunOnceAsync(Ct));
        Assert.Equal(new ReadyRow(T(8), T(10, 0, 1), first), await ReadyAsync(h.Cs));

        // No tile is due any more, and yet nothing is asked for while the backfill is open, paused or not: it reads the tiles as it goes, and
        // what is behind it is rebuilt once, at the end. A pass of the worker leaves the stretch waiting too.
        h.Clock.Advance(ProcessingQueue.TransitHold);
        Assert.Null(await h.Queue.FlushTransitReadyAsync(h.Now, Ct));
        await h.Worker.RunOnceAsync(Ct);
        await Sql.ExecAsync(h.Cs, "update processing_state set paused = false", ct: Ct);
        Assert.Null(await h.Queue.FlushTransitReadyAsync(h.Now, Ct));
        Assert.Empty(await DirtyAsync(h.Cs));
        Assert.Equal(new ReadyRow(T(8), T(10, 0, 1), first), await ReadyAsync(h.Cs));

        // Done: both stretches are one range, due at once.
        await Sql.ExecAsync(h.Cs, "update processing_state set backfill_cursor = backfill_to", ct: Ct);
        Assert.Equal((T(8), T(10, 0, 1)), await h.Queue.FlushTransitReadyAsync(h.Now, Ct));
        Assert.Equal([new DirtyRow(T(8), T(10, 0, 1), h.Now - TimeSpan.FromMinutes(1))], await DirtyAsync(h.Cs));
        Assert.Equal(new ReadyRow(null, null, h.Now), await ReadyAsync(h.Cs));
        Assert.Null(await h.Queue.FlushTransitReadyAsync(h.Now, Ct)); // asked for once
    }

    [Fact]
    public async Task While_other_tiles_are_due_the_tiles_that_arrive_are_rebuilt_together_at_most_every_ten_minutes()
    {
        await using var h = await StartAsync();
        var bus = new TransitTile(TransitKind.Bus, 599, 107);
        var lisbon = new TransitTile(TransitKind.Rail, 387, -92);
        await TransitSeeder.WaitingAsync(h.Cs, StationRail, T(10), T(11)); // fetched first: the most recent travels
        await TransitSeeder.WaitingAsync(h.Cs, bus, T(8), T(9));
        await TransitSeeder.WaitingAsync(h.Cs, lisbon, T(6), T(7));
        // Neither of these is due: one waits out a failure, one was set aside. They hold nothing back.
        await TransitSeeder.WaitingAsync(h.Cs, new TransitTile(TransitKind.Rail, 355, 1397), T(1), T(2), attempts: 2, nextAttemptAt: T(12, 0, 3));
        await TransitSeeder.WaitingAsync(h.Cs, new TransitTile(TransitKind.Bus, 355, 1397), T(1), T(2), attempts: 5, nextAttemptAt: T(12, 0, 3), state: "failed");
        for (var k = 0; k < 3; k++)
            h.Overpass.ReplyLines();

        Assert.True(await h.Fetcher.RunOnceAsync(Ct));
        var first = h.Now;
        Assert.Null(await h.Queue.FlushTransitReadyAsync(h.Now, Ct)); // two more are due

        h.Clock.Advance(TimeSpan.FromSeconds(10));
        Assert.True(await h.Fetcher.RunOnceAsync(Ct));
        Assert.Null(await h.Queue.FlushTransitReadyAsync(h.Now, Ct));
        h.Clock.Advance(ProcessingQueue.TransitHold - TimeSpan.FromSeconds(10) - TimeSpan.FromMilliseconds(1));
        Assert.Null(await h.Queue.FlushTransitReadyAsync(h.Now, Ct));
        Assert.Empty(await DirtyAsync(h.Cs));
        Assert.Equal(new ReadyRow(T(8), T(11), first), await ReadyAsync(h.Cs));

        // Ten minutes after the first arrived, the two go as one range, although one tile is still due.
        h.Clock.Advance(TimeSpan.FromMilliseconds(1));
        Assert.Equal((T(8), T(11)), await h.Queue.FlushTransitReadyAsync(h.Now, Ct));
        var flushed = h.Now;
        Assert.Equal([new DirtyRow(T(8), T(11), flushed - TimeSpan.FromMinutes(1))], await DirtyAsync(h.Cs));
        await Sql.ExecAsync(h.Cs, "delete from dirty_range", ct: Ct); // as the worker does once it has rebuilt it

        // The last one: with no tile due any more, it goes at once, not ten minutes after the last time.
        h.Clock.Advance(TimeSpan.FromSeconds(10));
        Assert.True(await h.Fetcher.RunOnceAsync(Ct));
        Assert.Equal(new ReadyRow(T(6), T(7), flushed), await ReadyAsync(h.Cs));
        Assert.Equal((T(6), T(7)), await h.Queue.FlushTransitReadyAsync(h.Now, Ct));
        Assert.Equal([new DirtyRow(T(6), T(7), h.Now - TimeSpan.FromMinutes(1))], await DirtyAsync(h.Cs));
        Assert.Null(await h.Queue.FlushTransitReadyAsync(h.Now, Ct));
    }

    [Fact]
    public async Task A_rebuild_that_missed_a_tile_fetched_meanwhile_asks_for_its_stretch_again()
    {
        await using var h = await StartAsync();
        var store = h.Api.Services.GetRequiredService<TransitTileStore>();
        await TransitSeeder.StoreAsync(h.Cs, StationRail, [TransitMap.Along(Station, Downtown)]);

        // Another tile is still due, which would hold back the stretches of the tiles that arrive (see ProcessingQueue.TransitHold).
        await TransitSeeder.WaitingAsync(h.Cs, new TransitTile(TransitKind.Rail, 387, -92), T(6), T(7));

        // A rebuild that read the cache before the tile arrived says it needed it.
        await store.RecordNeededAsync([new NeededTile(StationRail, T(8, 30), T(8, 34))], T(12, 0, 2), Ct);

        var tile = (await TransitSeeder.TilesAsync(h.Cs)).Single(t => t is { LatIndex: 599, LonIndex: 107 });
        Assert.Equal(("done", (DateTime?)null), (tile.State, tile.WaitingFrom)); // never made to wait again
        var dirty = await Sql.SingleAsync(h.Cs, "select from_utc, to_utc, created_at from dirty_range", ct: Ct);
        Assert.Equal((T(8, 30), T(8, 34)), (((DateTime)dirty.from_utc).ToUniversalTime(), ((DateTime)dirty.to_utc).ToUniversalTime()));
        Assert.True(((DateTime)dirty.created_at).ToUniversalTime() <= T(12, 0, 2) - TimeSpan.FromMinutes(1)); // due at once
        Assert.Equal(new ReadyRow(null, null, null), await ReadyAsync(h.Cs)); // not held with the tiles that arrive
    }

    [Fact]
    public async Task A_tile_wanted_again_waits_for_the_stretch_of_all_the_moves_that_want_it()
    {
        await using var h = await StartAsync();
        var store = h.Api.Services.GetRequiredService<TransitTileStore>();
        var bus = new TransitTile(TransitKind.Bus, 599, 107);

        await store.RecordNeededAsync([new NeededTile(StationRail, T(8), T(9)), new NeededTile(bus, T(8), T(9))], T(12), Ct);
        await store.RecordNeededAsync([new NeededTile(StationRail, T(7), T(7, 30)), new NeededTile(StationRail, T(10), T(11))], T(12), Ct);

        var tiles = await TransitSeeder.TilesAsync(h.Cs);
        Assert.Equal(2, tiles.Count);
        Assert.Equal(("rail", T(7), T(11)), (tiles[0].Kind, tiles[0].WaitingFrom!.Value, tiles[0].WaitingTo!.Value));
        Assert.Equal(("bus", T(8), T(9)), (tiles[1].Kind, tiles[1].WaitingFrom!.Value, tiles[1].WaitingTo!.Value));
        Assert.All(tiles, t => Assert.Equal("pending", t.State));
        Assert.Equal(0, await Sql.ScalarAsync<long>(h.Cs, "select count(*) from dirty_range", ct: Ct));
    }

    [Theory]
    // railways known and none near: a long drive is a bus on a bus route, and a drive otherwise
    [InlineData(true, true, true, "bus", "")]
    [InlineData(true, true, false, "drive", "")]
    // the bus routes are not cached yet: a drive, until they are
    [InlineData(true, false, false, "drive", "bus")]
    // nothing cached: the bus routes are asked for only once the railways are known not to make it a train
    [InlineData(false, false, false, "drive", "rail")]
    public async Task A_long_drive_is_a_bus_only_along_a_bus_route(bool railCached, bool busCached, bool busRoute, string mode, string waiting)
    {
        await using var h = await StartAsync();
        var far = Geo.Offset(Station, 0, 25_000); // 25 km east: longer than Detection:BusMaxKm
        var map = new TransitMap().Rail(TransitMap.Along(Station, far, northMeters: 2_000));
        if (busRoute)
            map.Bus(TransitMap.Along(Station, far));
        if (railCached)
            await TransitSeeder.SeedAsync(h.Cs, map, TransitKind.Rail, Station, far);
        if (busCached)
            await TransitSeeder.SeedAsync(h.Cs, map, TransitKind.Bus, Station, far);
        await PointSeeder.InsertAsync(h.Cs, Ride(Station, far, kmh: 80), Ct);

        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        Assert.Equal(mode, Assert.Single(await MovesAsync(h.Cs)).Mode);
        var asked = (await TransitSeeder.TilesAsync(h.Cs)).Where(t => t.State == "pending").Select(t => t.Kind).Distinct();
        Assert.Equal(waiting, string.Join(",", asked));
    }

    /// <summary>
    /// A fast train: 15 km north at 120 km/h, then 70 km north and 60 km east at 250 km/h (which the segmenter takes for a flight), then
    /// 15 km east at 120 km/h, between two half-hour stays, logged every 20 s, all along one railway. Returns the track and the corner.
    /// </summary>
    private static (List<TrackPoint> Track, GeoPoint Corner, GeoPoint Start, GeoPoint End) FastTrain(bool slowEnds = true)
    {
        var start = new GeoPoint(60.25, 10.75);
        var fastFrom = slowEnds ? Geo.Offset(start, 15_000, 0) : start;
        var corner = Geo.Offset(fastFrom, 70_000, 0);
        var fastTo = Geo.Offset(corner, 0, 60_000);
        var end = slowEnds ? Geo.Offset(fastTo, 0, 15_000) : fastTo;
        var builder = new TrackBuilder(T(8), start).Stay(TimeSpan.FromMinutes(30), Every2min);
        if (slowEnds)
            builder.Travel(fastFrom, 120, Every20s);
        builder.Travel(corner, 250, Every20s).Travel(fastTo, 250, Every20s);
        if (slowEnds)
            builder.Travel(end, 120, Every20s);
        return (builder.Stay(TimeSpan.FromMinutes(30), Every2min).Build(), corner, start, end);
    }

    private static TransitMap RailwayAlong(params GeoPoint[] stops)
    {
        var line = new List<GeoPoint>();
        for (var k = 1; k < stops.Length; k++)
            line.AddRange(TransitMap.Along(stops[k - 1], stops[k]).Skip(k == 1 ? 0 : 1));
        return new TransitMap().Rail(line);
    }

    [Fact]
    public async Task A_flight_that_follows_a_railway_is_a_train_drawn_and_measured_along_its_path()
    {
        await using var h = await StartAsync();
        var (track, corner, start, end) = FastTrain(slowEnds: false);
        await TransitSeeder.SeedAsync(h.Cs, RailwayAlong(start, corner, end), TransitKind.Rail, start, end);
        await PointSeeder.InsertAsync(h.Cs, track, Ct);

        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        Assert.Equal(["stay", "move", "stay"], await KindsAsync(h.Cs));
        var move = Assert.Single(await MovesAsync(h.Cs));
        Assert.Equal("train", move.Mode);
        Assert.Equal(PathMeters(track, move.StartUtc, move.EndUtc), move.DistanceM!.Value, 3); // 130 km, not the 92 km across
        Assert.InRange(move.DistanceM!.Value, 129_000, 131_000);
        var line = Coordinates(move.GeometryDetail);
        Assert.NotEqual(MoveGeometry.ArcPoints, line.Length);
        Assert.Contains(line, c => Geo.DistanceMeters(new GeoPoint(c[1], c[0]), corner) < 1); // through the corner, not across it
    }

    [Fact]
    public async Task A_flight_whose_railway_tiles_are_missing_stays_a_flight_until_they_arrive()
    {
        await using var h = await StartAsync();
        var (track, _, start, end) = FastTrain(slowEnds: false);
        await PointSeeder.InsertAsync(h.Cs, track, Ct);

        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        var move = Assert.Single(await MovesAsync(h.Cs));
        Assert.Equal("flight", move.Mode);
        Assert.Equal(MoveGeometry.ArcPoints, Coordinates(move.GeometryDetail).Length);
        Assert.Equal(Geo.DistanceMeters(start, end), move.DistanceM!.Value, 1);
        var waiting = await TransitSeeder.TilesAsync(h.Cs);
        Assert.NotEmpty(waiting);
        Assert.All(waiting, t => Assert.Equal(("rail", "pending", move.StartUtc, move.EndUtc), (t.Kind, t.State, t.WaitingFrom!.Value, t.WaitingTo!.Value)));
    }

    [Fact]
    public async Task The_pieces_of_one_train_ride_are_one_move()
    {
        await using var h = await StartAsync();
        var (track, corner, start, end) = FastTrain();
        await TransitSeeder.SeedAsync(h.Cs, RailwayAlong(start, Geo.Offset(start, 15_000, 0), corner, Geo.Offset(end, 0, -15_000), end), TransitKind.Rail, start, end);
        await PointSeeder.InsertAsync(h.Cs, track, Ct);

        // Without the railways the segmenter's pieces are plain to see: a short drive (so a bus), a flight and another, one after the other.
        var other = await db.CreateDatabaseAsync(Ct);
        IReadOnlyList<MoveRow> pieces;
        await using (var bare = new ApiFactory(other))
        {
            _ = bare.Services; // starting the host runs the migrations
            await PointSeeder.InsertAsync(other, track, Ct);
            await bare.Services.GetRequiredService<ITimelineProcessor>().ReprocessAsync(T(0), T(0, 0, 1), Ct);
            Assert.Equal(["stay", "move", "move", "move", "stay"], await KindsAsync(other));
            pieces = await MovesAsync(other);
            Assert.Equal(["bus", "flight", "bus"], pieces.Select(m => m.Mode));
        }

        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        Assert.Equal(["stay", "move", "stay"], await KindsAsync(h.Cs));
        var ride = Assert.Single(await MovesAsync(h.Cs));
        Assert.Equal("train", ride.Mode);
        Assert.False(ride.ModeEdited);
        var stays = await Sql.QueryAsync<DateTime>(h.Cs, "select end_utc from segment where kind = 'stay' order by start_utc", ct: Ct);
        Assert.Equal(stays[0], ride.StartUtc);
        Assert.Equal(PathMeters(track, ride.StartUtc, ride.EndUtc), ride.DistanceM!.Value, 3);
        Assert.InRange(ride.DistanceM!.Value, 159_000, 161_000);
        Assert.Equal(track.Count(p => p.TimeUtc >= ride.StartUtc && p.TimeUtc <= ride.EndUtc), ride.PointCount); // each point once
        Assert.Contains(Coordinates(ride.GeometryDetail), c => Geo.DistanceMeters(new GeoPoint(c[1], c[0]), corner) < 1);
        Assert.Equal((pieces[0].StartUtc, pieces[^1].EndUtc), (ride.StartUtc, ride.EndUtc));

        // The owner said the first piece was a train: the ride is the same, and says that the owner set (part of) its mode.
        await Sql.ExecAsync(h.Cs, "insert into mode_edit (from_utc, to_utc, mode) values (@from, @to, 'train')",
            new { from = pieces[0].StartUtc, to = pieces[0].EndUtc }, Ct);
        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);
        var edited = Assert.Single(await MovesAsync(h.Cs));
        Assert.Equal(("train", true, ride.StartUtc, ride.EndUtc, ride.DistanceM), (edited.Mode, edited.ModeEdited, edited.StartUtc, edited.EndUtc, edited.DistanceM));

        // The owner said the whole ride was a bus: each piece is, and buses are not joined.
        await Sql.ExecAsync(h.Cs, "delete from mode_edit; insert into mode_edit (from_utc, to_utc, mode) values (@from, @to, 'bus')",
            new { from = ride.StartUtc, to = ride.EndUtc }, Ct);
        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);
        Assert.Equal(
            pieces.Select(p => (p.StartUtc, p.EndUtc, "bus", true)),
            (await MovesAsync(h.Cs)).Select(m => (m.StartUtc, m.EndUtc, m.Mode!, m.ModeEdited)));
    }

    [Fact] // the drive rule never makes so short a stretch a train: it was a bus that cut the ride in two
    public async Task A_fast_train_that_slowed_down_for_a_moment_is_one_ride_unless_the_owner_set_the_mode_of_that_moment()
    {
        await using var h = await StartAsync();
        var start = new GeoPoint(60.25, 10.75);
        var slowFromAt = Geo.Offset(start, 120_000, 0);
        var slowToAt = Geo.Offset(slowFromAt, 600, 0);
        var end = Geo.Offset(slowToAt, 120_000, 0);
        var builder = new TrackBuilder(T(8), start).Stay(TimeSpan.FromMinutes(30), Every2min).Travel(slowFromAt, 250, Every10s);
        var slowFrom = builder.Now;
        builder.Travel(slowToAt, 190, Every10s); // under flight speed for 600 m
        var slowTo = builder.Now;
        var track = builder.Travel(end, 250, Every10s).Stay(TimeSpan.FromMinutes(30), Every2min).Build();
        await TransitSeeder.SeedAsync(h.Cs, RailwayAlong(start, slowFromAt, slowToAt, end), TransitKind.Rail, start, end);
        await PointSeeder.InsertAsync(h.Cs, track, Ct);

        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        Assert.Equal(["stay", "move", "stay"], await KindsAsync(h.Cs));
        var ride = Assert.Single(await MovesAsync(h.Cs));
        Assert.Equal(("train", false), (ride.Mode, ride.ModeEdited));
        Assert.True(ride.StartUtc < slowFrom && slowTo < ride.EndUtc);
        Assert.Equal(PathMeters(track, ride.StartUtc, ride.EndUtc), ride.DistanceM!.Value, 3);
        Assert.Equal(track.Count(p => p.TimeUtc >= ride.StartUtc && p.TimeUtc <= ride.EndUtc), ride.PointCount); // each point once

        // The owner said that moment was a bus: it is, between the two parts of the ride.
        await Sql.ExecAsync(h.Cs, "insert into mode_edit (from_utc, to_utc, mode) values (@from, @to, 'bus')", new { from = slowFrom, to = slowTo }, Ct);
        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        Assert.Equal(
            [("train", false, ride.StartUtc, slowFrom), ("bus", true, slowFrom, slowTo), ("train", false, slowTo, ride.EndUtc)],
            (await MovesAsync(h.Cs)).Select(m => (m.Mode!, m.ModeEdited, m.StartUtc, m.EndUtc)));
    }

    [Fact]
    public async Task Rebuilding_in_pieces_gives_what_one_rebuild_gives_with_the_same_lines_cached()
    {
        var (track, corner, start, end) = FastTrain();
        var map = RailwayAlong(start, Geo.Offset(start, 15_000, 0), corner, Geo.Offset(end, 0, -15_000), end);

        async Task<string> PrepareAsync()
        {
            var cs = await db.CreateDatabaseAsync(Ct);
            await using (var migrate = new ApiFactory(cs))
                _ = migrate.Services;
            await TransitSeeder.SeedAsync(cs, map, TransitKind.Rail, start, end);
            await PointSeeder.InsertAsync(cs, track, Ct);
            // A short drive the next morning, with no tile cached around it: it is asked for in both.
            await PointSeeder.InsertAsync(cs, new TrackBuilder(T(8, 0, 1), end).Stay(TimeSpan.FromMinutes(20), Every2min)
                .Travel(Geo.Offset(end, -3_000, 0), 50, Every10s).Stay(TimeSpan.FromMinutes(20), Every2min).Build(), Ct);
            return cs;
        }

        var fullCs = await PrepareAsync();
        await using (var full = new ApiFactory(fullCs))
            await full.Services.GetRequiredService<ITimelineProcessor>().ReprocessAsync(T(0), T(0, 0, 2), Ct);

        // Edges in the middle of the slow start, of the fast part, of the slow end and of the drive.
        var chunkedCs = await PrepareAsync();
        await using (var chunked = new ApiFactory(chunkedCs))
        {
            var processor = chunked.Services.GetRequiredService<ITimelineProcessor>();
            DateTime[] edges = [T(0), T(8, 36), T(8, 55), T(9, 25), T(8, 40, 1), T(0, 0, 2)];
            for (var k = 0; k + 1 < edges.Length; k++)
                await processor.ReprocessAsync(edges[k], edges[k + 1], Ct);
        }

        var expected = await TimelineProcessorTests.CanonicalRowsAsync(fullCs);
        Assert.Contains(expected, row => row.Contains("\"mode\": \"train\"", StringComparison.Ordinal));
        Assert.Contains(expected, row => row.Contains("\"mode\": \"bus\"", StringComparison.Ordinal));
        Assert.Equal(expected, await TimelineProcessorTests.CanonicalRowsAsync(chunkedCs));
        Assert.Equal(
            (await TransitSeeder.TilesAsync(fullCs)).Where(t => t.State == "pending").Select(t => (t.Kind, t.LatIndex, t.LonIndex)),
            (await TransitSeeder.TilesAsync(chunkedCs)).Where(t => t.State == "pending").Select(t => (t.Kind, t.LatIndex, t.LonIndex)));
    }

    [Fact]
    public async Task A_deleted_tile_is_not_served_from_memory()
    {
        await using var h = await StartAsync();
        var map = new TransitMap().Rail(TransitMap.Along(Station, Downtown));
        await TransitSeeder.SeedAsync(h.Cs, map, TransitKind.Rail, Station, Downtown);
        await PointSeeder.InsertAsync(h.Cs, Ride(Station, Downtown), Ct);
        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);
        Assert.Equal("train", Assert.Single(await MovesAsync(h.Cs)).Mode);

        // The owner deletes the cached tiles to have them fetched again (README): the next rebuild asks for them.
        await Sql.ExecAsync(h.Cs, "delete from transit_tile", ct: Ct);
        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        Assert.Equal("bus", Assert.Single(await MovesAsync(h.Cs)).Mode);
        Assert.Equal([("rail", "pending")], (await TransitSeeder.TilesAsync(h.Cs)).Select(t => (t.Kind, t.State)));
    }

    [Fact]
    public async Task A_tile_fetched_again_is_read_again()
    {
        await using var h = await StartAsync();
        await TransitSeeder.SeedAsync(h.Cs, new TransitMap(), TransitKind.Rail, Station, Downtown); // cached, and no railway
        await PointSeeder.InsertAsync(h.Cs, Ride(Station, Downtown), Ct);
        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);
        Assert.Equal("bus", Assert.Single(await MovesAsync(h.Cs)).Mode);

        await TransitSeeder.StoreAsync(h.Cs, StationRail, [TransitMap.Along(Station, Downtown)], fetchedAt: T(12, 0, 1));
        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        Assert.Equal("train", Assert.Single(await MovesAsync(h.Cs)).Mode);
    }

    [Theory]
    [InlineData("lines = null")] // a hand edit instead of deleting the row (README), or a restore that left the lines out
    [InlineData("lines = null, fetched_at = null")]
    [InlineData("lines = '\\x0102'::bytea, fetched_at = null")]
    public async Task A_fetched_tile_without_lines_that_can_be_read_is_fetched_again_and_its_stretch_is_not_rebuilt_over_and_over(string damage)
    {
        await using var h = await StartAsync();
        await TransitSeeder.SeedAsync(h.Cs, new TransitMap().Rail(TransitMap.Along(Station, Downtown)), TransitKind.Rail, Station, Downtown);
        // The database no longer lets a fetched tile be without them (0007); one that has no such check yet can still have it.
        await Sql.ExecAsync(h.Cs, "alter table transit_tile drop constraint transit_tile_done_has_lines", ct: Ct);
        await Sql.ExecAsync(h.Cs, $"update transit_tile set {damage} where lat_index = 599 and lon_index = 107", ct: Ct);
        await PointSeeder.InsertAsync(h.Cs, Ride(Station, Downtown), Ct);

        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        var move = Assert.Single(await MovesAsync(h.Cs));
        Assert.Equal("bus", move.Mode);
        var tile = (await TransitSeeder.TilesAsync(h.Cs)).Single(t => t is { LatIndex: 599, LonIndex: 107 });
        Assert.Equal(("pending", (DateTime?)null, move.StartUtc, move.EndUtc), (tile.State, tile.FetchedAt, tile.WaitingFrom!.Value, tile.WaitingTo!.Value));
        Assert.Null(await TransitSeeder.LinesAsync(h.Cs, StationRail));
        Assert.Empty(await DirtyAsync(h.Cs)); // waiting for the fetcher, not rebuilt again at once

        // And so on every rebuild until it arrives.
        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);
        Assert.Empty(await DirtyAsync(h.Cs));
    }

    [Fact]
    public async Task A_tile_whose_lines_cannot_be_read_is_fetched_again()
    {
        await using var h = await StartAsync();
        await TransitSeeder.SeedAsync(h.Cs, new TransitMap().Rail(TransitMap.Along(Station, Downtown)), TransitKind.Rail, Station, Downtown);
        await Sql.ExecAsync(h.Cs, "update transit_tile set lines = '\\x0102'::bytea where lat_index = 599 and lon_index = 107", ct: Ct);
        await PointSeeder.InsertAsync(h.Cs, Ride(Station, Downtown), Ct);

        await h.Processor.ReprocessAsync(T(0), T(0, 0, 1), Ct);

        var move = Assert.Single(await MovesAsync(h.Cs));
        Assert.Equal("bus", move.Mode);
        var tile = (await TransitSeeder.TilesAsync(h.Cs)).Single(t => t is { LatIndex: 599, LonIndex: 107 });
        Assert.Equal(("pending", (DateTime?)null, move.StartUtc, move.EndUtc), (tile.State, tile.FetchedAt, tile.WaitingFrom!.Value, tile.WaitingTo!.Value));
    }
}
