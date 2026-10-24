using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Sporer.Api.Features.Timeline;
using Sporer.Testing;
using Sporer.Timeline;
using static Sporer.Api.Tests.TimelineSeeder;

namespace Sporer.Api.Tests;

[Collection("db")]
public class RangeEndpointTests(DatabaseFixture db)
{
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Every2min = TimeSpan.FromMinutes(2);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime Utc(int month, int day, int hour = 0, int minute = 0, int second = 0)
        => new(2026, month, day, hour, minute, second, DateTimeKind.Utc);

    private static DateOnly D(int month, int day) => new(2026, month, day);

    /// <summary>Home 1 h -> walk to the cafe -> cafe 25 min -> cycle to the office -> office 8 h, starting 07:00 UTC (09:00 in Oslo).</summary>
    private static List<TrackPoint> CommuteDay(int day) => new TrackBuilder(Utc(10, day, 7), Spots.Home)
        .Stay(TimeSpan.FromHours(1), Every2min)
        .Travel(Spots.Cafe, 5, Every10s)
        .Stay(TimeSpan.FromMinutes(25), Every2min)
        .Travel(Spots.Office, 18, Every10s)
        .Stay(TimeSpan.FromHours(8), Every2min)
        .Build();

    /// <summary>One stored segment as the tests see it; dates and times as the database holds them.</summary>
    private sealed record Stored(
        long Id, string Kind, DateTime StartUtc, DateTime EndUtc, long? PlaceId, string? Mode, double? DistanceM,
        string? GeometryCoarse, string LocalStartDate, string LocalEndDate);

    private static Task<IReadOnlyList<Stored>> StoredAsync(string cs) => Sql.QueryAsync<Stored>(cs,
        """
        select id as Id, kind as Kind, start_utc as StartUtc, end_utc as EndUtc, place_id as PlaceId, mode as Mode,
               distance_m as DistanceM, geometry_coarse::text as GeometryCoarse, local_start_date::text as LocalStartDate,
               local_end_date::text as LocalEndDate
        from segment order by start_utc, id
        """, ct: Ct);

