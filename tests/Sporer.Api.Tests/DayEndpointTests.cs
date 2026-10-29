using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Sporer.Api.Features.Timeline;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

[Collection("db")]
public class DayEndpointTests(DatabaseFixture db)
{
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Every2min = TimeSpan.FromMinutes(2);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime Utc(int month, int day, int hour = 0, int minute = 0, int second = 0)
        => new(2026, month, day, hour, minute, second, DateTimeKind.Utc);

    private static DateOnly D(int month, int day) => new(2026, month, day);

    /// <summary>Home 1 h -> walk to the cafe -> cafe 25 min -> cycle to the office -> office 8 h, starting 07:00 UTC on 2026-10-23.</summary>
    private static List<TrackPoint> CommuteDay() => new TrackBuilder(Utc(10, 23, 7), Spots.Home)
        .Stay(TimeSpan.FromHours(1), Every2min)
        .Travel(Spots.Cafe, 5, Every10s)
        .Stay(TimeSpan.FromMinutes(25), Every2min)
        .Travel(Spots.Office, 18, Every10s)
        .Stay(TimeSpan.FromHours(8), Every2min)
        .Build();

    /// <summary>One stored segment as the tests see it; dates and times as the database holds them.</summary>
    private sealed record Stored(long Id, string Kind, DateTime StartUtc, DateTime EndUtc, long? PlaceId, double? DistanceM, string? GeometryDetail);

    private sealed record LocalDates(string Kind, string StartTz, string EndTz, string LocalStartDate, string LocalEndDate);

    private static Task<IReadOnlyList<Stored>> StoredAsync(string cs) => Sql.QueryAsync<Stored>(cs,
        """
        select id as Id, kind as Kind, start_utc as StartUtc, end_utc as EndUtc, place_id as PlaceId,
               distance_m as DistanceM, geometry_detail::text as GeometryDetail
        from segment order by start_utc, id
        """, ct: Ct);

