using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;
using Sporer.Api.Features.Timeline;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

[Collection("db")]
public partial class TimelineProcessorTests(DatabaseFixture db)
{
    private static readonly DateTime Day = new(2026, 10, 23, 0, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Every2min = TimeSpan.FromMinutes(2);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime T(int hour, int minute, int day = 0) => Day.AddDays(day).AddHours(hour).AddMinutes(minute);

    /// <summary>One row of <c>segment</c>; dates come back as text so the test does not depend on a driver's date type.</summary>
    private sealed record SegmentRow(
        long Id, string Kind, DateTime StartUtc, DateTime EndUtc, string StartTz, string EndTz,
        string LocalStartDate, string LocalEndDate, long? PlaceId, double? Latitude, double? Longitude,
        string? Mode, double? DistanceM, string? GeometryDetail, string? GeometryCoarse, int PointCount);

    private static Task<IReadOnlyList<SegmentRow>> SegmentsAsync(string cs) => Sql.QueryAsync<SegmentRow>(cs,
        """
        select id as Id, kind as Kind, start_utc as StartUtc, end_utc as EndUtc, start_tz as StartTz, end_tz as EndTz,
               local_start_date::text as LocalStartDate, local_end_date::text as LocalEndDate, place_id as PlaceId,
               latitude as Latitude, longitude as Longitude, mode as Mode, distance_m as DistanceM,
               geometry_detail::text as GeometryDetail, geometry_coarse::text as GeometryCoarse, point_count as PointCount
        from segment order by start_utc, id
        """, ct: Ct);

    /// <summary>Every column as one JSON text per row, optionally without the generated id.</summary>
    private static Task<IReadOnlyList<string>> RowsAsync(string cs, bool withId = false) => Sql.QueryAsync<string>(cs,
        $"select (to_jsonb(s){(withId ? "" : " - 'id'")})::text from segment s order by start_utc, id", ct: Ct);

    private static ITimelineProcessor Processor(ApiFactory api) => api.Services.GetRequiredService<ITimelineProcessor>();

    private static Task<long> CountAsync(string cs, string table) => Sql.ScalarAsync<long>(cs, $"select count(*) from {table}", ct: Ct);

    /// <summary>Home 1 h (every 2 min) -> walk to the cafe at 5 km/h -> cafe 25 min -> cycle to the office at 18 km/h -> office 8 h.</summary>
    private static List<TrackPoint> CommuteDay(int day = 0) => new TrackBuilder(T(7, 0, day), Spots.Home)
        .Stay(TimeSpan.FromHours(1), Every2min)
        .Travel(Spots.Cafe, 5, Every10s)
        .Stay(TimeSpan.FromMinutes(25), Every2min)
        .Travel(Spots.Office, 18, Every10s)
        .Stay(TimeSpan.FromHours(8), Every2min)
        .Build();

    private static double[][] Coordinates(string? json) => JsonSerializer.Deserialize<double[][]>(json!)!;

    [GeneratedRegex(@"\.\d{7,}")]
    private static partial Regex MoreThanSixDecimals();

    [Fact]
    public async Task Processes_a_commute_day()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        await PointSeeder.InsertAsync(cs, CommuteDay(), Ct);

        var written = await processor.ReprocessAsync(T(0, 0), T(0, 0, 1), Ct);

        var segments = await SegmentsAsync(cs);
        var kinds = segments.Select(s => s.Kind).ToArray();
        var stays = segments.Where(s => s.Kind == "stay").ToList();
        Assert.Equal(new[] { "stay", "move", "stay", "move", "stay" }, kinds);
        Assert.Equal(5, written);
        Assert.Equal(3, await Sql.ScalarAsync<long>(cs, "select count(*) from place", ct: Ct));
        Assert.All(stays, s => Assert.Equal("Europe/Oslo", s.StartTz));
    }

    [Fact]
    public async Task Stores_stays_and_moves_with_places_modes_and_geometry()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        await PointSeeder.InsertAsync(cs, CommuteDay(), Ct);

        await processor.ReprocessAsync(T(0, 0), T(0, 0, 1), Ct);

        var segments = await SegmentsAsync(cs);
        var (home, toCafe, cafe, toOffice, office) = (segments[0], segments[1], segments[2], segments[3], segments[4]);