    /// <summary>GETs a range, expects 200 and returns the parsed body (the caller disposes it).</summary>
    private static async Task<JsonDocument> GetRangeAsync(HttpClient client, string from, string to)
    {
        var response = await client.GetAsync($"/api/range?from={from}&to={to}", Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"GET /api/range?from={from}&to={to} returned {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text);
    }

    private static async Task<string> StateAsync(HttpClient client, string from, string to)
    {
        using var body = await GetRangeAsync(client, from, to);
        return body.RootElement.GetProperty("state").GetString()!;
    }

    private static DateTime Min(DateTime a, DateTime b) => a <= b ? a : b;

    private static DateTime Max(DateTime a, DateTime b) => a >= b ? a : b;

    private static long[] Ids(JsonElement array) => array.EnumerateArray().Select(e => e.GetProperty("id").GetInt64()).ToArray();

    private static double[][] Line(JsonElement geometry) => JsonSerializer.Deserialize<double[][]>(geometry.GetRawText())!;

    [Fact]
    public async Task Range_week_returns_moves_places_days_summary()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // starting the host runs the migrations
        // A commute on Sunday 11th and Monday 19th, either side of the week 12th to 18th, and on Mon, Tue and Thu within it.
        var track = new List<TrackPoint>();
        foreach (var day in new[] { 11, 12, 13, 15, 19 })
            track.AddRange(CommuteDay(day));
        await PointSeeder.InsertAsync(cs, track, Ct);
        await api.Services.GetRequiredService<ITimelineProcessor>().ReprocessAsync(Utc(10, 11), Utc(10, 20), Ct);
        var stored = await StoredAsync(cs);
        // The segments that touch the week by their local dates. Nothing logged between the end of one day's commute and the
        // start of the next, so the stay at the office runs on through the night: the one of Sunday the 11th reaches into
        // the week, and the one of Thursday the 15th lasts until Monday the 19th, past the end of it.
        var inWeek = stored.Where(s => string.CompareOrdinal(s.LocalStartDate, "2026-10-18") <= 0
                                       && string.CompareOrdinal(s.LocalEndDate, "2026-10-12") >= 0).ToList();

        using var body = await GetRangeAsync(client, "2026-10-12", "2026-10-18");

        var range = body.RootElement;
        Assert.Equal("2026-10-12", range.GetProperty("from").GetString());
        Assert.Equal("2026-10-18", range.GetProperty("to").GetString());
        Assert.Equal("done", range.GetProperty("state").GetString());

        // Moves: those of the three days, walk then cycle, in time order, as stored (the coarse line).
        var expectedMoves = inWeek.Where(s => s.Kind == "move").ToList();
        Assert.Equal(6, expectedMoves.Count);
        var moves = range.GetProperty("moves").EnumerateArray().ToList();
        Assert.Equal(expectedMoves.Select(m => m.Id), moves.Select(m => m.GetProperty("id").GetInt64()));
        Assert.Equal(new[] { "walk", "cycle", "walk", "cycle", "walk", "cycle" }, moves.Select(m => m.GetProperty("mode").GetString()));
        for (var k = 0; k < moves.Count; k++)
        {
            Assert.Equal(expectedMoves[k].StartUtc, moves[k].GetProperty("start").GetDateTime());
            Assert.Equal(expectedMoves[k].EndUtc, moves[k].GetProperty("end").GetDateTime());
            Assert.EndsWith("Z", moves[k].GetProperty("start").GetString());
            Assert.EndsWith("Z", moves[k].GetProperty("end").GetString());
            Assert.Equal(JsonSerializer.Deserialize<double[][]>(expectedMoves[k].GeometryCoarse!), Line(moves[k].GetProperty("geometry")));
            Assert.True(moves[k].GetProperty("geometry").GetArrayLength() >= 2);
        }

        // Places: home, cafe and office, the biggest time first. Nothing has named them. The time is what lies in the week in
        // Oslo, which is UTC+2 until the end of the month: from the 11th at 22:00 UTC to the 18th at 22:00 UTC.
        var (windowStart, windowEnd) = (Utc(10, 11, 22), Utc(10, 18, 22));
        var firstDay = stored.Where(s => s.Kind == "stay").Take(3).ToList();
        var (home, cafe, office) = (firstDay[0].PlaceId, firstDay[1].PlaceId, firstDay[2].PlaceId);
        Assert.Equal(3, new[] { home, cafe, office }.Distinct().Count());
        var stays = inWeek.Where(s => s.Kind == "stay").ToList();
        var places = range.GetProperty("places").EnumerateArray().ToList();
        Assert.Equal(new[] { office, home, cafe }, places.Select(p => (long?)p.GetProperty("id").GetInt64()));
        Assert.Equal(new[] { 4, 3, 3 }, places.Select(p => p.GetProperty("visits").GetInt32()));
        foreach (var place in places)
        {
            var id = place.GetProperty("id").GetInt64();
            var clipped = stays.Where(s => s.PlaceId == id)
                .Sum(s => (Min(s.EndUtc, windowEnd) - Max(s.StartUtc, windowStart)).TotalSeconds);
            Assert.Equal((long)Math.Round(clipped), place.GetProperty("seconds").GetInt64());
            var centre = await Sql.SingleAsync(cs, "select latitude, longitude from place where id = @id", new { id }, Ct);
            Assert.Equal((double)centre.latitude, place.GetProperty("lat").GetDouble());
            Assert.Equal((double)centre.longitude, place.GetProperty("lon").GetDouble());
            Assert.All(new[] { "name", "city", "country" }, name => Assert.Equal(JsonValueKind.Null, place.GetProperty(name).ValueKind));
        }
        Assert.True(places[0].GetProperty("seconds").GetInt64() > places[1].GetProperty("seconds").GetInt64());
        Assert.True(places[1].GetProperty("seconds").GetInt64() > places[2].GetProperty("seconds").GetInt64());
        // All the places together cannot have more time than the week has: no stay is counted past the week's edges.
        Assert.True(places.Sum(p => p.GetProperty("seconds").GetInt64()) <= (windowEnd - windowStart).TotalSeconds);

        // Days: only the days something starts on, with that day's moves and places.
        var days = range.GetProperty("days").EnumerateArray().ToList();
        Assert.Equal(new[] { "2026-10-12", "2026-10-13", "2026-10-15" }, days.Select(d => d.GetProperty("date").GetString()));
        foreach (var day in days)
        {
            var date = day.GetProperty("date").GetString();
            var dayMoves = expectedMoves.Where(m => m.LocalStartDate == date).ToList();
            Assert.Equal(2, dayMoves.Count);
            Assert.Equal(dayMoves.Sum(m => m.DistanceM!.Value), day.GetProperty("distanceMeters").GetDouble(), 6);
            Assert.Equal((long)Math.Round(dayMoves.Sum(m => (m.EndUtc - m.StartUtc).TotalSeconds)), day.GetProperty("movingSeconds").GetInt64());
            Assert.Equal(3, day.GetProperty("places").GetInt32());
        }

        // The summary adds up the week's moves, whole.
        var summary = range.GetProperty("summary");
        Assert.Equal(3, summary.GetProperty("places").GetInt32());
        Assert.Equal(6, summary.GetProperty("moves").GetInt32());
        Assert.Equal(expectedMoves.Sum(m => m.DistanceM!.Value), summary.GetProperty("distanceMeters").GetDouble(), 6);
        Assert.Equal((long)Math.Round(expectedMoves.Sum(m => (m.EndUtc - m.StartUtc).TotalSeconds)), summary.GetProperty("movingSeconds").GetInt64());
    }