    /// <summary>GETs a day, expects 200 and returns the parsed body (the caller disposes it).</summary>
    private static async Task<JsonDocument> GetDayAsync(HttpClient client, string date)
    {
        var response = await client.GetAsync($"/api/day/{date}", Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"GET /api/day/{date} returned {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text);
    }

    private static async Task<string> StateAsync(HttpClient client, string date)
    {
        using var body = await GetDayAsync(client, date);
        return body.RootElement.GetProperty("state").GetString()!;
    }

    private static string[] Kinds(JsonElement day) => day.GetProperty("segments").EnumerateArray().Select(s => s.GetProperty("kind").GetString()!).ToArray();

    private static Task<long> InsertPlaceAsync(
        string cs, string? userName = null, string? osmName = null, string? city = null, string? country = null,
        double lat = 59.92, double lon = 10.75, long? mergedInto = null) => Sql.ScalarAsync<long>(cs,
        """
        insert into place (latitude, longitude, osm_name, city, country, user_name, merged_into_id, geocode_state)
        values (@lat, @lon, @osmName, @city, @country, @userName, @mergedInto, 'done') returning id
        """,
        new { lat, lon, osmName, city, country, userName, mergedInto }, Ct);

    private static Task<long> InsertSegmentAsync(
        string cs, string kind, DateTime start, DateTime end, DateOnly localStart, DateOnly localEnd,
        string startTz = "Europe/Oslo", string? endTz = null, long? placeId = null, string? mode = null,
        double? distance = null, string? geometry = null) => Sql.ScalarAsync<long>(cs,
        """
        insert into segment (kind, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date, place_id,
                             mode, distance_m, geometry_detail, geometry_coarse)
        values (@kind, @start, @end, @startTz, @endTz, @localStart, @localEnd, @placeId,
                @mode, @distance, @geometry::jsonb, @geometry::jsonb) returning id
        """,
        new { kind, start, end, startTz, endTz = endTz ?? startTz, localStart, localEnd, placeId, mode, distance, geometry }, Ct);

    private static Task InsertDirtyRangeAsync(string cs, DateTime from, DateTime to, int attempts = 0, DateTime? nextAttemptAt = null)
        => Sql.ExecAsync(cs,
            "insert into dirty_range (from_utc, to_utc, attempts, next_attempt_at, last_error) values (@from, @to, @attempts, @nextAttemptAt, @error)",
            new { from, to, attempts, nextAttemptAt, error = attempts > 0 ? "boom" : null }, Ct);

    private static Task SetBackfillAsync(string cs, DateTime? from, DateTime? to, DateTime? cursor) => Sql.ExecAsync(cs,
        "update processing_state set backfill_from = @from, backfill_to = @to, backfill_cursor = @cursor where id = 1",
        new { from, to, cursor }, Ct);

    /// <summary>A stay at home on 2026-10-22 local time (Oslo), so the day has a known zone.</summary>
    private static Task<long> InsertOctober22StayAsync(string cs) =>
        InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 9), D(10, 22), D(10, 22));

    [Fact]
    public async Task Day_returns_commute_in_order()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // starting the host runs the migrations
        await PointSeeder.InsertAsync(cs, CommuteDay(), Ct);
        await api.Services.GetRequiredService<ITimelineProcessor>().ReprocessAsync(Utc(10, 23), Utc(10, 24), Ct);
        var stored = await StoredAsync(cs);

        using var body = await GetDayAsync(client, "2026-10-23");

        var day = body.RootElement;
        Assert.Equal("2026-10-23", day.GetProperty("date").GetString());
        Assert.Equal("Europe/Oslo", day.GetProperty("timeZone").GetString());
        Assert.Equal("done", day.GetProperty("state").GetString());
        Assert.Equal(new[] { "stay", "move", "stay", "move", "stay" }, Kinds(day));

        var segments = day.GetProperty("segments").EnumerateArray().ToList();
        for (var k = 0; k < segments.Count; k++)
        {
            Assert.Equal(stored[k].Id, segments[k].GetProperty("id").GetInt64());
            Assert.Equal(stored[k].StartUtc, segments[k].GetProperty("start").GetDateTime());
            Assert.Equal(stored[k].EndUtc, segments[k].GetProperty("end").GetDateTime());
            Assert.EndsWith("Z", segments[k].GetProperty("start").GetString());
            Assert.EndsWith("Z", segments[k].GetProperty("end").GetString());
            Assert.Equal("Europe/Oslo", segments[k].GetProperty("startTimeZone").GetString());
            Assert.Equal("Europe/Oslo", segments[k].GetProperty("endTimeZone").GetString());
        }

        // Stays carry a place and nothing of a move; moves carry mode, distance and the stored line and nothing of a stay.
        var stay = segments[0];
        var place = stay.GetProperty("place");
        Assert.Equal(stored[0].PlaceId, place.GetProperty("id").GetInt64());
        Assert.Equal(JsonValueKind.Null, place.GetProperty("name").ValueKind);
        var home = await Sql.SingleAsync(cs, "select latitude, longitude from place where id = @id", new { id = stored[0].PlaceId }, Ct);
        Assert.Equal((double)home.latitude, place.GetProperty("lat").GetDouble());
        Assert.Equal((double)home.longitude, place.GetProperty("lon").GetDouble());
        Assert.All(new[] { "mode", "distanceMeters", "geometry", "from", "to" }, name => Assert.False(stay.TryGetProperty(name, out _), name));

        var walk = segments[1];
        Assert.Equal("walk", walk.GetProperty("mode").GetString());
        Assert.Equal(stored[1].DistanceM!.Value, walk.GetProperty("distanceMeters").GetDouble());
        Assert.Equal("cycle", segments[3].GetProperty("mode").GetString());
        Assert.All(new[] { "place", "from", "to" }, name => Assert.False(walk.TryGetProperty(name, out _), name));
        foreach (var move in new[] { segments[1], segments[3] })
        {
            var geometry = move.GetProperty("geometry");
            Assert.True(geometry.GetArrayLength() >= 2);
            Assert.Equal(2, geometry[0].GetArrayLength());
        }
        // "As stored": the same numbers in the same order (longitude first), whatever the spacing of the stored text.
        Assert.Equal(
            JsonSerializer.Deserialize<double[][]>(stored[1].GeometryDetail!),
            JsonSerializer.Deserialize<double[][]>(walk.GetProperty("geometry").GetRawText()));

        // Three distinct places; distance and moving time are those of the two moves, from the stored columns.
        var summary = day.GetProperty("summary");
        Assert.Equal(3, summary.GetProperty("places").GetInt32());
        Assert.Equal(stored[1].DistanceM!.Value + stored[3].DistanceM!.Value, summary.GetProperty("distanceMeters").GetDouble(), 6);
        var moving = (stored[1].EndUtc - stored[1].StartUtc) + (stored[3].EndUtc - stored[3].StartUtc);
        Assert.Equal((long)Math.Round(moving.TotalSeconds), summary.GetProperty("movingSeconds").GetInt64());
    }

    [Fact]
    public async Task Day_includes_stay_crossing_midnight_on_both_dates()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // The night clocks go back in Oslo: 2026-10-24 22:00 local to 2026-10-25 08:00 local is 11 hours, not 10.
        var track = new TrackBuilder(Utc(10, 24, 20), Spots.Home).Stay(TimeSpan.FromHours(11), TimeSpan.FromMinutes(10)).Build();
        await PointSeeder.InsertAsync(cs, track, Ct);
        await api.Services.GetRequiredService<ITimelineProcessor>().ReprocessAsync(Utc(10, 24), Utc(10, 26), Ct);
        var stored = Assert.Single(await StoredAsync(cs));

        foreach (var date in new[] { "2026-10-24", "2026-10-25" })
        {
            using var body = await GetDayAsync(client, date);
            var stay = Assert.Single(body.RootElement.GetProperty("segments").EnumerateArray());
            Assert.Equal("stay", stay.GetProperty("kind").GetString());
            Assert.Equal(stored.Id, stay.GetProperty("id").GetInt64());
            Assert.Equal(Utc(10, 24, 20), stay.GetProperty("start").GetDateTime());
            Assert.Equal(Utc(10, 25, 7), stay.GetProperty("end").GetDateTime());
            Assert.Equal(TimeSpan.FromHours(11), stay.GetProperty("end").GetDateTime() - stay.GetProperty("start").GetDateTime());
            Assert.Equal(1, body.RootElement.GetProperty("summary").GetProperty("places").GetInt32());
        }

        foreach (var date in new[] { "2026-10-23", "2026-10-26" })
        {
            using var body = await GetDayAsync(client, date);
            Assert.Empty(body.RootElement.GetProperty("segments").EnumerateArray());
        }
    }

    [Fact]
    public async Task Flight_that_lands_on_an_earlier_local_date_is_on_both_dates()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // Tokyo is UTC+9 and San Francisco UTC-7 in October. The plane leaves at 00:30 on 10 October in Tokyo and lands
        // about nine hours later: 17:40 on 9 October in San Francisco. It lands on an earlier local date than it left on.
        var track = new TrackBuilder(Utc(10, 9, 14), Spots.Tokyo)
            .Stay(TimeSpan.FromMinutes(90), Every2min)
            .Travel(Spots.SanFrancisco, 900, TimeSpan.FromMinutes(10))
            .Stay(TimeSpan.FromHours(1), Every2min)
            .Build();
        await PointSeeder.InsertAsync(cs, track, Ct);
        await api.Services.GetRequiredService<ITimelineProcessor>().ReprocessAsync(Utc(10, 9), Utc(10, 11), Ct);

        var stored = await Sql.QueryAsync<LocalDates>(cs,
            """
            select kind as Kind, start_tz as StartTz, end_tz as EndTz, local_start_date::text as LocalStartDate, local_end_date::text as LocalEndDate
            from segment order by start_utc
            """, ct: Ct);
        Assert.Equal(["stay", "move", "stay"], stored.Select(s => s.Kind));
        Assert.Equal(("move", "Asia/Tokyo", "America/Los_Angeles"), (stored[1].Kind, stored[1].StartTz, stored[1].EndTz));
        // The earlier of the two dates comes first, whichever end of the segment it belongs to.
        Assert.Equal(("2026-10-09", "2026-10-10"), (stored[1].LocalStartDate, stored[1].LocalEndDate));

        foreach (var (date, kinds) in new[]
                 {
                     ("2026-10-09", new[] { "stay", "move", "stay" }), // the evening in Tokyo, the flight, the arrival
                     ("2026-10-10", new[] { "stay", "move" }),         // the Tokyo stay past midnight, and the flight leaving
                 })
        {
            using var body = await GetDayAsync(client, date);
            var segments = body.RootElement.GetProperty("segments").EnumerateArray().ToList();
            Assert.Equal(kinds, Kinds(body.RootElement));
            var flight = Assert.Single(segments, s => s.GetProperty("kind").GetString() == "move");
            Assert.Equal("flight", flight.GetProperty("mode").GetString());
            Assert.Equal("Asia/Tokyo", flight.GetProperty("startTimeZone").GetString());
            Assert.Equal("America/Los_Angeles", flight.GetProperty("endTimeZone").GetString());
        }
    }

    [Fact]
    public async Task Selection_is_by_local_dates()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // The UTC times are all the same: only the stored local dates decide.
        var (start, end) = (Utc(10, 22, 6), Utc(10, 22, 7));
        var ids = new Dictionary<string, long>
        {
            ["before"] = await InsertSegmentAsync(cs, "gap", start.AddMinutes(0), end, D(10, 20), D(10, 21)),
            ["ends on the day"] = await InsertSegmentAsync(cs, "gap", start.AddMinutes(1), end, D(10, 21), D(10, 22)),
            ["within the day"] = await InsertSegmentAsync(cs, "gap", start.AddMinutes(2), end, D(10, 22), D(10, 22)),
            ["starts on the day"] = await InsertSegmentAsync(cs, "gap", start.AddMinutes(3), end, D(10, 22), D(10, 23)),
            ["after"] = await InsertSegmentAsync(cs, "gap", start.AddMinutes(4), end, D(10, 23), D(10, 24)),
            ["spans the day"] = await InsertSegmentAsync(cs, "gap", start.AddMinutes(5), end, D(10, 19), D(10, 25)),
        };

        using var body = await GetDayAsync(client, "2026-10-22");

        var got = body.RootElement.GetProperty("segments").EnumerateArray().Select(s => s.GetProperty("id").GetInt64()).ToArray();
        Assert.Equal(
            new[] { ids["ends on the day"], ids["within the day"], ids["starts on the day"], ids["spans the day"] },
            got);
    }

    [Fact]
    public async Task Segments_are_ordered_by_start_time()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // Inserted latest first, so the ids run against the time.
        var third = await InsertSegmentAsync(cs, "stay", Utc(10, 22, 12), Utc(10, 22, 14), D(10, 22), D(10, 22));
        var second = await InsertSegmentAsync(cs, "gap", Utc(10, 22, 9), Utc(10, 22, 12), D(10, 22), D(10, 22), geometry: "[[10.75,59.92],[10.76,59.93]]");
        var first = await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 9), D(10, 22), D(10, 22));

        using var body = await GetDayAsync(client, "2026-10-22");

        var got = body.RootElement.GetProperty("segments").EnumerateArray().Select(s => s.GetProperty("id").GetInt64()).ToArray();
        Assert.Equal(new[] { first, second, third }, got);
    }

    [Fact]
    public async Task Empty_day_is_ok()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        var response = await client.GetAsync("/api/day/2026-10-22", Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct));
        var day = body.RootElement;
        Assert.Equal("2026-10-22", day.GetProperty("date").GetString());
        Assert.Equal("UTC", day.GetProperty("timeZone").GetString());
        Assert.Equal("done", day.GetProperty("state").GetString());
        Assert.Empty(day.GetProperty("segments").EnumerateArray());
        var summary = day.GetProperty("summary");
        Assert.Equal(0, summary.GetProperty("places").GetInt32());
        Assert.Equal(0, summary.GetProperty("distanceMeters").GetDouble());
        Assert.Equal(0, summary.GetProperty("movingSeconds").GetInt64());
    }

    [Fact]
    public async Task Empty_day_takes_the_zone_of_the_latest_earlier_stay()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertSegmentAsync(cs, "stay", Utc(10, 18, 6), Utc(10, 18, 9), D(10, 18), D(10, 18), "Asia/Tokyo");
        await InsertSegmentAsync(cs, "stay", Utc(10, 20, 6), Utc(10, 20, 9), D(10, 20), D(10, 20), "Europe/Lisbon");
        // A gap is not a stay, and neither is anything that comes after the day.
        await InsertSegmentAsync(cs, "gap", Utc(10, 21, 6), Utc(10, 21, 9), D(10, 21), D(10, 21), "Africa/Cairo");
        await InsertSegmentAsync(cs, "stay", Utc(10, 25, 6), Utc(10, 25, 9), D(10, 25), D(10, 25), "America/New_York");

        using var body = await GetDayAsync(client, "2026-10-22");

        Assert.Equal("Europe/Lisbon", body.RootElement.GetProperty("timeZone").GetString());
        Assert.Empty(body.RootElement.GetProperty("segments").EnumerateArray());
    }

    [Fact]
    public async Task Zone_is_the_start_zone_of_the_first_segment()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertSegmentAsync(cs, "stay", Utc(10, 21, 20), Utc(10, 22, 6), D(10, 21), D(10, 22), "Asia/Tokyo");
        await InsertSegmentAsync(cs, "move", Utc(10, 22, 6), Utc(10, 22, 18), D(10, 22), D(10, 22), "Asia/Tokyo", "Europe/Oslo",
            mode: "flight", distance: 8_000_000, geometry: "[[139.78,35.55],[10.75,59.92]]");
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 18), Utc(10, 22, 20), D(10, 22), D(10, 22), "Europe/Oslo");
        // An earlier day's stay in yet another zone must not matter when the day has segments of its own.
        await InsertSegmentAsync(cs, "stay", Utc(10, 10, 6), Utc(10, 10, 9), D(10, 10), D(10, 10), "Europe/Lisbon");

        using var body = await GetDayAsync(client, "2026-10-22");

        Assert.Equal("Asia/Tokyo", body.RootElement.GetProperty("timeZone").GetString());
        var flight = body.RootElement.GetProperty("segments")[1];
        Assert.Equal("Asia/Tokyo", flight.GetProperty("startTimeZone").GetString());
        Assert.Equal("Europe/Oslo", flight.GetProperty("endTimeZone").GetString());
        Assert.Equal("flight", flight.GetProperty("mode").GetString());
    }

    [Fact]
    public async Task Invalid_date_is_400()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        var invalid = new[]
        {
            "22-10-2026", "2026-02-30", "2026-13-01", "2026-10-32", "2026-1-5", "20261022", "2026-10-22T00:00", "today", "2026-10-22x",
        };
        foreach (var date in invalid)
        {
            var response = await client.GetAsync($"/api/day/{date}", Ct);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"{date} gave {(int)response.StatusCode}");
        }
    }

    [Fact]
    public async Task Dates_at_the_ends_of_the_calendar_are_ok()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 9), D(10, 22), D(10, 22), "Europe/Oslo");

        foreach (var date in new[] { "0001-01-01", "9999-12-31" })
        {
            using var body = await GetDayAsync(client, date);
            Assert.Equal(date, body.RootElement.GetProperty("date").GetString());
            Assert.Equal("done", body.RootElement.GetProperty("state").GetString());
            Assert.Empty(body.RootElement.GetProperty("segments").EnumerateArray());
        }
    }

    [Fact]
    public async Task Pending_when_range_dirty()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertOctober22StayAsync(cs);
        Assert.Equal("done", await StateAsync(client, "2026-10-22"));

        // Ranges of other days leave this one alone.
        await InsertDirtyRangeAsync(cs, Utc(10, 21, 8), Utc(10, 21, 9));
        await InsertDirtyRangeAsync(cs, Utc(10, 24, 8), Utc(10, 24, 9));
        Assert.Equal("done", await StateAsync(client, "2026-10-22"));

        await InsertDirtyRangeAsync(cs, Utc(10, 22, 8), Utc(10, 22, 8, 30));

        using var body = await GetDayAsync(client, "2026-10-22");
        Assert.Equal("pending", body.RootElement.GetProperty("state").GetString());
        Assert.Single(body.RootElement.GetProperty("segments").EnumerateArray()); // what is stored is still served
    }

    [Fact]
    public async Task Pending_covers_a_range_that_only_overlaps_the_day()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertOctober22StayAsync(cs); // Oslo is UTC+2: the day is 2026-10-21T22:00Z to 2026-10-22T22:00Z
        await InsertDirtyRangeAsync(cs, Utc(10, 21, 12), Utc(10, 21, 22, 30)); // begins the evening before, reaches into the day

        Assert.Equal("pending", await StateAsync(client, "2026-10-22"));
        await Sql.ExecAsync(cs, "delete from dirty_range", ct: Ct);

        await InsertDirtyRangeAsync(cs, Utc(10, 22, 21), Utc(10, 23, 4)); // begins in the day, ends the next morning
        Assert.Equal("pending", await StateAsync(client, "2026-10-22"));
    }

    [Fact]
    public async Task Pending_span_is_the_days_own_zone()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // 2026-10-25 in Oslo has 25 hours: from 2026-10-24T22:00Z (UTC+2) to 2026-10-25T23:00Z (UTC+1).
        await InsertSegmentAsync(cs, "stay", Utc(10, 25, 6), Utc(10, 25, 9), D(10, 25), D(10, 25));

        var outside = new (DateTime From, DateTime To)[]
        {
            (Utc(10, 24, 21), Utc(10, 24, 21, 59, 59)), // the evening before
            (Utc(10, 25, 23), Utc(10, 25, 23, 30)),      // starts where the day ends
        };
        foreach (var (from, to) in outside)
        {
            await InsertDirtyRangeAsync(cs, from, to);
            Assert.Equal("done", await StateAsync(client, "2026-10-25"));
            await Sql.ExecAsync(cs, "delete from dirty_range", ct: Ct);
        }

        // The last hour of the long day: a 24-hour day would already be over.
        await InsertDirtyRangeAsync(cs, Utc(10, 25, 22, 30), Utc(10, 25, 22, 45));
        Assert.Equal("pending", await StateAsync(client, "2026-10-25"));
    }

    [Fact]
    public async Task Pending_covers_the_tail_of_a_stay_that_runs_past_the_zone_day()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // The overnight stay is on 2026-10-22 and on 2026-10-23, so it is on the day's list; its end lies beyond the day
        // in its zone (Oslo: 2026-10-21T22:00Z to 2026-10-22T22:00Z).
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 20), Utc(10, 23, 6), D(10, 22), D(10, 23));

        var outside = new (DateTime From, DateTime To)[]
        {
            (Utc(10, 23, 6), Utc(10, 23, 7)),   // starts where the stay ends
            (Utc(10, 23, 12), Utc(10, 23, 13)), // well after it
        };
        foreach (var (from, to) in outside)
        {
            await InsertDirtyRangeAsync(cs, from, to);
            Assert.Equal("done", await StateAsync(client, "2026-10-22"));
            await Sql.ExecAsync(cs, "delete from dirty_range", ct: Ct);
        }

        // It overlaps the tail of the stay and nothing of the zone's day.
        await InsertDirtyRangeAsync(cs, Utc(10, 23, 2), Utc(10, 23, 3));
        Assert.Equal("pending", await StateAsync(client, "2026-10-22"));
    }

    [Fact]
    public async Task Pending_covers_the_head_of_a_stay_that_began_before_the_zone_day()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // Oslo's 2026-10-22 begins 2026-10-21T22:00Z; the stay from the evening before began an hour earlier.
        await InsertSegmentAsync(cs, "stay", Utc(10, 21, 21), Utc(10, 22, 5), D(10, 21), D(10, 22));

        await InsertDirtyRangeAsync(cs, Utc(10, 21, 20), Utc(10, 21, 20, 59)); // before the stay
        Assert.Equal("done", await StateAsync(client, "2026-10-22"));
        await Sql.ExecAsync(cs, "delete from dirty_range", ct: Ct);

        await InsertDirtyRangeAsync(cs, Utc(10, 21, 21, 15), Utc(10, 21, 21, 30)); // inside the stay, before the zone's day
        Assert.Equal("pending", await StateAsync(client, "2026-10-22"));
    }

    [Fact]
    public async Task Pending_covers_segments_in_a_zone_west_of_the_days_zone()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // The day is shown in the zone its first segment starts in (Oslo, UTC+2: until 2026-10-22T22:00Z), but the flight
        // lands in New York (UTC-4), where the evening of 2026-10-22 lasts until 2026-10-23T04:00Z.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 9), D(10, 22), D(10, 22), "Europe/Oslo");
        await InsertSegmentAsync(cs, "move", Utc(10, 22, 9), Utc(10, 22, 17), D(10, 22), D(10, 22), "Europe/Oslo", "America/New_York",
            mode: "flight", distance: 5_900_000, geometry: "[[10.75,59.92],[-73.78,40.64]]");
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 17), Utc(10, 23, 3), D(10, 22), D(10, 22), "America/New_York");

        await InsertDirtyRangeAsync(cs, Utc(10, 23, 3, 30), Utc(10, 23, 4)); // after the last stay
        Assert.Equal("done", await StateAsync(client, "2026-10-22"));
        await Sql.ExecAsync(cs, "delete from dirty_range", ct: Ct);

        await InsertDirtyRangeAsync(cs, Utc(10, 23, 1), Utc(10, 23, 2)); // in the New York evening, past Oslo's midnight
        Assert.Equal("pending", await StateAsync(client, "2026-10-22"));
    }

    [Fact]
    public async Task Pending_when_deferred_range_waits_for_retry()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertOctober22StayAsync(cs);
        // The worker defers a failing range with a backoff; it is still unprocessed.
        await InsertDirtyRangeAsync(cs, Utc(10, 22, 8), Utc(10, 22, 9), attempts: 3, nextAttemptAt: DateTime.UtcNow.AddHours(5));

        Assert.Equal("pending", await StateAsync(client, "2026-10-22"));
    }

    [Fact]
    public async Task Pending_until_the_backfill_cursor_passes_the_day()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertOctober22StayAsync(cs); // the day ends 2026-10-22T22:00Z

        Assert.Equal("done", await StateAsync(client, "2026-10-22")); // no backfill recorded

        await SetBackfillAsync(cs, Utc(10, 1), Utc(10, 30), Utc(10, 10));
        Assert.Equal("pending", await StateAsync(client, "2026-10-22"));

        await SetBackfillAsync(cs, Utc(10, 1), Utc(10, 30), Utc(10, 22, 21, 59));
        Assert.Equal("pending", await StateAsync(client, "2026-10-22"));

        await SetBackfillAsync(cs, Utc(10, 1), Utc(10, 30), Utc(10, 22, 22));
        Assert.Equal("done", await StateAsync(client, "2026-10-22"));

        await SetBackfillAsync(cs, Utc(10, 1), Utc(10, 30), Utc(10, 28));
        Assert.Equal("done", await StateAsync(client, "2026-10-22"));

        // A backfill that has reached its end is complete, wherever its cursor stands.
        await SetBackfillAsync(cs, Utc(10, 1), Utc(10, 10), Utc(10, 10));
        Assert.Equal("done", await StateAsync(client, "2026-10-22"));
    }

    [Fact]
    public async Task Pending_span_is_conservative_when_no_zone_is_known()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // nothing stored: the zone falls back to UTC, which is not a known zone for the day
        // The day's span is then 14 hours either side of the date: 2026-10-21T10:00Z to 2026-10-23T14:00Z.

        var outside = new (DateTime From, DateTime To)[]
        {
            (Utc(10, 21, 9), Utc(10, 21, 9, 59)),
            (Utc(10, 23, 14), Utc(10, 23, 15)),
        };
        foreach (var (from, to) in outside)
        {
            await InsertDirtyRangeAsync(cs, from, to);
            Assert.Equal("done", await StateAsync(client, "2026-10-22"));
            await Sql.ExecAsync(cs, "delete from dirty_range", ct: Ct);
        }

        var inside = new (DateTime From, DateTime To)[]
        {
            (Utc(10, 21, 10, 30), Utc(10, 21, 11)),
            (Utc(10, 23, 13), Utc(10, 23, 13, 30)),
        };
        foreach (var (from, to) in inside)
        {
            await InsertDirtyRangeAsync(cs, from, to);
            Assert.Equal("pending", await StateAsync(client, "2026-10-22"));
            await Sql.ExecAsync(cs, "delete from dirty_range", ct: Ct);
        }
    }

    [Fact]
    public async Task User_name_wins()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var named = await InsertPlaceAsync(cs, userName: "Mine", osmName: "Storgata 5", city: "Oslo", country: "Norway", lat: 59.92, lon: 10.75);
        var osmOnly = await InsertPlaceAsync(cs, osmName: "Cafe Nord", city: "Oslo", country: "Norway");
        var unnamed = await InsertPlaceAsync(cs);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: named);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 8), Utc(10, 22, 9), D(10, 22), D(10, 22), placeId: osmOnly);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 10), Utc(10, 22, 11), D(10, 22), D(10, 22), placeId: unnamed);

        using var body = await GetDayAsync(client, "2026-10-22");

        var places = body.RootElement.GetProperty("segments").EnumerateArray().Select(s => s.GetProperty("place")).ToList();
        Assert.Equal(named, places[0].GetProperty("id").GetInt64());
        Assert.Equal("Mine", places[0].GetProperty("name").GetString());
        Assert.Equal("Oslo", places[0].GetProperty("city").GetString());
        Assert.Equal("Norway", places[0].GetProperty("country").GetString());
        Assert.Equal("Cafe Nord", places[1].GetProperty("name").GetString());
        Assert.Equal(JsonValueKind.Null, places[2].GetProperty("name").ValueKind);
        Assert.Equal(JsonValueKind.Null, places[2].GetProperty("city").ValueKind);
        Assert.Equal(JsonValueKind.Null, places[2].GetProperty("country").ValueKind);
        Assert.Equal(3, body.RootElement.GetProperty("summary").GetProperty("places").GetInt32());
    }

    [Fact]
    public async Task Merged_place_is_served_as_the_place_it_was_merged_into()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var survivor = await InsertPlaceAsync(cs, userName: "Survivor", osmName: "Survivor OSM", city: "Oslo", country: "Norway", lat: 59.5, lon: 10.5);
        var middle = await InsertPlaceAsync(cs, userName: "Middle", city: "Bergen", country: "Norway", lat: 60.1, lon: 5.3, mergedInto: survivor);
        var absorbed = await InsertPlaceAsync(cs, userName: "Absorbed", osmName: "Absorbed OSM", city: "Tromso", country: "Norway", lat: 69.6, lon: 18.9, mergedInto: middle);
        var other = await InsertPlaceAsync(cs, userName: "Other", city: "Oslo", country: "Norway");
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: absorbed);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 8), Utc(10, 22, 9), D(10, 22), D(10, 22), placeId: middle);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 10), Utc(10, 22, 11), D(10, 22), D(10, 22), placeId: survivor);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 12), Utc(10, 22, 13), D(10, 22), D(10, 22), placeId: other);

        using var body = await GetDayAsync(client, "2026-10-22");

        var places = body.RootElement.GetProperty("segments").EnumerateArray().Select(s => s.GetProperty("place")).ToList();
        Assert.All(places.Take(3), place =>
        {
            Assert.Equal(survivor, place.GetProperty("id").GetInt64());
            Assert.Equal("Survivor", place.GetProperty("name").GetString());
            Assert.Equal("Oslo", place.GetProperty("city").GetString());
            Assert.Equal(59.5, place.GetProperty("lat").GetDouble());
            Assert.Equal(10.5, place.GetProperty("lon").GetDouble());
        });
        Assert.Equal(other, places[3].GetProperty("id").GetInt64());
        Assert.DoesNotContain("Absorbed", body.RootElement.GetRawText());
        Assert.DoesNotContain("Middle", body.RootElement.GetRawText());
        Assert.Equal(2, body.RootElement.GetProperty("summary").GetProperty("places").GetInt32()); // the survivor and the other
    }

    [Fact]
    public async Task Merge_cycle_gives_no_place_and_does_not_fail()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // Not something the app writes, but the schema allows it: no place survives, so there is none to show.
        var first = await InsertPlaceAsync(cs, userName: "First");
        var second = await InsertPlaceAsync(cs, userName: "Second", mergedInto: first);
        await Sql.ExecAsync(cs, "update place set merged_into_id = @second where id = @first", new { first, second }, Ct);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: first);

        using var body = await GetDayAsync(client, "2026-10-22");

        Assert.Equal(JsonValueKind.Null, body.RootElement.GetProperty("segments")[0].GetProperty("place").ValueKind);
        Assert.Equal(0, body.RootElement.GetProperty("summary").GetProperty("places").GetInt32());
    }

    [Fact]
    public async Task Stay_without_a_place_has_a_null_place()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: null);

        using var body = await GetDayAsync(client, "2026-10-22");

        var stay = body.RootElement.GetProperty("segments")[0];
        Assert.Equal(JsonValueKind.Null, stay.GetProperty("place").ValueKind);
        Assert.Equal(0, body.RootElement.GetProperty("summary").GetProperty("places").GetInt32());
    }

    // ---- home stays -----------------------------------------------------------------------------------------------------

    private static Task InsertHomePeriodAsync(string cs, long placeId, DateOnly from, DateOnly? to, string source = "detected")
        => Sql.ExecAsync(cs,
            "insert into home_period (place_id, from_date, to_date, source) values (@placeId, @from, @to, @source)",
            new { placeId, from, to, source }, Ct);

    /// <summary>A night located at a place (03:00 on the day after <paramref name="date"/>, in Oslo), as home detection stores it.</summary>
    private static Task InsertNightAsync(string cs, DateOnly date, long placeId) => Sql.ExecAsync(cs,
        """
        insert into night (date, instant_utc, zone, source, place_id, latitude, longitude)
        select @date, (@date + 1)::timestamp at time zone 'Europe/Oslo' + interval '3 hours', 'Europe/Oslo', 'stay', id, latitude, longitude
        from place where id = @placeId
        """,
        new { date, placeId }, Ct);

    /// <summary>The stays of a day as (place id, home), in time order. <c>home</c> must be a boolean on every stay, so reading it fails if it is not.</summary>
    private static List<(long? Place, bool Home)> HomesOf(JsonDocument day) => day.RootElement.GetProperty("segments").EnumerateArray()
        .Where(s => s.GetProperty("kind").GetString() == "stay")
        .Select(s => (s.GetProperty("place") is { ValueKind: JsonValueKind.Object } place ? place.GetProperty("id").GetInt64() : (long?)null,
            s.GetProperty("home").GetBoolean()))
        .ToList();

    [Fact]
    public async Task Day_marks_stays_at_the_home_in_effect()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await InsertPlaceAsync(cs, userName: "Home", city: "Oslo", country: "Norway");
        var cafe = await InsertPlaceAsync(cs, osmName: "Cafe Nord", city: "Oslo", country: "Norway", lat: 59.93, lon: 10.76);
        await InsertHomePeriodAsync(cs, home, D(1, 1), null);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: home);
        var move = await InsertSegmentAsync(cs, "move", Utc(10, 22, 7), Utc(10, 22, 8), D(10, 22), D(10, 22), mode: "walk", distance: 500, geometry: "[[10.75,59.92],[10.76,59.93]]");
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 8), Utc(10, 22, 9), D(10, 22), D(10, 22), placeId: cafe);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 10), Utc(10, 22, 11), D(10, 22), D(10, 22), placeId: null); // matched no place
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 12), Utc(10, 22, 13), D(10, 22), D(10, 22), placeId: home);

        using var body = await GetDayAsync(client, "2026-10-22");

        // The home is true and nothing else is: the café, and the stay with no place, say false rather than nothing.
        Assert.Equal([(home, true), (cafe, false), (null, false), (home, true)], HomesOf(body));
        // It comes right after the place in the stay, and only stays have it.
        var segments = body.RootElement.GetProperty("segments").EnumerateArray().ToList();
        Assert.Equal(["place", "home"], segments[0].EnumerateObject().Select(p => p.Name).TakeLast(2));
        Assert.False(segments[1].TryGetProperty("home", out _));
        Assert.Equal(move, segments[1].GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task Day_marks_a_stay_at_a_place_near_the_home_as_home_and_one_farther_away_not()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await InsertPlaceAsync(cs, userName: "Home", city: "Oslo", country: "Norway");
        // GPS drift made two more places of the one home, 120 m and 240 m from it, and a neighbour's is 300 m away: past the 250 m radius,
        // whatever nights it had.
        var fragment = await InsertPlaceAsync(cs, osmName: "Storgata 5", city: "Oslo", country: "Norway", lat: Spots.Home.Latitude, lon: Geo.Offset(Spots.Home, 0, 120).Longitude);
        var edge = await InsertPlaceAsync(cs, osmName: "Storgata 7", city: "Oslo", country: "Norway", lat: Geo.Offset(Spots.Home, 240, 0).Latitude, lon: Spots.Home.Longitude);
        var neighbour = await InsertPlaceAsync(cs, osmName: "Cafe Nord", city: "Oslo", country: "Norway", lat: Spots.Home.Latitude, lon: Geo.Offset(Spots.Home, 0, 300).Longitude);
        await InsertHomePeriodAsync(cs, home, D(1, 1), null);
        // The fragments and the neighbour each were the night location on a night of the period: only the radius tells them apart.
        var night = 1;
        foreach (var place in new[] { home, fragment, edge, neighbour })
            await InsertNightAsync(cs, D(10, night++), place);
        var hour = 6;
        foreach (var place in new[] { home, fragment, edge, neighbour })
            await InsertSegmentAsync(cs, "stay", Utc(10, 22, hour), Utc(10, 22, ++hour), D(10, 22), D(10, 22), placeId: place);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, hour + 1), Utc(10, 22, hour + 2), D(10, 22), D(10, 22), placeId: null); // matched no place

        using var body = await GetDayAsync(client, "2026-10-22");

        Assert.Equal([(home, true), (fragment, true), (edge, true), (neighbour, false), (null, false)], HomesOf(body));
    }

    [Fact]
    public async Task Day_takes_a_place_near_the_home_of_the_day_viewed_and_not_one_near_an_earlier_home()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var oldHome = await InsertPlaceAsync(cs, userName: "Old flat", city: "Oslo", country: "Norway");
        var nearOld = await InsertPlaceAsync(cs, osmName: "Storgata 5", city: "Oslo", country: "Norway", lat: Spots.Home.Latitude, lon: Geo.Offset(Spots.Home, 0, 120).Longitude);
        var newHome = await InsertPlaceAsync(cs, userName: "New flat", city: "Bergen", country: "Norway", lat: 60.39, lon: 5.32);
        var nearNew = await InsertPlaceAsync(cs, osmName: "Strandgaten 2", city: "Bergen", country: "Norway", lat: 60.39, lon: 5.3205);
        await InsertHomePeriodAsync(cs, oldHome, D(1, 1), D(9, 30));
        await InsertHomePeriodAsync(cs, newHome, D(10, 1), null);
        await InsertNightAsync(cs, D(5, 1), nearOld);
        await InsertNightAsync(cs, D(10, 5), nearNew);
        foreach (var day in new[] { D(9, 30), D(10, 1) })
        {
            var noon = new DateTime(2026, day.Month, day.Day, 10, 0, 0, DateTimeKind.Utc);
            var at = 0;
            foreach (var place in new[] { nearOld, nearNew })
                await InsertSegmentAsync(cs, "stay", noon.AddHours(at), noon.AddHours(at++).AddMinutes(30), day, day, placeId: place);
        }

        using var lastDayOfOld = await GetDayAsync(client, "2026-09-30");
        using var firstDayOfNew = await GetDayAsync(client, "2026-10-01");

        Assert.Equal([(nearOld, true), (nearNew, false)], HomesOf(lastDayOfOld));
        Assert.Equal([(nearOld, false), (nearNew, true)], HomesOf(firstDayOfNew));
    }

    [Fact]
    public async Task Day_reads_the_radius_around_the_home_from_the_options()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var narrow = new ApiFactory(cs, new Dictionary<string, string?> { ["Detection:HomeRadiusMeters"] = "100" });
        var narrowClient = narrow.CreateClient(); // starting the host creates the schema
        var home = await InsertPlaceAsync(cs, userName: "Home", city: "Oslo", country: "Norway");
        var fragment = await InsertPlaceAsync(cs, osmName: "Storgata 5", city: "Oslo", country: "Norway", lat: Spots.Home.Latitude, lon: Geo.Offset(Spots.Home, 0, 120).Longitude);
        await InsertHomePeriodAsync(cs, home, D(1, 1), null);
        await InsertNightAsync(cs, D(10, 1), fragment);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: home);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 8), Utc(10, 22, 9), D(10, 22), D(10, 22), placeId: fragment);

        using (var body = await GetDayAsync(narrowClient, "2026-10-22"))
            Assert.Equal([(home, true), (fragment, false)], HomesOf(body)); // 120 m is outside 100 m

        await using var wide = new ApiFactory(cs, new Dictionary<string, string?> { ["Detection:HomeRadiusMeters"] = "130" });
        using (var body = await GetDayAsync(wide.CreateClient(), "2026-10-22"))
            Assert.Equal([(home, true), (fragment, true)], HomesOf(body)); // and inside 130 m
    }

    [Fact]
    public async Task Day_keeps_the_number_of_a_cafe_near_the_home_that_was_never_the_night_location()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await InsertPlaceAsync(cs, userName: "Home", city: "Oslo", country: "Norway");
        // 150 m from home, inside the 250 m radius, and a place with stays but never a night: a café, a shop, a gym.
        var cafe = await InsertPlaceAsync(cs, osmName: "Cafe Nord", city: "Oslo", country: "Norway", lat: Geo.Offset(Spots.Home, 150, 0).Latitude, lon: Spots.Home.Longitude);
        await InsertHomePeriodAsync(cs, home, D(1, 1), null);
        await InsertNightAsync(cs, D(10, 20), home);
        await InsertNightAsync(cs, D(10, 21), home);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: home);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 8), Utc(10, 22, 9), D(10, 22), D(10, 22), placeId: cafe);

        using var body = await GetDayAsync(client, "2026-10-22");

        Assert.Equal([(home, true), (cafe, false)], HomesOf(body));
    }

    [Fact]
    public async Task Day_marks_a_near_place_as_home_only_by_the_nights_of_the_home_period_in_effect()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await InsertPlaceAsync(cs, userName: "Home", city: "Oslo", country: "Norway");
        var fragment = await InsertPlaceAsync(cs, osmName: "Storgata 5", city: "Oslo", country: "Norway", lat: Spots.Home.Latitude, lon: Geo.Offset(Spots.Home, 0, 120).Longitude);
        // Two periods of the one place, with a stretch away between them.
        await InsertHomePeriodAsync(cs, home, D(1, 1), D(3, 31));
        await InsertHomePeriodAsync(cs, home, D(6, 1), null);
        // The fragment was a night place in the first period, and once in between, when no home period covered the night.
        await InsertNightAsync(cs, D(2, 10), fragment);
        await InsertNightAsync(cs, D(4, 20), fragment);
        foreach (var day in new[] { D(2, 15), D(8, 15) })
        {
            var noon = new DateTime(2026, day.Month, day.Day, 10, 0, 0, DateTimeKind.Utc);
            await InsertSegmentAsync(cs, "stay", noon, noon.AddHours(1), day, day, placeId: home);
            await InsertSegmentAsync(cs, "stay", noon.AddHours(2), noon.AddHours(3), day, day, placeId: fragment);
        }

        using var inFirst = await GetDayAsync(client, "2026-02-15");
        using var inSecond = await GetDayAsync(client, "2026-08-15");

        Assert.Equal([(home, true), (fragment, true)], HomesOf(inFirst));
        // Its night was in another period, and one outside every period: neither makes it home in this one.
        Assert.Equal([(home, true), (fragment, false)], HomesOf(inSecond));
    }

    [Fact]
    public async Task Day_marks_a_near_place_as_home_by_the_nights_of_the_period_the_owner_set()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var ownersAt = Geo.Offset(Spots.Home, 7000, 0);
        var detected = await InsertPlaceAsync(cs, userName: "Home", city: "Oslo", country: "Norway");
        var owners = await InsertPlaceAsync(cs, userName: "Flat", city: "Oslo", country: "Norway", lat: ownersAt.Latitude, lon: ownersAt.Longitude);
        // Two more places of the owner's flat, as GPS drift makes them: one was where a night was spent in August, the other in July, before the
        // owner's period.
        var fragment = await InsertPlaceAsync(cs, osmName: "Storgata 5", city: "Oslo", country: "Norway",
            lat: Geo.Offset(ownersAt, 0, 120).Latitude, lon: Geo.Offset(ownersAt, 0, 120).Longitude);
        var earlier = await InsertPlaceAsync(cs, osmName: "Storgata 7", city: "Oslo", country: "Norway",
            lat: Geo.Offset(ownersAt, 150, 0).Latitude, lon: Geo.Offset(ownersAt, 150, 0).Longitude);
        await InsertHomePeriodAsync(cs, detected, D(1, 1), null);
        await InsertHomePeriodAsync(cs, owners, D(8, 1), D(8, 31), "user"); // wins over the detected one on its dates
        await InsertNightAsync(cs, D(7, 10), earlier);
        await InsertNightAsync(cs, D(8, 10), fragment);
        foreach (var (day, hour, place) in new[]
        {
            (D(8, 15), 10, owners), (D(8, 15), 12, fragment), (D(8, 15), 14, earlier), (D(9, 15), 10, owners), (D(9, 15), 12, detected),
        })
            await InsertSegmentAsync(cs, "stay", Utc(day.Month, day.Day, hour), Utc(day.Month, day.Day, hour + 1), day, day, placeId: place);

        using var august = await GetDayAsync(client, "2026-08-15");
        using var september = await GetDayAsync(client, "2026-09-15");

        // In August the owner's flat is home, and so is the fragment whose night was in the period; the other one's night was before it.
        Assert.Equal([(owners, true), (fragment, true), (earlier, false)], HomesOf(august));
        // In September the detected home is: the owner's flat is a place like another then.
        Assert.Equal([(owners, false), (detected, true)], HomesOf(september));
    }

    [Fact]
    public async Task Day_takes_the_night_places_of_a_merged_fragment_as_the_place_it_was_merged_into()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await InsertPlaceAsync(cs, userName: "Home", city: "Oslo", country: "Norway");
        var survivor = await InsertPlaceAsync(cs, osmName: "Storgata 5", city: "Oslo", country: "Norway", lat: Spots.Home.Latitude, lon: Geo.Offset(Spots.Home, 0, 120).Longitude);
        var absorbed = await InsertPlaceAsync(cs, osmName: "Storgata 5b", city: "Oslo", country: "Norway", mergedInto: survivor);
        await InsertHomePeriodAsync(cs, home, D(1, 1), null);
        // The night was stored with the place as it was then; the stay is shown at the place it was merged into.
        await InsertNightAsync(cs, D(10, 1), absorbed);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: home);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 8), Utc(10, 22, 9), D(10, 22), D(10, 22), placeId: absorbed);

        using var body = await GetDayAsync(client, "2026-10-22");

        Assert.Equal([(home, true), (survivor, true)], HomesOf(body));
    }

    [Fact]
    public async Task Day_without_a_home_marks_nothing()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await InsertPlaceAsync(cs, osmName: "Storgata 5", city: "Oslo", country: "Norway");
        var other = await InsertPlaceAsync(cs, osmName: "Cafe Nord", city: "Oslo", country: "Norway", lat: 59.93, lon: 10.76);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: place);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 8), Utc(10, 22, 9), D(10, 22), D(10, 22), placeId: other);

        // No home period at all.
        using (var none = await GetDayAsync(client, "2026-10-22"))
            Assert.Equal([(place, false), (other, false)], HomesOf(none));

        // Periods that end the day before and begin the day after: neither covers the day, though one is of the place.
        await InsertHomePeriodAsync(cs, place, D(1, 1), D(10, 21));
        await InsertHomePeriodAsync(cs, place, D(10, 23), null);
        using var around = await GetDayAsync(client, "2026-10-22");
        Assert.Equal([(place, false), (other, false)], HomesOf(around));
    }

    [Fact]
    public async Task Day_uses_the_home_of_the_day_viewed_after_a_move()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var oldHome = await InsertPlaceAsync(cs, userName: "Old flat", city: "Oslo", country: "Norway");
        var newHome = await InsertPlaceAsync(cs, userName: "New flat", city: "Bergen", country: "Norway", lat: 60.39, lon: 5.32);
        // Moved on 1 October: both ends of a period are days it covers, so the 30th is the old home's last day and the 1st the new one's first.
        await InsertHomePeriodAsync(cs, oldHome, D(1, 1), D(9, 30));
        await InsertHomePeriodAsync(cs, newHome, D(10, 1), null);
        foreach (var day in new[] { D(9, 30), D(10, 1) })
        {
            var noon = new DateTime(2026, day.Month, day.Day, 10, 0, 0, DateTimeKind.Utc);
            await InsertSegmentAsync(cs, "stay", noon, noon.AddHours(1), day, day, placeId: oldHome);
            await InsertSegmentAsync(cs, "stay", noon.AddHours(2), noon.AddHours(3), day, day, placeId: newHome);
        }

        using var lastDayOfOld = await GetDayAsync(client, "2026-09-30");
        using var firstDayOfNew = await GetDayAsync(client, "2026-10-01");

        Assert.Equal([(oldHome, true), (newHome, false)], HomesOf(lastDayOfOld));
        Assert.Equal([(oldHome, false), (newHome, true)], HomesOf(firstDayOfNew)); // the old home's place, a day after the move
    }

    [Fact]
    public async Task Day_marks_stays_at_the_surviving_place_of_a_merged_home()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var survivor = await InsertPlaceAsync(cs, userName: "Home", city: "Oslo", country: "Norway");
        var absorbed = await InsertPlaceAsync(cs, osmName: "Storgata 5", city: "Oslo", country: "Norway", mergedInto: survivor);
        var other = await InsertPlaceAsync(cs, osmName: "Cafe Nord", city: "Oslo", country: "Norway", lat: 59.93, lon: 10.76);
        // The period was stored for the place as it was then, before the merge; the day shows the place it was merged into.
        await InsertHomePeriodAsync(cs, absorbed, D(1, 1), null);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: absorbed);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 8), Utc(10, 22, 9), D(10, 22), D(10, 22), placeId: survivor);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 10), Utc(10, 22, 11), D(10, 22), D(10, 22), placeId: other);

        using var body = await GetDayAsync(client, "2026-10-22");

        Assert.Equal([(survivor, true), (survivor, true), (other, false)], HomesOf(body));
    }

    [Fact]
    public async Task Day_takes_the_home_the_trips_list_does_where_periods_overlap()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var early = await InsertPlaceAsync(cs, osmName: "Early", lat: 59.1, lon: 10.1);
        var later = await InsertPlaceAsync(cs, osmName: "Later", lat: 59.2, lon: 10.2);
        var latest = await InsertPlaceAsync(cs, osmName: "Latest", lat: 59.3, lon: 10.3);
        var owners = await InsertPlaceAsync(cs, osmName: "Owner's", lat: 59.4, lon: 10.4);
        // The period that began later is stored first, so that its row has the lower id: neither the start nor the id alone is the rule.
        await InsertHomePeriodAsync(cs, later, D(9, 1), null);
        await InsertHomePeriodAsync(cs, early, D(1, 1), null);
        await InsertHomePeriodAsync(cs, latest, D(10, 12), null);
        await InsertHomePeriodAsync(cs, owners, D(10, 1), D(10, 31), "user");
        foreach (var day in new[] { D(9, 15), D(10, 15) })
        {
            var noon = new DateTime(2026, day.Month, day.Day, 10, 0, 0, DateTimeKind.Utc);
            var at = 0;
            foreach (var place in new[] { early, later, latest, owners })
                await InsertSegmentAsync(cs, "stay", noon.AddHours(at), noon.AddHours(at++).AddMinutes(30), day, day, placeId: place);
        }

        using var september = await GetDayAsync(client, "2026-09-15");
        using var october = await GetDayAsync(client, "2026-10-15");

        // Of the two detected periods that cover the 15th of September, the one that began later wins.
        Assert.Equal([(early, false), (later, true), (latest, false), (owners, false)], HomesOf(september));
        // On the 15th of October the owner's period wins over all three, though a detected one began after it.
        Assert.Equal([(early, false), (later, false), (latest, false), (owners, true)], HomesOf(october));
    }

    [Fact]
    public async Task Day_has_a_new_etag_when_its_home_changes()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await InsertPlaceAsync(cs, osmName: "Storgata 5", city: "Oslo", country: "Norway");
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: place);
        var before = await client.GetAsync("/api/day/2026-10-22", Ct);
        var oldTag = before.Headers.ETag;
        Assert.NotNull(oldTag);

        await InsertHomePeriodAsync(cs, place, D(1, 1), null);

        // The tag is of the body, and the body now says the stay is at home: what the browser has is not current any more.
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/day/2026-10-22");
        request.Headers.TryAddWithoutValidation("If-None-Match", oldTag.ToString());
        var after = await client.SendAsync(request, Ct);
        Assert.Equal(HttpStatusCode.OK, after.StatusCode);
        Assert.NotEqual(oldTag, after.Headers.ETag);
    }

    [Fact]
    public async Task Gap_has_the_positions_either_side_and_no_distance()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // A gap as the processor stores it: its two end positions as a two-point line, longitude first.
        var from = Geo.Offset(Spots.Home, 0, 5_000);
        var to = Geo.Offset(Spots.Home, 0, 45_000);
        var track = new TrackBuilder(Utc(10, 23, 8), Spots.Home)
            .Travel(from, 50, Every10s)
            .Teleport(to, TimeSpan.FromHours(2))
            .Travel(Geo.Offset(Spots.Home, 0, 50_000), 50, Every10s)
            .Build();
        await PointSeeder.InsertAsync(cs, track, Ct);
        await api.Services.GetRequiredService<ITimelineProcessor>().ReprocessAsync(Utc(10, 23), Utc(10, 24), Ct);
        var stored = await StoredAsync(cs);

        using var body = await GetDayAsync(client, "2026-10-23");

        Assert.Equal(new[] { "move", "gap", "move" }, Kinds(body.RootElement));
        var gap = body.RootElement.GetProperty("segments")[1];
        Assert.Equal(stored[1].Id, gap.GetProperty("id").GetInt64());
        Assert.Equal(TimeSpan.FromHours(2), gap.GetProperty("end").GetDateTime() - gap.GetProperty("start").GetDateTime());
        Assert.Equal(Math.Round(from.Latitude, 6), gap.GetProperty("from").GetProperty("lat").GetDouble());
        Assert.Equal(Math.Round(from.Longitude, 6), gap.GetProperty("from").GetProperty("lon").GetDouble());
        Assert.Equal(Math.Round(to.Latitude, 6), gap.GetProperty("to").GetProperty("lat").GetDouble());
        Assert.Equal(Math.Round(to.Longitude, 6), gap.GetProperty("to").GetProperty("lon").GetDouble());
        Assert.All(new[] { "place", "mode", "distanceMeters", "geometry" }, name => Assert.False(gap.TryGetProperty(name, out _), name));

        // The summary counts the moves and not the gap between them.
        var summary = body.RootElement.GetProperty("summary");
        Assert.Equal(stored[0].DistanceM!.Value + stored[2].DistanceM!.Value, summary.GetProperty("distanceMeters").GetDouble(), 6);
        var moving = (stored[0].EndUtc - stored[0].StartUtc) + (stored[2].EndUtc - stored[2].StartUtc);
        Assert.Equal((long)Math.Round(moving.TotalSeconds), summary.GetProperty("movingSeconds").GetInt64());
    }

    [Fact]
    public async Task Durations_and_distances_come_from_the_stored_columns()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // The stored figures deliberately disagree with the line: distance_m and the times are what is served.
        await InsertSegmentAsync(cs, "move", Utc(10, 22, 6), Utc(10, 22, 6, 10), D(10, 22), D(10, 22),
            mode: "walk", distance: 1100.5, geometry: "[[10.75,59.92],[10.751,59.921]]");
        await InsertSegmentAsync(cs, "move", Utc(10, 22, 7), Utc(10, 22, 7, 17, 30), D(10, 22), D(10, 22),
            mode: "drive", distance: 3419.5, geometry: "[[10.75,59.92],[10.8,59.95],[10.9,60.0]]");

        using var body = await GetDayAsync(client, "2026-10-22");

        var segments = body.RootElement.GetProperty("segments");
        Assert.Equal(1100.5, segments[0].GetProperty("distanceMeters").GetDouble());
        Assert.Equal(3, segments[1].GetProperty("geometry").GetArrayLength());
        var summary = body.RootElement.GetProperty("summary");
        Assert.Equal(4520.0, summary.GetProperty("distanceMeters").GetDouble());
        Assert.Equal(10 * 60 + 17 * 60 + 30, summary.GetProperty("movingSeconds").GetInt64());
        Assert.Equal(0, summary.GetProperty("places").GetInt32());
    }
}
