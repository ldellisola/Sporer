using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// The nights of a time window, built from the stored timeline and the raw points, and the stores under them. Every night
/// is read in Europe/Oslo (UTC+2 in June) unless a test says otherwise, so the night of 10 June is read at 01:00Z on the 11th.
/// </summary>
[Collection("db")]
public class NightBuilderTests(DatabaseFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime Utc(int month, int day, int hour, int minute = 0)
        => new(2026, month, day, hour, minute, 0, DateTimeKind.Utc);

    private static DateOnly D(int month, int day) => new(2026, month, day);

    /// <summary>A stay's centre is its own, not its place's: a few metres off the place.</summary>
    private static readonly GeoPoint StayCentre = Geo.Offset(Spots.Home, 20, 0);

    private static Task<long> StayAsync(
        string cs, DateTime start, DateTime end, GeoPoint at, long? place = null, string zone = "Europe/Oslo")
        => TimelineSeeder.InsertSegmentAsync(cs, "stay", start, end,
            LocalTime.LocalDate(start, zone), LocalTime.LocalDate(end, zone), zone, placeId: place, lat: at.Latitude, lon: at.Longitude);

    private static Task<long> GapAsync(
        string cs, DateTime start, DateTime end, string startZone = "Europe/Oslo", string? endZone = null)
    {
        var first = LocalTime.LocalDate(start, startZone);
        var last = LocalTime.LocalDate(end, endZone ?? startZone);
        return TimelineSeeder.InsertSegmentAsync(cs, "gap", start, end, first <= last ? first : last, first <= last ? last : first,
            startZone, endZone);
    }

    private static Task PointAsync(string cs, DateTime time, GeoPoint at)
        => PointSeeder.InsertAsync(cs, [new TrackPoint(time, "phone", at.Latitude, at.Longitude, null, null, null)], Ct);

    /// <summary>The night of <paramref name="date"/> from a build result; the test says which nights it expects.</summary>
    private static (Night Night, string Source) NightOf(
        (DateOnly From, DateOnly To, IReadOnlyList<(Night Night, string Source)> Nights) built, DateOnly date)
        => Assert.Single(built.Nights, n => n.Night.Date == date);

    // ---- the brief ---------------------------------------------------------------------------------------------------

    [Fact]
    public async Task NightBuilder_takes_the_stay_covering_03_00()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>(); // starting the host runs the migrations
        var place = await TimelineSeeder.InsertPlaceAsync(cs, lat: Spots.Home.Latitude, lon: Spots.Home.Longitude);
        await StayAsync(cs, Utc(6, 10, 18), Utc(6, 11, 6), StayCentre, place);
        await PointAsync(cs, Utc(6, 11, 1, 5), Spots.Lisbon); // a stray point right at the instant: the stay still wins

        var built = await builder.BuildAsync(Utc(6, 10, 12), Utc(6, 11, 12), Ct);

        var (night, source) = NightOf(built, D(6, 10));
        Assert.Equal("stay", source);
        Assert.Equal(new Night(D(6, 10), Utc(6, 11, 1), "Europe/Oslo", place, StayCentre), night);
    }

    [Fact]
    public async Task NightBuilder_uses_the_nearest_point_when_no_stay_covers_the_night()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>();
        await GapAsync(cs, Utc(6, 10, 18), Utc(6, 11, 8));
        var earlier = Geo.Offset(Spots.Home, 5_000, 0);
        var nearer = Geo.Offset(Spots.Home, 0, 5_000);
        await PointAsync(cs, Utc(6, 11, 0, 10), earlier); // 50 minutes before the instant
        await PointAsync(cs, Utc(6, 11, 1, 30), nearer);  // 30 minutes after it

        var built = await builder.BuildAsync(Utc(6, 10, 12), Utc(6, 11, 12), Ct);

        var (night, source) = NightOf(built, D(6, 10));
        Assert.Equal("point", source);
        Assert.Equal(new Night(D(6, 10), Utc(6, 11, 1), "Europe/Oslo", null, nearer), night);
    }

    [Fact]
    public async Task NightBuilder_matches_a_point_night_to_a_place_within_75_m()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>();
        var place = await TimelineSeeder.InsertPlaceAsync(cs, lat: Spots.Home.Latitude, lon: Spots.Home.Longitude);
        await GapAsync(cs, Utc(6, 10, 18), Utc(6, 12, 8));
        await PointAsync(cs, Utc(6, 11, 0, 30), Geo.Offset(Spots.Home, 60, 0)); // night of 10 June: inside the radius
        await PointAsync(cs, Utc(6, 12, 0, 30), Geo.Offset(Spots.Home, 90, 0)); // night of 11 June: outside it

        var built = await builder.BuildAsync(Utc(6, 10, 12), Utc(6, 11, 12), Ct);

        var inside = NightOf(built, D(6, 10));
        var outside = NightOf(built, D(6, 11));
        Assert.Equal((place, "point"), (inside.Night.PlaceId, inside.Source));
        Assert.Equal((null, "point"), (outside.Night.PlaceId, outside.Source));
        Assert.Equal(1, await Sql.ScalarAsync<long>(cs, "select count(*) from place", ct: Ct)); // a night never creates a place
    }

    [Fact]
    public async Task NightBuilder_marks_a_night_unknown_when_nothing_is_within_12_hours()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>();
        await GapAsync(cs, Utc(6, 10, 18), Utc(6, 12, 8));
        await PointAsync(cs, Utc(6, 11, 1).AddHours(-12).AddMinutes(-1), Spots.Home); // a minute too early
        await PointAsync(cs, Utc(6, 11, 1).AddHours(12).AddMinutes(1), Spots.Home);   // a minute too late

        var built = await builder.BuildAsync(Utc(6, 10, 12), Utc(6, 11, 12), Ct);

        var (night, source) = NightOf(built, D(6, 10));
        Assert.Equal("none", source);
        Assert.Equal(new Night(D(6, 10), Utc(6, 11, 1), "Europe/Oslo", null, null), night);
    }

    [Fact]
    public async Task NightBuilder_skips_nights_that_have_not_happened()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>();
        await StayAsync(cs, Utc(6, 10, 18), Utc(6, 11, 12), StayCentre);
        await PointAsync(cs, Utc(6, 12, 1), Spots.Home); // a raw point after the last segment does not make its night happen

        var built = await builder.BuildAsync(Utc(6, 10, 12), Utc(6, 11, 12), Ct);

        // The window still runs from 9 to 12 June, so a stored night after the data is removed by the replace.
        Assert.Equal((D(6, 9), D(6, 12)), (built.From, built.To));
        Assert.Equal([D(6, 9), D(6, 10)], built.Nights.Select(n => n.Night.Date));
    }

    [Fact]
    public async Task NightBuilder_locates_a_night_in_Tokyo_at_03_00_Tokyo_time()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>();
        await StayAsync(cs, Utc(6, 10, 12), Utc(6, 11, 0), Spots.Tokyo, zone: "Asia/Tokyo");

        var built = await builder.BuildAsync(Utc(6, 10, 12), Utc(6, 10, 20), Ct);

        var (night, source) = NightOf(built, D(6, 10));
        Assert.Equal("stay", source);
        Assert.Equal(new Night(D(6, 10), Utc(6, 10, 18), "Asia/Tokyo", null, Spots.Tokyo), night); // 03:00 on the 11th in Tokyo
    }

    [Fact]
    public async Task NightStore_replaces_only_the_window()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var store = api.Services.GetRequiredService<NightStore>();
        var place = await TimelineSeeder.InsertPlaceAsync(cs);
        Night At(int day, long? placeId, GeoPoint? position)
            => new(D(6, day), Utc(6, day + 1, 1), "Europe/Oslo", placeId, position);
        var first = new (Night Night, string Source)[]
        {
            (At(1, place, StayCentre), "stay"),
            (At(2, null, Spots.Cafe), "point"),
            (At(3, null, null), "none"),
            (At(4, place, StayCentre), "stay"),
            (At(5, null, null), "none"),
        };
        await store.ReplaceAsync(D(6, 1), D(6, 5), first, Ct);
        Assert.Equal(first.Select(n => n.Night), await store.LoadAllAsync(Ct)); // every field comes back, in date order

        var changed = At(4, null, Spots.Office);
        await store.ReplaceAsync(D(6, 3), D(6, 4), [(changed, "point")], Ct);

        Assert.Equal([first[0].Night, first[1].Night, changed, first[4].Night], await store.LoadAllAsync(Ct));
        Assert.Equal(["stay", "point", "point", "none"],
            await Sql.QueryAsync<string>(cs, "select source from night order by date", ct: Ct));

        await store.ReplaceAsync(D(6, 1), D(6, 2), [], Ct); // no nights for a window removes what it held

        Assert.Equal([changed, first[4].Night], await store.LoadAllAsync(Ct));
    }

    // ---- beyond the brief: the zone rules, the window and the stores --------------------------------------------------

    [Fact]
    public async Task NightBuilder_builds_the_nights_a_day_either_side_of_the_window()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>();
        await StayAsync(cs, Utc(6, 1, 0), Utc(6, 30, 0), StayCentre);

        var built = await builder.BuildAsync(Utc(6, 10, 12), Utc(6, 12, 20), Ct);

        Assert.Equal((D(6, 9), D(6, 13)), (built.From, built.To));
        Assert.Equal([D(6, 9), D(6, 10), D(6, 11), D(6, 12), D(6, 13)], built.Nights.Select(n => n.Night.Date));
        Assert.All(built.Nights, n => Assert.Equal("stay", n.Source));
    }

    [Fact]
    public async Task NightBuilder_builds_nothing_without_a_timeline_but_still_names_the_window()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>();
        await PointAsync(cs, Utc(6, 11, 1), Spots.Home);

        var built = await builder.BuildAsync(Utc(6, 10, 12), Utc(6, 11, 12), Ct);

        Assert.Equal((D(6, 9), D(6, 12)), (built.From, built.To));
        Assert.Empty(built.Nights);
    }

    [Fact]
    public async Task NightBuilder_reads_a_night_over_a_gap_in_the_zone_on_its_side_of_the_midpoint()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>();
        // Six days from Oslo to Tokyo: the midpoint is 12:00Z on 13 June.
        await GapAsync(cs, Utc(6, 10, 12), Utc(6, 16, 12), "Europe/Oslo", "Asia/Tokyo");
        await StayAsync(cs, Utc(6, 16, 12), Utc(6, 17, 12), Spots.Tokyo, zone: "Asia/Tokyo");

        var built = await builder.BuildAsync(Utc(6, 10, 12), Utc(6, 15, 12), Ct);

        Assert.Equal(
            [
                (D(6, 10), "Europe/Oslo", Utc(6, 11, 1)),
                (D(6, 11), "Europe/Oslo", Utc(6, 12, 1)),
                (D(6, 12), "Europe/Oslo", Utc(6, 13, 1)),
                (D(6, 13), "Asia/Tokyo", Utc(6, 13, 18)),
                (D(6, 14), "Asia/Tokyo", Utc(6, 14, 18)),
                (D(6, 15), "Asia/Tokyo", Utc(6, 15, 18)),
                (D(6, 16), "Asia/Tokyo", Utc(6, 16, 18)), // the window reaches a day past the 15th
            ],
            built.Nights.Where(n => n.Night.Date >= D(6, 10)).Select(n => (n.Night.Date, n.Night.Zone, n.Night.InstantUtc)));
    }

    [Fact]
    public async Task NightBuilder_reads_a_night_between_stays_in_the_zone_of_the_nearer_one_within_36_hours()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>();
        await StayAsync(cs, Utc(6, 10, 8), Utc(6, 10, 20), Spots.Home);
        await StayAsync(cs, Utc(6, 14, 0), Utc(6, 15, 0), Spots.Tokyo, zone: "Asia/Tokyo");

        var built = await builder.BuildAsync(Utc(6, 10, 12), Utc(6, 13, 12), Ct);

        // Nights 10 and 11 follow the Oslo stay (7 and 31 hours after it ends); night 12 is too far from it and takes the
        // Tokyo stay that begins within 36 hours; nights 13 and 14 are in Tokyo, and only the last of them is covered by the stay.
        Assert.Equal(
            [
                (D(6, 9), "Europe/Oslo", "none"),
                (D(6, 10), "Europe/Oslo", "none"),
                (D(6, 11), "Europe/Oslo", "none"),
                (D(6, 12), "Asia/Tokyo", "none"),
                (D(6, 13), "Asia/Tokyo", "none"),
                (D(6, 14), "Asia/Tokyo", "stay"),
            ],
            built.Nights.Select(n => (n.Night.Date, n.Night.Zone, n.Source)));
    }

    [Fact]
    public async Task NightBuilder_leaves_out_a_night_with_no_segment_within_36_hours()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>();
        await StayAsync(cs, Utc(6, 10, 8), Utc(6, 10, 20), Spots.Home);
        await StayAsync(cs, Utc(6, 20, 8), Utc(6, 20, 20), Spots.Home);

        var built = await builder.BuildAsync(Utc(6, 12, 0), Utc(6, 16, 0), Ct);

        // No zone, so no instant to read the night at: it has no row, which the detectors count as an unknown night.
        Assert.Equal((D(6, 11), D(6, 17)), (built.From, built.To));
        Assert.Equal([D(6, 11)], built.Nights.Select(n => n.Night.Date));
    }

    [Fact]
    public async Task NightBuilder_leaves_a_night_unknown_when_the_nearest_point_is_not_on_the_globe()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>();
        await GapAsync(cs, Utc(6, 10, 18), Utc(6, 11, 8));
        await PointAsync(cs, Utc(6, 11, 1), new GeoPoint(91, 10)); // ingest stores whatever a client sends

        var built = await builder.BuildAsync(Utc(6, 10, 12), Utc(6, 11, 12), Ct);

        var (night, source) = NightOf(built, D(6, 10));
        Assert.Equal(("none", null), (source, night.Position));
    }

    [Fact]
    public async Task PointStore_nearest_takes_the_closer_side_and_the_earlier_on_a_tie()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var points = api.Services.GetRequiredService<PointStore>();
        foreach (var hour in new[] { 0, 2, 4 })
            await PointAsync(cs, Utc(6, 11, hour), Geo.Offset(Spots.Home, hour * 1000, 0));
        var window = TimeSpan.FromHours(12);

        async Task<DateTime?> NearestAsync(int hour, int minute)
            => (await points.NearestAsync(Utc(6, 11, hour, minute), window, Ct))?.TimeUtc;

        Assert.Equal(Utc(6, 11, 0), await NearestAsync(0, 30));  // 30 minutes after the first, 90 before the next
        Assert.Equal(Utc(6, 11, 2), await NearestAsync(1, 30));  // 90 minutes after the first, 30 before the next
        Assert.Equal(Utc(6, 11, 0), await NearestAsync(1, 0));   // an exact tie goes to the earlier point
        Assert.Equal(Utc(6, 11, 2), await NearestAsync(2, 0));   // a point at the instant itself is the nearest
        Assert.Equal(Utc(6, 11, 4), await NearestAsync(10, 0));  // nothing later: the one before
        Assert.Equal(Utc(6, 11, 0), (await points.NearestAsync(Utc(6, 10, 22), window, Ct))?.TimeUtc); // nothing earlier: the one after
    }

    [Fact]
    public async Task PointStore_nearest_looks_no_further_than_the_window_and_finds_nothing_in_an_empty_table()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var points = api.Services.GetRequiredService<PointStore>();
        var three = TimeSpan.FromHours(3);
        Assert.Null(await points.NearestAsync(Utc(6, 11, 10), three, Ct));
        await PointAsync(cs, Utc(6, 11, 10), Spots.Home);

        Assert.NotNull(await points.NearestAsync(Utc(6, 11, 7), three, Ct));                                    // exactly 3 h before it
        Assert.Null(await points.NearestAsync(Utc(6, 11, 7), three - TimeSpan.FromSeconds(1), Ct));
        Assert.NotNull(await points.NearestAsync(Utc(6, 11, 13), three, Ct));                                   // exactly 3 h after it
        Assert.Null(await points.NearestAsync(Utc(6, 11, 13), three - TimeSpan.FromSeconds(1), Ct));
    }

    [Fact]
    public async Task SegmentStore_covering_returns_what_overlaps_the_window_and_36_hours_beyond_in_time_order()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var segments = api.Services.GetRequiredService<SegmentStore>();
        // Window 10 to 12 June, so 12:00Z on the 8th to 12:00Z on the 13th. A segment that only touches an edge is outside.
        await StayAsync(cs, Utc(6, 12, 12), Utc(6, 13, 12), StayCentre);                 // ends exactly at the far edge: in
        await StayAsync(cs, Utc(6, 9, 0), Utc(6, 12, 12), StayCentre);                   // spans the window: in
        await StayAsync(cs, Utc(5, 1, 0), Utc(6, 8, 12), StayCentre);                    // ends exactly at the near edge: out
        await StayAsync(cs, Utc(6, 13, 12), Utc(6, 14, 0), StayCentre);                  // starts exactly at the far edge: out
        await TimelineSeeder.InsertSegmentAsync(cs, "move", Utc(6, 8, 12), Utc(6, 9, 0), D(6, 8), D(6, 9),
            "Europe/Oslo", "Europe/Lisbon", mode: "flight", distance: 1234.5, geometry: "[[10.1,59.1],[10.2,59.2]]", pointCount: 7);
        // A long stay that began weeks before the window and reaches into the one after it.
        await StayAsync(cs, Utc(6, 14, 0), Utc(7, 5, 0), StayCentre);

        var covering = await segments.FindCoveringAsync(Utc(6, 10, 0), Utc(6, 12, 0), Ct);

        Assert.Equal(
            [Utc(6, 8, 12), Utc(6, 9, 0), Utc(6, 12, 12)],
            covering.Select(s => s.StartUtc));
        // What a night needs, without the geometry that is most of a segment.
        Assert.Equal(
            new StoredSegment("move", Utc(6, 8, 12), Utc(6, 9, 0), "Europe/Oslo", "Europe/Lisbon", D(6, 8), D(6, 9), null, null, null,
                "flight", 1234.5, null, null, 7),
            covering[0]);

        var later = await segments.FindCoveringAsync(Utc(6, 20, 0), Utc(6, 21, 0), Ct);

        Assert.Equal([Utc(6, 14, 0)], later.Select(s => s.StartUtc)); // found by its end, though it started long before
    }

    [Fact]
    public async Task SegmentStore_stay_positions_are_the_stays_with_a_position_in_time_order()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var segments = api.Services.GetRequiredService<SegmentStore>();
        await StayAsync(cs, Utc(6, 11, 8), Utc(6, 11, 9), Spots.Cafe);
        await StayAsync(cs, Utc(6, 10, 8), Utc(6, 10, 9), Spots.Home);
        await TimelineSeeder.InsertSegmentAsync(cs, "stay", Utc(6, 12, 8), Utc(6, 12, 9), D(6, 12), D(6, 12)); // no position
        await TimelineSeeder.InsertSegmentAsync(cs, "move", Utc(6, 10, 9), Utc(6, 10, 10), D(6, 10), D(6, 10), lat: 59.5, lon: 10.5);

        var stays = await segments.LoadStayPositionsAsync(Ct);

        Assert.Equal(
            [new StayPosition(Utc(6, 10, 8), Utc(6, 10, 9), Spots.Home), new StayPosition(Utc(6, 11, 8), Utc(6, 11, 9), Spots.Cafe)],
            stays);
    }

    [Fact]
    public async Task PlaceStore_survivors_follow_merges_for_up_to_32_links()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var places = api.Services.GetRequiredService<PlaceStore>();
        var alone = await TimelineSeeder.InsertPlaceAsync(cs);
        var c = await TimelineSeeder.InsertPlaceAsync(cs);
        var b = await TimelineSeeder.InsertPlaceAsync(cs, mergedInto: c);
        var a = await TimelineSeeder.InsertPlaceAsync(cs, mergedInto: b);
        var e = await TimelineSeeder.InsertPlaceAsync(cs);
        var d = await TimelineSeeder.InsertPlaceAsync(cs, mergedInto: e);
        var g = await TimelineSeeder.InsertPlaceAsync(cs);
        var h = await TimelineSeeder.InsertPlaceAsync(cs, mergedInto: g);
        await Sql.ExecAsync(cs, "update place set merged_into_id = @h where id = @g", new { g, h }, Ct); // a cycle: no survivor
        var chain = new List<long> { await TimelineSeeder.InsertPlaceAsync(cs) }; // 34 places, each merged into the next
        for (var i = 1; i < 34; i++)
            chain.Insert(0, await TimelineSeeder.InsertPlaceAsync(cs, mergedInto: chain[0]));

        var survivors = await places.LoadSurvivorsAsync(Ct);

        // The first of the chain is 33 links from its end and has none; the second is 32 and has it.
        var expected = new Dictionary<long, long> { [a] = c, [b] = c, [d] = e };
        foreach (var link in chain.Skip(1).Take(32)) expected[link] = chain[33];
        Assert.Equal(expected.OrderBy(p => p.Key), survivors.OrderBy(p => p.Key));
        Assert.DoesNotContain(alone, survivors.Keys);
    }

    [Fact]
    public async Task PlaceStore_positions_are_those_of_the_places_asked_for()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var places = api.Services.GetRequiredService<PlaceStore>();
        var home = await TimelineSeeder.InsertPlaceAsync(cs, lat: Spots.Home.Latitude, lon: Spots.Home.Longitude);
        var merged = await TimelineSeeder.InsertPlaceAsync(cs, lat: Spots.Cafe.Latitude, lon: Spots.Cafe.Longitude, mergedInto: home);
        await TimelineSeeder.InsertPlaceAsync(cs, lat: Spots.Office.Latitude, lon: Spots.Office.Longitude); // not asked for

        var positions = await places.LoadPositionsAsync([home, merged, 999_999], Ct);

        Assert.Equal(
            new[] { (home, Spots.Home), (merged, Spots.Cafe) },
            positions.OrderBy(p => p.Key).Select(p => (p.Key, p.Value)));
        Assert.Empty(await places.LoadPositionsAsync([], Ct));
    }

    [Fact]
    public async Task NightStore_keeps_the_old_nights_when_an_insert_fails()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var store = api.Services.GetRequiredService<NightStore>();
        var old = new Night(D(6, 1), Utc(6, 2, 1), "Europe/Oslo", null, StayCentre);
        await store.ReplaceAsync(D(6, 1), D(6, 2), [(old, "stay")], Ct);

        var noSuchPlace = new Night(D(6, 2), Utc(6, 3, 1), "Europe/Oslo", 999_999, StayCentre);
        await Assert.ThrowsAsync<PostgresException>(() =>
            store.ReplaceAsync(D(6, 1), D(6, 2), [(noSuchPlace, "stay")], Ct));

        Assert.Equal([old], await store.LoadAllAsync(Ct)); // the delete went with it
    }
}