    [Fact]
    public async Task Range_selects_by_local_dates_and_lists_the_days_something_starts_on()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        const string line = "[[10.75,59.92],[10.76,59.93]]";
        var (placeA, placeB, placeC, placeD, placeE, placeF) = (
            await InsertPlaceAsync(cs), await InsertPlaceAsync(cs), await InsertPlaceAsync(cs),
            await InsertPlaceAsync(cs), await InsertPlaceAsync(cs), await InsertPlaceAsync(cs));

        // Outside the range 12th to 14th: wholly before it (local dates), and wholly after it.
        await InsertSegmentAsync(cs, "move", Utc(10, 10, 8), Utc(10, 10, 9), D(10, 10), D(10, 10), mode: "walk", distance: 100, geometry: line);
        await InsertSegmentAsync(cs, "stay", Utc(10, 10, 9), Utc(10, 10, 12), D(10, 10), D(10, 10), placeId: placeE);
        await InsertSegmentAsync(cs, "move", Utc(10, 15, 8), Utc(10, 15, 9), D(10, 15), D(10, 15), mode: "walk", distance: 100, geometry: line);
        await InsertSegmentAsync(cs, "stay", Utc(10, 15, 9), Utc(10, 15, 12), D(10, 15), D(10, 15), placeId: placeE);

        // Begins before the range and reaches into it: counted in moves, places and summary, but starts on no day of the range.
        var m0 = await InsertSegmentAsync(cs, "move", Utc(10, 11, 21, 50), Utc(10, 11, 22, 10), D(10, 11), D(10, 12),
            mode: "drive", distance: 5000, geometry: line);
        // The night of the 11th (22:00 to 08:00 in Oslo): 8 h of it is on the 12th.
        await InsertSegmentAsync(cs, "stay", Utc(10, 11, 20), Utc(10, 12, 6), D(10, 11), D(10, 12), placeId: placeA);
        // Right across the range, from the 10th to the 16th: all of the range's 72 hours.
        await InsertSegmentAsync(cs, "stay", Utc(10, 10, 12), Utc(10, 16, 12), D(10, 10), D(10, 16), placeId: placeF);

        // The 12th: stays at B (twice) and C, a walk and a drive, and a gap.
        await InsertSegmentAsync(cs, "stay", Utc(10, 12, 7), Utc(10, 12, 9), D(10, 12), D(10, 12), placeId: placeB);
        var m1 = await InsertSegmentAsync(cs, "move", Utc(10, 12, 9), Utc(10, 12, 9, 10), D(10, 12), D(10, 12),
            mode: "walk", distance: 1000, geometry: line);
        await InsertSegmentAsync(cs, "stay", Utc(10, 12, 9, 10), Utc(10, 12, 10), D(10, 12), D(10, 12), placeId: placeC);
        var m2 = await InsertSegmentAsync(cs, "move", Utc(10, 12, 10), Utc(10, 12, 10, 20), D(10, 12), D(10, 12),
            mode: "drive", distance: 4500.5, geometry: line);
        await InsertSegmentAsync(cs, "gap", Utc(10, 12, 10, 20), Utc(10, 12, 10, 50), D(10, 12), D(10, 12), geometry: line);
        await InsertSegmentAsync(cs, "stay", Utc(10, 12, 11), Utc(10, 12, 12), D(10, 12), D(10, 12), placeId: placeB);

        // The 13th: nothing but a gap, which is still a segment that starts on the day.
        await InsertSegmentAsync(cs, "gap", Utc(10, 13, 6), Utc(10, 13, 8), D(10, 13), D(10, 13), geometry: line);

        // The 14th: a flight, and a stay that runs into the 15th (two hours of it are on the 14th).
        var m3 = await InsertSegmentAsync(cs, "move", Utc(10, 14, 12), Utc(10, 14, 15), D(10, 14), D(10, 14),
            "Asia/Tokyo", "Europe/Oslo", mode: "flight", distance: 3_000_000, geometry: "[[139.78,35.55],[10.75,59.92]]");
        await InsertSegmentAsync(cs, "stay", Utc(10, 14, 20), Utc(10, 15, 6), D(10, 14), D(10, 15), placeId: placeD);

        using var body = await GetRangeAsync(client, "2026-10-12", "2026-10-14");