        // Each segment starts where the previous one ends, in order.
        for (var k = 1; k < segments.Count; k++)
            Assert.Equal(segments[k - 1].EndUtc, segments[k].StartUtc);
        Assert.Equal(T(7, 0), home.StartUtc);

        // Stays: a distinct place each, the stay's centre, its points, local dates, no route data.
        Assert.Equal(3, new[] { home, cafe, office }.Select(s => s.PlaceId).Distinct().Count());
        Assert.All(new[] { home, cafe, office }, s =>
        {
            Assert.NotNull(s.PlaceId);
            Assert.Equal("Europe/Oslo", s.EndTz);
            Assert.Equal("2026-10-23", s.LocalStartDate);
            Assert.Equal("2026-10-23", s.LocalEndDate);
            Assert.True(s.PointCount > 0);
            Assert.Null(s.Mode);
            Assert.Null(s.DistanceM);
            Assert.Null(s.GeometryDetail);
            Assert.Null(s.GeometryCoarse);
        });
        Assert.True(Geo.DistanceMeters(new GeoPoint(home.Latitude!.Value, home.Longitude!.Value), Spots.Home) < 30);
        Assert.True(Geo.DistanceMeters(new GeoPoint(cafe.Latitude!.Value, cafe.Longitude!.Value), Spots.Cafe) < 30);
        Assert.True(Geo.DistanceMeters(new GeoPoint(office.Latitude!.Value, office.Longitude!.Value), Spots.Office) < 30);
        var place = await Sql.SingleAsync(cs, "select latitude, longitude from place where id = @id", new { id = office.PlaceId }, Ct);
        Assert.Equal(office.Latitude, (double)place.latitude);
        Assert.Equal(office.Longitude, (double)place.longitude);