        var range = body.RootElement;
        Assert.Equal(new[] { m0, m1, m2, m3 }, Ids(range.GetProperty("moves")));
        Assert.Equal("flight", range.GetProperty("moves")[3].GetProperty("mode").GetString());

        // Place by place, in the order of the time spent there: the whole range, the night of the 11th, B, the 14th, C.
        var places = range.GetProperty("places").EnumerateArray().ToList();
        Assert.Equal(new[] { placeF, placeA, placeB, placeD, placeC }, Ids(range.GetProperty("places")));
        Assert.Equal(new[] { 72 * 3600L, 8 * 3600L, 3 * 3600L, 2 * 3600L, 50 * 60L }, places.Select(p => p.GetProperty("seconds").GetInt64()));
        Assert.Equal(new[] { 1, 1, 2, 1, 1 }, places.Select(p => p.GetProperty("visits").GetInt32()));

        var days = range.GetProperty("days").EnumerateArray().ToList();
        Assert.Equal(new[] { "2026-10-12", "2026-10-13", "2026-10-14" }, days.Select(d => d.GetProperty("date").GetString()));
        Assert.Equal(new[] { 5500.5, 0, 3_000_000 }, days.Select(d => d.GetProperty("distanceMeters").GetDouble()));
        Assert.Equal(new[] { 30 * 60L, 0, 3 * 3600L }, days.Select(d => d.GetProperty("movingSeconds").GetInt64()));
        Assert.Equal(new[] { 2, 0, 1 }, days.Select(d => d.GetProperty("places").GetInt32()));

        // Whole values: the drive that began on the 11th counts, in full, for the range though not for a day of it.
        var summary = range.GetProperty("summary");
        Assert.Equal(5, summary.GetProperty("places").GetInt32());
        Assert.Equal(4, summary.GetProperty("moves").GetInt32());
        Assert.Equal(5000 + 1000 + 4500.5 + 3_000_000, summary.GetProperty("distanceMeters").GetDouble());
        Assert.Equal(20 * 60 + 10 * 60 + 20 * 60 + 3 * 3600L, summary.GetProperty("movingSeconds").GetInt64());
    }

    [Fact]
    public async Task Range_with_nothing_stored_is_empty_and_done()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        using var body = await GetRangeAsync(client, "2026-10-12", "2026-10-18");

        var range = body.RootElement;
        Assert.Equal("done", range.GetProperty("state").GetString());
        Assert.Empty(range.GetProperty("moves").EnumerateArray());
        Assert.Empty(range.GetProperty("places").EnumerateArray());
        Assert.Empty(range.GetProperty("days").EnumerateArray());
        var summary = range.GetProperty("summary");
        Assert.Equal(0, summary.GetProperty("places").GetInt32());
        Assert.Equal(0, summary.GetProperty("distanceMeters").GetDouble());
        Assert.Equal(0, summary.GetProperty("movingSeconds").GetInt64());
        Assert.Equal(0, summary.GetProperty("moves").GetInt32());
    }

    [Fact]
    public async Task Range_clips_overnight_stay_to_range_edges()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await InsertPlaceAsync(cs);
        // 22:00 to 08:00 the next morning in Oslo (UTC+2): ten hours across the midnight of the 22nd to the 23rd.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 20), Utc(10, 23, 6), D(10, 22), D(10, 23), placeId: home);

        var expected = new (string From, string To, long Seconds)[]
        {
            ("2026-10-22", "2026-10-22", 2 * 3600),  // the evening only
            ("2026-10-23", "2026-10-23", 8 * 3600),  // the morning only
            ("2026-10-22", "2026-10-23", 10 * 3600), // all of it
            ("2026-10-20", "2026-10-25", 10 * 3600), // all of it, with room to spare
        };
        foreach (var (from, to, seconds) in expected)
        {
            using var body = await GetRangeAsync(client, from, to);
            var place = Assert.Single(body.RootElement.GetProperty("places").EnumerateArray());
            Assert.Equal(home, place.GetProperty("id").GetInt64());
            Assert.True(seconds == place.GetProperty("seconds").GetInt64(), $"{from}..{to}: {place.GetProperty("seconds").GetInt64()} s, not {seconds}");
            Assert.Equal(1, place.GetProperty("visits").GetInt32());
        }
    }

    [Fact]
    public async Task Range_clips_in_the_zone_of_the_stay_across_clock_changes()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var autumn = await InsertPlaceAsync(cs);
        var spring = await InsertPlaceAsync(cs);
        var tokyo = await InsertPlaceAsync(cs);
        // The clocks go back in Oslo on 2026-10-25 at 01:00 UTC, so 22:00 on the 24th to 08:00 on the 25th is 11 hours, and
        // the 25th is a day of 25 hours: from 2026-10-24T22:00Z (UTC+2) to 2026-10-25T23:00Z (UTC+1).
        await InsertSegmentAsync(cs, "stay", Utc(10, 24, 20), Utc(10, 25, 7), D(10, 24), D(10, 25), placeId: autumn);
        // They go forward on 2026-03-29 at 01:00 UTC: 22:00 on the 28th to 08:00 on the 29th is 9 hours, in a day of 23.
        await InsertSegmentAsync(cs, "stay", Utc(3, 28, 21), Utc(3, 29, 6), D(3, 28), D(3, 29), placeId: spring);
        // Tokyo is UTC+9 with no change: 23:00 on the 22nd to 09:00 on the 23rd local time.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 14), Utc(10, 23, 0), D(10, 22), D(10, 23), "Asia/Tokyo", placeId: tokyo);

        var expected = new (string From, string To, long Place, long Seconds)[]
        {
            ("2026-10-24", "2026-10-24", autumn, 2 * 3600),
            ("2026-10-25", "2026-10-25", autumn, 9 * 3600),
            ("2026-10-24", "2026-10-25", autumn, 11 * 3600),
            ("2026-03-28", "2026-03-28", spring, 2 * 3600),
            ("2026-03-29", "2026-03-29", spring, 7 * 3600),
            ("2026-03-28", "2026-03-29", spring, 9 * 3600),
            ("2026-10-22", "2026-10-22", tokyo, 3600),
            ("2026-10-23", "2026-10-23", tokyo, 9 * 3600),
        };
        foreach (var (from, to, place, seconds) in expected)
        {
            using var body = await GetRangeAsync(client, from, to);
            var entry = Assert.Single(body.RootElement.GetProperty("places").EnumerateArray());
            Assert.Equal(place, entry.GetProperty("id").GetInt64());
            Assert.True(seconds == entry.GetProperty("seconds").GetInt64(), $"{from}..{to}: {entry.GetProperty("seconds").GetInt64()} s, not {seconds}");
        }
    }

    [Fact]
    public async Task Range_leaves_out_a_stay_that_ends_where_the_range_begins()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var evening = await InsertPlaceAsync(cs);
        var morning = await InsertPlaceAsync(cs);
        // Its last local date is the 22nd, because it ends at 00:00 on the 22nd, but none of its time is on that day.
        await InsertSegmentAsync(cs, "stay", Utc(10, 21, 20), Utc(10, 21, 22), D(10, 21), D(10, 22), placeId: evening);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: morning);

        using var body = await GetRangeAsync(client, "2026-10-22", "2026-10-22");

        var place = Assert.Single(body.RootElement.GetProperty("places").EnumerateArray());
        Assert.Equal(morning, place.GetProperty("id").GetInt64());
        Assert.Equal(1, body.RootElement.GetProperty("summary").GetProperty("places").GetInt32());
    }

    [Fact]
    public async Task Range_resolves_merged_places()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var survivor = await InsertPlaceAsync(cs, userName: "Survivor", osmName: "Survivor OSM", city: "Oslo", country: "Norway", lat: 59.5, lon: 10.5);
        var middle = await InsertPlaceAsync(cs, userName: "Middle", city: "Bergen", country: "Norway", lat: 60.1, lon: 5.3, mergedInto: survivor);
        var absorbed = await InsertPlaceAsync(cs, userName: "Absorbed", osmName: "Absorbed OSM", city: "Tromso", country: "Norway", lat: 69.6, lon: 18.9, mergedInto: middle);
        var other = await InsertPlaceAsync(cs, osmName: "Cafe Nord", city: "Oslo", country: "Norway", lat: 59.9, lon: 10.7);
        // One hour at the place that was merged into the middle one, two at the middle one, three at the survivor and one elsewhere.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: absorbed);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 8), Utc(10, 22, 10), D(10, 22), D(10, 22), placeId: middle);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 11), Utc(10, 22, 14), D(10, 22), D(10, 22), placeId: survivor);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 15), Utc(10, 22, 16), D(10, 22), D(10, 22), placeId: other);

        using var body = await GetRangeAsync(client, "2026-10-22", "2026-10-22");

        var places = body.RootElement.GetProperty("places").EnumerateArray().ToList();
        Assert.Equal(2, places.Count);
        Assert.Equal(survivor, places[0].GetProperty("id").GetInt64());
        Assert.Equal("Survivor", places[0].GetProperty("name").GetString()); // the owner's name wins over OpenStreetMap's
        Assert.Equal("Oslo", places[0].GetProperty("city").GetString());
        Assert.Equal("Norway", places[0].GetProperty("country").GetString());
        Assert.Equal(59.5, places[0].GetProperty("lat").GetDouble());
        Assert.Equal(10.5, places[0].GetProperty("lon").GetDouble());
        Assert.Equal(6 * 3600, places[0].GetProperty("seconds").GetInt64());
        Assert.Equal(3, places[0].GetProperty("visits").GetInt32());
        Assert.Equal(other, places[1].GetProperty("id").GetInt64());
        Assert.Equal("Cafe Nord", places[1].GetProperty("name").GetString());
        Assert.Equal(3600, places[1].GetProperty("seconds").GetInt64());
        Assert.DoesNotContain("Absorbed", body.RootElement.GetRawText());
        Assert.DoesNotContain("Middle", body.RootElement.GetRawText());

        // The summary and the day count the survivor once.
        Assert.Equal(2, body.RootElement.GetProperty("summary").GetProperty("places").GetInt32());
        Assert.Equal(2, Assert.Single(body.RootElement.GetProperty("days").EnumerateArray()).GetProperty("places").GetInt32());
    }

    [Fact]
    public async Task Range_leaves_out_stays_that_have_no_place_to_show()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var shown = await InsertPlaceAsync(cs, userName: "Shown");
        // Not something the app writes, but the schema allows it: a merge cycle leaves no place that survives.
        var first = await InsertPlaceAsync(cs, userName: "First");
        var second = await InsertPlaceAsync(cs, userName: "Second", mergedInto: first);
        await Sql.ExecAsync(cs, "update place set merged_into_id = @second where id = @first", new { first, second }, Ct);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: null);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 8), Utc(10, 22, 9), D(10, 22), D(10, 22), placeId: first);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 10), Utc(10, 22, 11), D(10, 22), D(10, 22), placeId: shown);

        using var body = await GetRangeAsync(client, "2026-10-22", "2026-10-22");

        var place = Assert.Single(body.RootElement.GetProperty("places").EnumerateArray());
        Assert.Equal(shown, place.GetProperty("id").GetInt64());
        Assert.Equal(1, place.GetProperty("visits").GetInt32());
        Assert.Equal(1, body.RootElement.GetProperty("summary").GetProperty("places").GetInt32());
        Assert.Equal(1, Assert.Single(body.RootElement.GetProperty("days").EnumerateArray()).GetProperty("places").GetInt32());
    }

    [Fact]
    public async Task Range_orders_places_by_time_then_by_id()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var (a, b, c, d) = (await InsertPlaceAsync(cs), await InsertPlaceAsync(cs), await InsertPlaceAsync(cs), await InsertPlaceAsync(cs));
        // The ids run against the time spent: a 1 h, b 2 h, c 2 h, d 3 h, added in the order d, c, b, a.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 9), D(10, 22), D(10, 22), placeId: d);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 10), Utc(10, 22, 12), D(10, 22), D(10, 22), placeId: c);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 13), Utc(10, 22, 15), D(10, 22), D(10, 22), placeId: b);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 16), Utc(10, 22, 17), D(10, 22), D(10, 22), placeId: a);

        using var body = await GetRangeAsync(client, "2026-10-22", "2026-10-22");

        Assert.Equal(new[] { d, b, c, a }, Ids(body.RootElement.GetProperty("places")));
    }

    [Fact]
    public async Task Range_rejects_invalid_or_too_long()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var first = new DateOnly(2026, 1, 1);
        string Text(DateOnly date) => date.ToString("yyyy-MM-dd");

        var invalid = new (string? From, string? To)[]
        {
            (null, null), (null, "2026-10-31"), ("2026-10-01", null), ("", ""), ("2026-10-01", ""),
            ("2026-1-5", "2026-10-31"), ("20261001", "20261031"), ("2026/10/01", "2026/10/31"), ("01-10-2026", "31-10-2026"),
            ("2026-02-30", "2026-03-05"), ("2026-13-01", "2026-13-02"), ("2026-10-01T00:00", "2026-10-31"),
            (" 2026-10-01", "2026-10-31"), ("2026-10-01", "2026-10-31 "), ("today", "tomorrow"),
            ("2026-10-31", "2026-10-01"),                  // the wrong way round
            (Text(first), Text(first.AddDays(400))),        // 401 days
            (Text(first), Text(first.AddDays(1000))),
            ("0001-01-01", "9999-12-31"),
        };
        foreach (var (from, to) in invalid)
        {
            var query = string.Join('&', new[]
            {
                from is null ? null : $"from={Uri.EscapeDataString(from)}",
                to is null ? null : $"to={Uri.EscapeDataString(to)}",
            }.Where(p => p is not null));
            var response = await client.GetAsync($"/api/range?{query}", Ct);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"{query} gave {(int)response.StatusCode}");
        }

        var noQuery = await client.GetAsync("/api/range", Ct);
        Assert.Equal(HttpStatusCode.BadRequest, noQuery.StatusCode);

        // 400 days, counting both ends, is the most; one day is the least.
        using var longest = await GetRangeAsync(client, Text(first), Text(first.AddDays(399)));
        Assert.Equal(Text(first.AddDays(399)), longest.RootElement.GetProperty("to").GetString());
        using var single = await GetRangeAsync(client, "2026-10-22", "2026-10-22");
        Assert.Equal("2026-10-22", single.RootElement.GetProperty("from").GetString());
    }

    [Fact]
    public async Task Range_at_the_ends_of_the_calendar_is_ok()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await InsertPlaceAsync(cs);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 9), D(10, 22), D(10, 22), placeId: place);

        foreach (var date in new[] { "0001-01-01", "9999-12-31" })
        {
            using var body = await GetRangeAsync(client, date, date);
            Assert.Equal(date, body.RootElement.GetProperty("from").GetString());
            Assert.Equal("done", body.RootElement.GetProperty("state").GetString());
            Assert.Empty(body.RootElement.GetProperty("places").EnumerateArray());
        }
    }

    [Fact]
    public async Task Range_pending_when_a_dirty_range_touches_its_span()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await InsertPlaceAsync(cs);
        await InsertSegmentAsync(cs, "stay", Utc(10, 11, 6), Utc(10, 11, 9), D(10, 11), D(10, 11), placeId: place);
        // The span of 2026-10-10..2026-10-12 is 2026-10-09T10:00Z (14 hours before the start) to 2026-10-13T14:00Z
        // (14 hours after the end): no zone reaches further.
        Assert.Equal("done", await StateAsync(client, "2026-10-10", "2026-10-12"));

        var outside = new (DateTime From, DateTime To)[]
        {
            (Utc(10, 9, 8), Utc(10, 9, 9, 59)),
            (Utc(10, 13, 14), Utc(10, 13, 15)),
            (Utc(10, 20, 8), Utc(10, 20, 9)),
        };
        foreach (var (from, to) in outside)
        {
            await InsertDirtyRangeAsync(cs, from, to);
            Assert.Equal("done", await StateAsync(client, "2026-10-10", "2026-10-12"));
            await Sql.ExecAsync(cs, "delete from dirty_range", ct: Ct);
        }

        var inside = new (DateTime From, DateTime To)[]
        {
            (Utc(10, 9, 9), Utc(10, 9, 10, 30)),   // reaches in from before the span
            (Utc(10, 11, 8), Utc(10, 11, 8, 30)),  // in the middle of it
            (Utc(10, 13, 13, 30), Utc(10, 13, 14, 30)), // reaches out past the end
        };
        foreach (var (from, to) in inside)
        {
            await InsertDirtyRangeAsync(cs, from, to);
            using var body = await GetRangeAsync(client, "2026-10-10", "2026-10-12");
            Assert.Equal("pending", body.RootElement.GetProperty("state").GetString());
            Assert.Single(body.RootElement.GetProperty("places").EnumerateArray()); // what is stored is still served
            await Sql.ExecAsync(cs, "delete from dirty_range", ct: Ct);
        }

        // A range that waits out a backoff after failing is unprocessed too.
        await InsertDirtyRangeAsync(cs, Utc(10, 11, 8), Utc(10, 11, 9), attempts: 3, nextAttemptAt: DateTime.UtcNow.AddHours(5));
        Assert.Equal("pending", await StateAsync(client, "2026-10-10", "2026-10-12"));
    }

    [Fact]
    public async Task Range_pending_while_backfill_behind()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // The span of 2026-10-10..2026-10-12 ends 2026-10-13T14:00Z.
        Assert.Equal("done", await StateAsync(client, "2026-10-10", "2026-10-12")); // no backfill recorded

        await SetBackfillAsync(cs, Utc(10, 1), Utc(10, 30), Utc(10, 1));
        Assert.Equal("pending", await StateAsync(client, "2026-10-10", "2026-10-12"));

        await SetBackfillAsync(cs, Utc(10, 1), Utc(10, 30), Utc(10, 11));
        Assert.Equal("pending", await StateAsync(client, "2026-10-10", "2026-10-12"));

        await SetBackfillAsync(cs, Utc(10, 1), Utc(10, 30), Utc(10, 13, 13, 59));
        Assert.Equal("pending", await StateAsync(client, "2026-10-10", "2026-10-12"));

        await SetBackfillAsync(cs, Utc(10, 1), Utc(10, 30), Utc(10, 13, 14));
        Assert.Equal("done", await StateAsync(client, "2026-10-10", "2026-10-12"));

        await SetBackfillAsync(cs, Utc(10, 1), Utc(10, 30), Utc(10, 25));
        Assert.Equal("done", await StateAsync(client, "2026-10-10", "2026-10-12"));

        // A backfill that has reached its end is complete, wherever its cursor stands.
        await SetBackfillAsync(cs, Utc(10, 1), Utc(10, 5), Utc(10, 5));
        Assert.Equal("done", await StateAsync(client, "2026-10-10", "2026-10-12"));
    }

    [Fact]
    public async Task Range_year_respects_vertex_budget()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        // 300 moves of 400 vertices each: 120 000, twice the budget. A line zig-zags across its base line by its own amplitude,
        // so how much of it a tolerance removes is known: nothing while the tolerance is below the amplitude, all but the
        // two ends from it. Five amplitudes, so that each doubling of the tolerance (100, 200, 400, 800 m) removes some moves'
        // lines and the budget is first met at 800 m, where only the two biggest amplitudes (40 % of the vertices) stay.
        const int moveCount = 300;
        const int vertices = 400;
        double[] amplitudes = [30, 250, 450, 900, 1800];
        var first = new DateOnly(2026, 1, 1);
        var stored = new List<double[][]>();
        var ids = new List<long>();
        for (var k = 0; k < moveCount; k++)
        {
            var line = ZigZag(vertices, amplitudes[k % amplitudes.Length]);
            stored.Add(line);
            var date = first.AddDays(k);
            ids.Add(await InsertSegmentAsync(cs, "move", date.ToDateTime(new TimeOnly(6, 0), DateTimeKind.Utc),
                date.ToDateTime(new TimeOnly(6, 30), DateTimeKind.Utc), date, date,
                mode: "drive", distance: 40_000, geometry: JsonSerializer.Serialize(line)));
        }
        Assert.Equal(moveCount * vertices, await Sql.ScalarAsync<long>(cs, "select sum(jsonb_array_length(geometry_coarse)) from segment", ct: Ct));

        using var body = await GetRangeAsync(client, "2026-01-01", "2026-12-31");

        var moves = body.RootElement.GetProperty("moves").EnumerateArray().ToList();
        Assert.Equal(ids, moves.Select(m => m.GetProperty("id").GetInt64()));
        var lines = moves.Select(m => Line(m.GetProperty("geometry"))).ToList();
        var total = lines.Sum(l => l.Length);
        Assert.InRange(total, 40_000, 60_000); // within the budget, and not simplified further than it needed
        for (var k = 0; k < moveCount; k++)
        {
            // Every line begins and ends where it did, and keeps only vertices it had, in their order.
            Assert.True(lines[k].Length >= 2);
            Assert.Equal(stored[k][0], lines[k][0]);
            Assert.Equal(stored[k][^1], lines[k][^1]);
            var at = 0;
            foreach (var point in lines[k])
            {
                while (at < stored[k].Length && !stored[k][at].SequenceEqual(point))
                    at++;
                Assert.True(at < stored[k].Length, $"Move {k} has a vertex that is not on its stored line, or out of order.");
                at++;
            }
        }

        // The stored lines are untouched: the budget is applied to the response.
        Assert.Equal(moveCount * vertices, await Sql.ScalarAsync<long>(cs, "select sum(jsonb_array_length(geometry_coarse)) from segment", ct: Ct));
        // The summary is of the moves, not of what is drawn.
        Assert.Equal(moveCount, body.RootElement.GetProperty("summary").GetProperty("moves").GetInt32());
        Assert.Equal(moveCount * 40_000.0, body.RootElement.GetProperty("summary").GetProperty("distanceMeters").GetDouble());

        // A range within the budget gets the stored lines as they are.
        using var january = await GetRangeAsync(client, "2026-01-01", "2026-01-10");
        var january1 = january.RootElement.GetProperty("moves").EnumerateArray().Select(m => Line(m.GetProperty("geometry"))).ToList();
        Assert.Equal(10, january1.Count);
        for (var k = 0; k < january1.Count; k++)
            Assert.Equal(stored[k], january1[k]);
    }

    /// <summary>
    /// A line of <paramref name="count"/> vertices, 100 m apart, east from a base point: the first and the last on the
    /// base line, the ones between alternately <paramref name="amplitudeMeters"/> north and as far south of it.
    /// </summary>
    private static double[][] ZigZag(int count, double amplitudeMeters)
    {
        var origin = new GeoPoint(59.9, 10.7);
        return Enumerable.Range(0, count).Select(k =>
        {
            var offset = k == 0 || k == count - 1 ? 0 : (k % 2 == 0 ? amplitudeMeters : -amplitudeMeters);
            var p = Geo.Offset(origin, offset, 100.0 * k);
            return new[] { Math.Round(p.Longitude, 6), Math.Round(p.Latitude, 6) };
        }).ToArray();
    }
}