        // Moves: classified, measured, with a line from one stay to the next. The stays take the first and last 100 m
        // around their place (the stay radius), so a move spans a little less than the way between the places.
        Assert.Equal("walk", toCafe.Mode);
        Assert.Equal("cycle", toOffice.Mode);
        var between = Geo.DistanceMeters(Spots.Home, Spots.Cafe);
        Assert.InRange(toCafe.DistanceM!.Value, between - 250, between - 1);
        Assert.All(new[] { toCafe, toOffice }, m =>
        {
            Assert.Null(m.PlaceId);
            Assert.True(m.PointCount > 2);
            Assert.Equal("Europe/Oslo", m.StartTz);
            Assert.Equal("Europe/Oslo", m.EndTz);
            Assert.Equal("2026-10-23", m.LocalStartDate);
        });
        var detail = Coordinates(toCafe.GeometryDetail);
        var coarse = Coordinates(toCafe.GeometryCoarse);
        Assert.True(Geo.DistanceMeters(new GeoPoint(detail[0][1], detail[0][0]), Spots.Home) <= 101);
        Assert.True(Geo.DistanceMeters(new GeoPoint(detail[^1][1], detail[^1][0]), Spots.Cafe) <= 101);
        Assert.Equal(2, detail.Length); // a straight walk simplifies to its two ends...
        Assert.True(detail.Length < toCafe.PointCount); // ...out of the points logged on the way
        Assert.Equal(detail, coarse);
        Assert.InRange(
            Geo.DistanceMeters(new GeoPoint(detail[0][1], detail[0][0]), new GeoPoint(detail[^1][1], detail[^1][0])),
            toCafe.DistanceM!.Value - 1, toCafe.DistanceM!.Value + 1);
        Assert.All(new[] { toCafe, toOffice }.SelectMany(m => new[] { m.GeometryDetail, m.GeometryCoarse }),
            json => Assert.DoesNotMatch(MoreThanSixDecimals(), json!));
    }

    [Fact]
    public async Task Reprocessing_is_idempotent()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        await PointSeeder.InsertAsync(cs, CommuteDay(), Ct);

        await processor.ReprocessAsync(T(0, 0), T(0, 0, 1), Ct);
        var rows = await RowsAsync(cs);
        var places = await Sql.QueryAsync<long>(cs, "select id from place order by id", ct: Ct);
        await processor.ReprocessAsync(T(0, 0), T(0, 0, 1), Ct);

        Assert.Equal(5, rows.Count);
        Assert.Equal(rows, await RowsAsync(cs)); // includes place_id
        Assert.Equal(places, await Sql.QueryAsync<long>(cs, "select id from place order by id", ct: Ct));
    }

    [Fact]
    public async Task Places_survive_reprocessing()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        await PointSeeder.InsertAsync(cs, CommuteDay(), Ct);
        await processor.ReprocessAsync(T(0, 0), T(0, 0, 1), Ct);
        var officePlace = (await SegmentsAsync(cs)).Last(s => s.Kind == "stay").PlaceId!.Value;
        await Sql.ExecAsync(cs, "update place set user_name = 'Mine' where id = @id", new { id = officePlace }, Ct);

        await processor.ReprocessAsync(T(0, 0), T(0, 0, 1), Ct);

        var office = (await SegmentsAsync(cs)).Last(s => s.Kind == "stay");
        Assert.Equal(officePlace, office.PlaceId);
        Assert.Equal("Mine", await Sql.ScalarAsync<string>(cs, "select user_name from place where id = @id", new { id = officePlace }, Ct));
        Assert.Equal(3, await CountAsync(cs, "place"));
    }

    [Fact]
    public async Task Middle_range_reprocess_keeps_neighbours()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        await PointSeeder.InsertAsync(cs, CommuteDay(0).Concat(CommuteDay(1)).Concat(CommuteDay(2)), Ct);
        await processor.ReprocessAsync(T(0, 0), T(0, 0, 3), Ct);
        var before = await SegmentsAsync(cs);
        var rowsBefore = await RowsAsync(cs);

        await processor.ReprocessAsync(T(0, 0, 1), T(0, 0, 2), Ct);

        var after = await SegmentsAsync(cs);
        Assert.True(before.Count > 8);
        Assert.Equal(rowsBefore, await RowsAsync(cs)); // same content (ignoring ids)
        // The anchors are the day-1 office stay and the first day-3 stay: what lies outside keeps its rows (ids too)...
        Assert.Equal(before.Take(4), after.Take(4));
        Assert.Equal(before.TakeLast(4), after.TakeLast(4));
        // ...and what lies between was rewritten.
        Assert.All(after.Skip(4).Take(after.Count - 8), s => Assert.True(s.Id > before.Max(b => b.Id)));
        for (var k = 1; k < after.Count; k++)
            Assert.True(after[k].StartUtc >= after[k - 1].EndUtc - TimeSpan.FromSeconds(1), $"segment {k} overlaps the one before");
    }

    [Fact]
    public async Task Anchors_widen_to_the_stay_before_the_range_unless_a_floor_stops_them()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var store = api.Services.GetRequiredService<SegmentStore>(); // starting the host runs the migrations
        await Sql.ExecAsync(cs,
            """
            insert into segment (kind, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date)
            values ('stay', @s1, @e1, 'UTC', 'UTC', '2026-10-23', '2026-10-23'),
                   ('stay', @s2, @e2, 'UTC', 'UTC', '2026-10-23', '2026-10-23'),
                   ('stay', @s3, @e3, 'UTC', 'UTC', '2026-10-23', '2026-10-23')
            """,
            new { s1 = T(2, 0), e1 = T(4, 0), s2 = T(6, 0), e2 = T(8, 0), s3 = T(20, 0), e3 = T(22, 0) }, Ct);
        var (from, to) = (T(12, 0), T(14, 0));

        // No floor: the last stay before the range starts the rebuild, the first stay after it ends it.
        Assert.Equal((T(6, 0), T(22, 0)), await store.FindAnchorsAsync(from, to, Ct));
        // A floor after that stay's start moves the start up to it; one at or before the stay's start changes nothing.
        Assert.Equal((T(10, 0), T(22, 0)), await store.FindAnchorsAsync(from, to, Ct, T(10, 0)));
        Assert.Equal((T(6, 0), T(22, 0)), await store.FindAnchorsAsync(from, to, Ct, T(6, 0)));
        Assert.Equal((T(6, 0), T(22, 0)), await store.FindAnchorsAsync(from, to, Ct, T(5, 0)));
        // The rebuild never starts after the range: a floor past the start of the range is the start of the range.
        Assert.Equal((from, T(22, 0)), await store.FindAnchorsAsync(from, to, Ct, T(13, 0)));
        // With no stay before the range the rebuild starts at the range, floor or not.
        Assert.Equal((T(1, 0), T(4, 0)), await store.FindAnchorsAsync(T(1, 0), T(1, 30), Ct));
        Assert.Equal((T(1, 0), T(4, 0)), await store.FindAnchorsAsync(T(1, 0), T(1, 30), Ct, T(0, 30)));
    }

    [Fact]
    public async Task A_floor_keeps_the_rebuild_from_reaching_back_into_an_unprocessed_week()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        await PointSeeder.InsertAsync(cs, Enumerable.Range(0, 21).SelectMany(day => CommuteDay(day)), Ct);
        await processor.ReprocessAsync(T(7, 0), T(7, 0, 7), Ct); // week 1; week 2 is not processed
        var segmentsInWeek2 = () => Sql.ScalarAsync<long>(cs,
            "select count(*) from segment where start_utc >= @from and start_utc < @to", new { from = T(0, 0, 8), to = T(7, 0, 14) }, Ct);
        Assert.Equal(0, await segmentsInWeek2());

        // Week 3 with a floor at its start: nothing of week 2 is loaded, so nothing of week 2 is stored...
        var written = await processor.ReprocessAsync(T(7, 0, 14), T(7, 0, 21), Ct, anchorFloorUtc: T(7, 0, 14));
        Assert.True(written > 0);
        Assert.Equal(0, await segmentsInWeek2());
        Assert.Equal(T(7, 0, 14), await Sql.ScalarAsync<DateTime>(cs, "select min(start_utc) from segment where start_utc >= @from",
            new { from = T(0, 0, 8) }, Ct)); // ...and week 3 starts at its own first point
        Assert.Equal(7 * 3, await Sql.ScalarAsync<long>(cs,
            "select count(*) from segment where kind = 'stay' and start_utc >= @from and start_utc < @to", new { from = T(7, 0, 14), to = T(0, 0, 21) }, Ct));

        // ...whereas without one it is widened back to the last stay of week 1, and rebuilds week 2 on the way.
        await processor.ReprocessAsync(T(7, 0, 14), T(7, 0, 21), Ct);
        Assert.True(await segmentsInWeek2() > 0);
    }

    /// <summary>
    /// The rows of <c>segment</c> without ids, with place ids replaced by the order places first appear in: two runs agree
    /// when they put the same stays in the same places, even if a place's centre differs by a few metres (a place is
    /// created from the first stay that needs it, which a chunk edge may have cut short).
    /// </summary>
    private static async Task<IReadOnlyList<string>> CanonicalRowsAsync(string cs)
    {
        var rows = await Sql.QueryAsync(cs,
            "select (to_jsonb(s) - 'id' - 'place_id')::text as json, place_id from segment s order by start_utc, id", ct: Ct);
        var ordinals = new Dictionary<long, int>();
        return rows.Select(r =>
        {
            if ((long?)r.place_id is not { } id)
                return $"{(string)r.json} no place";
            if (!ordinals.TryGetValue(id, out var ordinal))
                ordinals[id] = ordinal = ordinals.Count;
            return $"{(string)r.json} place#{ordinal}";
        }).ToList();
    }

    private static List<TrackPoint> FiveCommuteDays()
        => [.. Enumerable.Range(0, 5).SelectMany(day => CommuteDay(day))];

    /// <summary>Processes the days in the given oldest-first chunks on one database and in one run on another; the rows must agree.</summary>
    private async Task AssertChunksMatchFullRunAsync(IReadOnlyList<DateTime> edges)
    {
        var track = FiveCommuteDays();

        var fullCs = await db.CreateDatabaseAsync(Ct);
        await using var fullApi = new ApiFactory(fullCs);
        var full = Processor(fullApi);
        await PointSeeder.InsertAsync(fullCs, track, Ct);
        await full.ReprocessAsync(edges[0], edges[^1], Ct);

        var chunkedCs = await db.CreateDatabaseAsync(Ct);
        await using var chunkedApi = new ApiFactory(chunkedCs);
        var chunked = Processor(chunkedApi);
        await PointSeeder.InsertAsync(chunkedCs, track, Ct);
        for (var k = 0; k + 1 < edges.Count; k++)
            await chunked.ReprocessAsync(edges[k], edges[k + 1], Ct);

        var expected = await CanonicalRowsAsync(fullCs);
        Assert.True(expected.Count > 25, "five commute days should give plenty of segments");
        Assert.Equal(expected, await CanonicalRowsAsync(chunkedCs));
        Assert.Equal(await CountAsync(fullCs, "place"), await CountAsync(chunkedCs, "place"));
    }

    [Fact] // edges mid-stay overnight (03:00), mid-stay at home (07:30), mid-cycle (08:42) and mid-gap (06:30)
    public async Task Oldest_first_chunks_with_edges_inside_stays_and_moves_match_a_full_run()
        => await AssertChunksMatchFullRunAsync([T(0, 0), T(3, 0, 1), T(7, 30, 2), T(8, 42, 3), T(6, 30, 4), T(0, 0, 5)]);

    [Fact] // 26 chunks of 4 h 37 min: edges land everywhere, including mid-walk and in the middle of a cafe stay
    public async Task Oldest_first_irregular_chunks_match_a_full_run()
        => await AssertChunksMatchFullRunAsync(
            [.. Enumerable.Range(0, 27).Select(k => T(0, 0).AddMinutes(k * 277)).Append(T(0, 0, 6))]);

    [Fact]
    public async Task Without_a_later_stay_only_the_range_and_the_next_point_are_loaded()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        await PointSeeder.InsertAsync(cs, FiveCommuteDays(), Ct); // data goes on for days after the range

        // 12:00 is in the middle of the first office stay (08:47 to 16:47).
        await processor.ReprocessAsync(T(0, 0), T(12, 0), Ct);

        var firstAfter = await Sql.ScalarAsync<DateTime>(cs,
            "select min(time) from locationlog where time > @to", new { to = T(12, 0) }, Ct);
        Assert.InRange(firstAfter, T(12, 0), T(12, 3));
        var segments = await SegmentsAsync(cs);
        Assert.Equal(new[] { "stay", "move", "stay", "move", "stay" }, segments.Select(s => s.Kind));
        Assert.Equal(firstAfter, segments[^1].EndUtc); // the office stay is cut at the next point, not carried to the end of the data
        Assert.DoesNotContain(segments, s => s.StartUtc > firstAfter);
    }

    [Fact]
    public async Task Late_point_inside_a_stored_move_does_not_leave_a_hole_after_it()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        // Home 06:00 to 09:00, then a drive east at 40 km/h until 12:30; no stay after it.
        var track = new TrackBuilder(T(6, 0), Spots.Home)
            .Stay(TimeSpan.FromHours(3), Every2min)
            .Travel(Geo.Offset(Spots.Home, 0, 140_000), 40, TimeSpan.FromSeconds(30))
            .Build();
        await PointSeeder.InsertAsync(cs, track, Ct);
        await processor.ReprocessAsync(T(0, 0), T(23, 0), Ct);
        var stored = await SegmentsAsync(cs);
        Assert.Equal(new[] { "stay", "move" }, stored.Select(s => s.Kind));
        Assert.Equal(track[^1].TimeUtc, stored[^1].EndUtc);
        Assert.InRange(stored[^1].EndUtc, T(12, 29), T(12, 31));

        // A second device reports a fix on the road at 10:00:15, long after the data was processed.
        var onTheRoad = track.First(p => p.TimeUtc > T(10, 0).AddSeconds(15)) with { Device = "watch", TimeUtc = T(10, 0).AddSeconds(15) };
        await PointSeeder.InsertAsync(cs, [onTheRoad], Ct);
        await processor.ReprocessAsync(T(10, 0), T(10, 0), Ct);

        var after = await SegmentsAsync(cs);
        Assert.Equal(new[] { "stay", "move" }, after.Select(s => s.Kind));
        Assert.Equal(stored[0].StartUtc, after[0].StartUtc);
        Assert.Equal(track[^1].TimeUtc, after[^1].EndUtc); // rebuilt through the end of what was stored, not just up to 10:00
        Assert.Equal(stored[^1].StartUtc, after[^1].StartUtc);
    }

    [Fact]
    public async Task Stay_crossing_midnight_has_two_local_dates()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        // Home 21:00Z -> 06:00Z next day, which is 23:00 -> 08:00 in Oslo (UTC+2 until the 25th).
        var track = new TrackBuilder(T(21, 0), Spots.Home).Stay(TimeSpan.FromHours(9), TimeSpan.FromMinutes(10)).Build();
        await PointSeeder.InsertAsync(cs, track, Ct);

        await processor.ReprocessAsync(T(0, 0), T(12, 0, 1), Ct);

        var stay = Assert.Single(await SegmentsAsync(cs));
        Assert.Equal("stay", stay.Kind);
        Assert.Equal(T(21, 0), stay.StartUtc);
        Assert.Equal(T(6, 0, 1), stay.EndUtc);
        Assert.Equal("2026-10-23", stay.LocalStartDate);
        Assert.Equal("2026-10-24", stay.LocalEndDate);
    }

    [Fact]
    public async Task Locationlog_is_never_modified()
    {
        const string checksum =
            "select count(*)::text || ':' || md5(string_agg(l::text || '/' || l.xmin::text, '|' order by l.time, l.device)) from locationlog l";
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        await PointSeeder.InsertAsync(cs, CommuteDay(0).Concat(CommuteDay(1)), Ct);
        var before = await Sql.ScalarAsync<string>(cs, checksum, ct: Ct);
        Assert.StartsWith($"{CommuteDay(0).Count + CommuteDay(1).Count}:", before);

        await processor.ReprocessAsync(T(0, 0), T(0, 0, 2), Ct);
        await processor.ReprocessAsync(T(0, 0, 1), T(0, 0, 2), Ct);

        Assert.True(await CountAsync(cs, "segment") > 0);
        Assert.Equal(before, await Sql.ScalarAsync<string>(cs, checksum, ct: Ct)); // same rows, same row versions
    }

    [Fact]
    public async Task Flights_are_great_circle_arcs_between_time_zones()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromHours(1), Every2min)
            .Teleport(Spots.Lisbon, TimeSpan.FromHours(4))
            .Stay(TimeSpan.FromHours(1), Every2min)
            .Build();
        await PointSeeder.InsertAsync(cs, track, Ct);

        await processor.ReprocessAsync(T(0, 0), T(0, 0, 1), Ct);

        var segments = await SegmentsAsync(cs);
        Assert.Equal(new[] { "stay", "move", "stay" }, segments.Select(s => s.Kind));
        var flight = segments[1];
        Assert.Equal("flight", flight.Mode);
        Assert.Equal(("Europe/Oslo", "Europe/Lisbon"), (flight.StartTz, flight.EndTz));
        Assert.Equal(("Europe/Oslo", "Europe/Lisbon"), (segments[0].StartTz, segments[2].StartTz));
        Assert.Equal(Geo.DistanceMeters(Spots.Home, Spots.Lisbon), flight.DistanceM!.Value, 1);
        Assert.Equal(flight.GeometryDetail, flight.GeometryCoarse);
        var arc = Coordinates(flight.GeometryDetail);
        Assert.Equal(64, arc.Length);
        Assert.Equal([Math.Round(Spots.Home.Longitude, 6), Math.Round(Spots.Home.Latitude, 6)], arc[0]);
        Assert.Equal([Math.Round(Spots.Lisbon.Longitude, 6), Math.Round(Spots.Lisbon.Latitude, 6)], arc[^1]);
        Assert.Equal(2, await CountAsync(cs, "place"));
    }

    [Fact]
    public async Task Gaps_keep_the_positions_either_side()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        var from = Geo.Offset(Spots.Home, 0, 5_000);
        var to = Geo.Offset(Spots.Home, 0, 45_000);
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Travel(from, 50, Every10s)
            .Teleport(to, TimeSpan.FromHours(2))
            .Travel(Geo.Offset(Spots.Home, 0, 50_000), 50, Every10s)
            .Build();
        await PointSeeder.InsertAsync(cs, track, Ct);

        await processor.ReprocessAsync(T(0, 0), T(0, 0, 1), Ct);

        var segments = await SegmentsAsync(cs);
        Assert.Equal(new[] { "move", "gap", "move" }, segments.Select(s => s.Kind));
        var gap = segments[1];
        Assert.Equal(TimeSpan.FromHours(2), gap.EndUtc - gap.StartUtc);
        Assert.Equal(("Europe/Oslo", "Europe/Oslo"), (gap.StartTz, gap.EndTz));
        Assert.Equal((null, null, null, 0), (gap.Mode, gap.PlaceId, gap.DistanceM, gap.PointCount));
        var ends = Coordinates(gap.GeometryDetail);
        Assert.Equal(2, ends.Length);
        Assert.Equal([Math.Round(from.Longitude, 6), Math.Round(from.Latitude, 6)], ends[0]);
        Assert.Equal([Math.Round(to.Longitude, 6), Math.Round(to.Latitude, 6)], ends[1]);
        Assert.Equal(gap.GeometryDetail, gap.GeometryCoarse);
        Assert.Equal(0, await CountAsync(cs, "place"));
    }

    [Fact]
    public async Task Moves_that_take_no_time_are_not_stored()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        // The phone's last point at home and the watch's first point at the cafe share one timestamp, so the "move"
        // between the two stays has no duration.
        var track = new TrackBuilder(T(8, 0), Spots.Home, "phone").Stay(TimeSpan.FromHours(1), Every2min).Build()
            .Concat(new TrackBuilder(T(9, 0), Spots.Cafe, "watch").Stay(TimeSpan.FromHours(1), Every2min).Build());
        await PointSeeder.InsertAsync(cs, track, Ct);

        var written = await processor.ReprocessAsync(T(0, 0), T(0, 0, 1), Ct);

        var segments = await SegmentsAsync(cs);
        Assert.Equal(new[] { "stay", "stay" }, segments.Select(s => s.Kind));
        Assert.Equal(2, written);
        Assert.Equal(segments[0].EndUtc, segments[1].StartUtc);
        Assert.Equal(0, await Sql.ScalarAsync<long>(cs, "select count(*) from segment where kind <> 'stay' and end_utc <= start_utc", ct: Ct));
    }

    [Fact]
    public async Task Stay_at_an_impossible_position_gets_no_place()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        // Ingest stores whatever a client sends; the place matcher rejects a latitude of 95, which must not fail the range.
        await PointSeeder.InsertAsync(cs, new TrackBuilder(T(8, 0), new GeoPoint(95, 10)).Stay(TimeSpan.FromMinutes(30), Every2min).Build(), Ct);

        var written = await processor.ReprocessAsync(T(0, 0), T(0, 0, 1), Ct);

        var stay = Assert.Single(await SegmentsAsync(cs));
        Assert.Equal(1, written);
        Assert.Equal("stay", stay.Kind);
        Assert.Null(stay.PlaceId);
        Assert.Equal(0, await CountAsync(cs, "place"));
    }

    [Fact]
    public async Task Range_without_an_earlier_stay_starts_at_from()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations
        await PointSeeder.InsertAsync(cs, CommuteDay(), Ct);

        // Nothing was processed before: no stay precedes 09:00, so the run starts at the first point from 09:00 on.
        await processor.ReprocessAsync(T(9, 0), T(10, 0), Ct);

        var stay = Assert.Single(await SegmentsAsync(cs));
        Assert.Equal("stay", stay.Kind);
        Assert.InRange(stay.StartUtc, T(9, 0), T(9, 5));
        Assert.True(Geo.DistanceMeters(new GeoPoint(stay.Latitude!.Value, stay.Longitude!.Value), Spots.Office) < 30);
        Assert.Equal(1, await CountAsync(cs, "place"));
    }

    [Fact]
    public async Task Range_without_points_writes_nothing()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations

        var written = await processor.ReprocessAsync(T(0, 0), T(0, 0, 1), Ct);

        Assert.Equal(0, written);
        Assert.Equal(0, await CountAsync(cs, "segment"));
        Assert.Equal(0, await CountAsync(cs, "place"));
    }

    [Fact]
    public async Task Range_ending_before_it_starts_is_rejected()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var processor = Processor(api); // starting the host runs the migrations

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => processor.ReprocessAsync(T(0, 0, 1), T(0, 0), Ct));
    }

    [Fact]
    public async Task Uses_the_configured_detection_options()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        // Home and the cafe are about 1 km apart: one place when places match within 1.5 km.
        await using var api = new ApiFactory(cs, new Dictionary<string, string?> { ["Detection:PlaceRadiusMeters"] = "1500" });
        var processor = Processor(api); // starting the host runs the migrations
        await PointSeeder.InsertAsync(cs, CommuteDay(), Ct);

        await processor.ReprocessAsync(T(0, 0), T(0, 0, 1), Ct);

        var options = api.Services.GetRequiredService<DetectionOptions>();
        Assert.Equal(1500, options.PlaceRadiusMeters);
        Assert.Equal(100, options.MaxAccuracyMeters); // the rest keeps the spec's defaults
        var stays = (await SegmentsAsync(cs)).Where(s => s.Kind == "stay").ToList();
        Assert.Equal(stays[0].PlaceId, stays[1].PlaceId);
        Assert.Equal(2, await CountAsync(cs, "place"));
    }
}
