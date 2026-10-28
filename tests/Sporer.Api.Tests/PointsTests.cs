using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Sporer.Api.Configuration;
using Sporer.Api.Features.Day;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// Removing and restoring raw points: <c>GET /api/day/{date}/points</c>, <c>POST /api/points/remove</c>, <c>GET /api/points/removed</c>
/// and <c>DELETE /api/points/removed/{batch}</c>. A removed point is a row of <c>excluded_point</c>; the raw point stays where it is,
/// and every read of points for processing leaves it out.
/// </summary>
[Collection("db")]
public class PointsTests(DatabaseFixture db)
{
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Every2min = TimeSpan.FromMinutes(2);
    private static readonly Dictionary<string, string?> NoPause = new() { ["Processing:BackfillPause"] = "00:00:00" };

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>A UTC time of 2026; <paramref name="micro"/> is the microseconds after the second.</summary>
    private static DateTime Utc(int month, int day, int hour = 0, int minute = 0, int second = 0, int micro = 0)
        => new DateTime(2026, month, day, hour, minute, second, DateTimeKind.Utc).AddTicks(micro * 10L);

    private static DateOnly D(int month, int day) => new(2026, month, day);

    /// <summary>The time as the API tells it: microseconds since the Unix epoch.</summary>
    private static long Micros(DateTime time) => (time.Ticks - DateTime.UnixEpoch.Ticks) / 10;

    private sealed record Pt(DateTime Time, string Device = "phone", double Lon = 10.75, double Lat = 59.92);

    private static async Task InsertAsync(string cs, params Pt[] points)
    {
        foreach (var p in points)
            await Sql.ExecAsync(cs,
                "insert into locationlog (time, longitude, latitude, device, altitude) values (@time, @lon, @lat, @device, 10)",
                new { time = p.Time, lon = p.Lon, lat = p.Lat, device = p.Device }, Ct);
    }

    /// <summary>A stay of a place at the zone, with the local dates of its two ends, for the day rule to find the zone in.</summary>
    private static Task StayInAsync(string cs, string zone, DateTime start, DateTime end)
        => TimelineSeeder.InsertSegmentAsync(cs, "stay", start, end, LocalTime.LocalDate(start, zone), LocalTime.LocalDate(end, zone), zone);

    private static object RemoveBody(IEnumerable<Pt> points) => new { points = points.Select(p => new { device = p.Device, t = Micros(p.Time) }) };

    private static Task<HttpResponseMessage> RemoveAsync(HttpClient client, params Pt[] points)
        => client.PostAsJsonAsync("/api/points/remove", RemoveBody(points), Ct);

    private static async Task<JsonDocument> JsonOf(HttpResponseMessage response, HttpStatusCode expected = HttpStatusCode.OK)
    {
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == expected, $"{response.RequestMessage?.Method} {response.RequestMessage?.RequestUri} gave {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text);
    }

    /// <summary>Removes the points and returns the batch and the count; expects 200.</summary>
    private static async Task<(Guid Batch, int Count)> RemoveOkAsync(HttpClient client, params Pt[] points)
    {
        using var body = await JsonOf(await RemoveAsync(client, points));
        Assert.Equal(["batch", "count"], body.RootElement.EnumerateObject().Select(p => p.Name));
        return (body.RootElement.GetProperty("batch").GetGuid(), body.RootElement.GetProperty("count").GetInt32());
    }

    /// <summary>Removes the points, which remove nothing, and expects the answer for that: no batch, written as a null, and a count of none.</summary>
    private static async Task RemoveNothingAsync(HttpClient client, params Pt[] points)
    {
        using var response = await RemoveAsync(client, points);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"POST /api/points/remove gave {(int)response.StatusCode}: {text}");
        Assert.Equal("""{"batch":null,"count":0}""", text);
    }

    private sealed record DayPoints(string Date, string[] Devices, (long T, double Lon, double Lat, int Device)[] Points);

    private static async Task<DayPoints> DayPointsAsync(HttpClient client, string date)
    {
        using var body = await JsonOf(await client.GetAsync($"/api/day/{date}/points", Ct));
        Assert.Equal(["date", "devices", "points"], body.RootElement.EnumerateObject().Select(p => p.Name));
        return new DayPoints(
            body.RootElement.GetProperty("date").GetString()!,
            [.. body.RootElement.GetProperty("devices").EnumerateArray().Select(d => d.GetString()!)],
            [.. body.RootElement.GetProperty("points").EnumerateArray().Select(p =>
            {
                Assert.Equal(4, p.GetArrayLength());
                return (p[0].GetInt64(), p[1].GetDouble(), p[2].GetDouble(), p[3].GetInt32());
            })]);
    }

    private static Task<long> CountAsync(string cs, string table) => Sql.ScalarAsync<long>(cs, $"select count(*) from {table}", ct: Ct);

    // ---- the points of a day -------------------------------------------------------------------------------------------

    [Fact]
    public async Task Points_of_a_day_in_its_own_zone()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // starting the host runs the migrations
        // 20 October in Tokyo (UTC+9) is 19 October 15:00 UTC to 20 October 15:00 UTC.
        await StayInAsync(cs, "Asia/Tokyo", Utc(10, 19, 20), Utc(10, 20, 10));
        await InsertAsync(cs,
            new Pt(Utc(10, 19, 14, 59, 59, 999_999), Lon: 1),                    // the last microsecond of the 19th
            new Pt(Utc(10, 19, 15, 0, 0), Lon: 2),                               // local midnight: the first point of the day
            new Pt(Utc(10, 20, 6, 30, 0, 123_457), "watch", Lon: 3, Lat: 35.5),
            new Pt(Utc(10, 20, 14, 59, 59, 999_999), Lon: 4),                    // the last microsecond of the day
            new Pt(Utc(10, 20, 15, 0, 0), Lon: 5));                              // the next midnight: the next day's

        var day = await DayPointsAsync(client, "2026-10-20");

        Assert.Equal("2026-10-20", day.Date);
        Assert.Equal(["phone", "watch"], day.Devices); // in the order they first appear
        Assert.Equal(
            [
                (Micros(Utc(10, 19, 15, 0, 0)), 2d, 59.92, 0),
                (Micros(Utc(10, 20, 6, 30, 0, 123_457)), 3d, 35.5, 1),            // the exact time, to the microsecond
                (Micros(Utc(10, 20, 14, 59, 59, 999_999)), 4d, 59.92, 0),
            ],
            day.Points);

        // The day the points are of is the day the day view shows, in the zone it shows it in.
        using var view = await JsonOf(await client.GetAsync("/api/day/2026-10-20", Ct));
        Assert.Equal("Asia/Tokyo", view.RootElement.GetProperty("timeZone").GetString());
    }

    [Fact]
    public async Task Points_of_a_day_that_has_25_hours()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // The clocks in Oslo go back on 25 October 2026: the day is 24 October 22:00 UTC to 25 October 23:00 UTC.
        await StayInAsync(cs, "Europe/Oslo", Utc(10, 25, 6), Utc(10, 25, 8));
        await InsertAsync(cs,
            new Pt(Utc(10, 24, 21, 59, 59), Lon: 1), new Pt(Utc(10, 24, 22, 0, 0), Lon: 2),
            new Pt(Utc(10, 25, 22, 59, 59), Lon: 3), new Pt(Utc(10, 25, 23, 0, 0), Lon: 4));

        var day = await DayPointsAsync(client, "2026-10-25");

        Assert.Equal([2d, 3d], day.Points.Select(p => p.Lon));
    }

    [Fact]
    public async Task Points_of_a_day_without_segments_use_the_zone_before_it_or_UTC()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await StayInAsync(cs, "Asia/Tokyo", Utc(10, 19, 20), Utc(10, 20, 10));
        await InsertAsync(cs,
            // 22 October has no segment: it is shown in Tokyo, where the latest stay before it was (21 October 15:00 UTC to 22 October 15:00 UTC).
            new Pt(Utc(10, 21, 14, 59, 59), Lon: 1), new Pt(Utc(10, 21, 15, 0, 0), Lon: 2), new Pt(Utc(10, 22, 14, 59, 59), Lon: 3), new Pt(Utc(10, 22, 15, 0, 0), Lon: 4),
            // 15 October has no segment and nothing before it: the day view says UTC, and so the day is 15 October 00:00 to 16 October 00:00 UTC.
            new Pt(Utc(10, 14, 23, 59, 59), Lon: 5), new Pt(Utc(10, 15, 0, 0, 0), Lon: 6), new Pt(Utc(10, 15, 23, 59, 59), Lon: 7), new Pt(Utc(10, 16, 0, 0, 0), Lon: 8));

        Assert.Equal([2d, 3d], (await DayPointsAsync(client, "2026-10-22")).Points.Select(p => p.Lon));
        Assert.Equal([6d, 7d], (await DayPointsAsync(client, "2026-10-15")).Points.Select(p => p.Lon));
        foreach (var (date, zone) in new[] { ("2026-10-22", "Asia/Tokyo"), ("2026-10-15", "UTC") })
        {
            using var view = await JsonOf(await client.GetAsync($"/api/day/{date}", Ct));
            Assert.Equal(zone, view.RootElement.GetProperty("timeZone").GetString());
        }
    }

    /// <summary>
    /// Two days that each have segments in two zones. On 20 October the segment that starts first (Oslo) has the higher id, so the order is by
    /// start and not by id; on 21 October two segments start together (Tokyo's has the lower id), so the id settles it.
    /// </summary>
    private static async Task TwoZoneDaysAsync(string cs)
    {
        await TimelineSeeder.InsertSegmentAsync(cs, "stay", Utc(10, 20, 12), Utc(10, 20, 14), D(10, 20), D(10, 20), "Asia/Tokyo");
        await TimelineSeeder.InsertSegmentAsync(cs, "stay", Utc(10, 20, 4), Utc(10, 20, 9), D(10, 20), D(10, 20), "Europe/Oslo");
        await TimelineSeeder.InsertSegmentAsync(cs, "stay", Utc(10, 21, 5), Utc(10, 21, 6), D(10, 21), D(10, 21), "Asia/Tokyo");
        await TimelineSeeder.InsertSegmentAsync(cs, "stay", Utc(10, 21, 5), Utc(10, 21, 8), D(10, 21), D(10, 21), "Europe/Oslo");
    }

    [Fact]
    public async Task Points_of_a_day_with_two_zones_are_in_the_zone_of_its_first_segment()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await TwoZoneDaysAsync(cs);
        await InsertAsync(cs,
            // 20 October: Oslo (UTC+2) is 19 October 22:00 UTC to 20 October 22:00 UTC; Tokyo would be 19 October 15:00 to 20 October 15:00.
            new Pt(Utc(10, 19, 16), Lon: 1), new Pt(Utc(10, 20, 20), Lon: 2),
            // 21 October: Tokyo is 20 October 15:00 UTC to 21 October 15:00 UTC; Oslo would be 20 October 22:00 to 21 October 22:00.
            new Pt(Utc(10, 20, 16), Lon: 3), new Pt(Utc(10, 21, 20), Lon: 4));

        Assert.Equal([3d, 2d], (await DayPointsAsync(client, "2026-10-20")).Points.Select(p => p.Lon)); // not 1, which only Tokyo's 20 October holds
        Assert.Equal([3d, 2d], (await DayPointsAsync(client, "2026-10-21")).Points.Select(p => p.Lon)); // not 4, which only Oslo's 21 October holds
        foreach (var (date, zone) in new[] { ("2026-10-20", "Europe/Oslo"), ("2026-10-21", "Asia/Tokyo") })
        {
            using var view = await JsonOf(await client.GetAsync($"/api/day/{date}", Ct));
            Assert.Equal(zone, view.RootElement.GetProperty("timeZone").GetString());
        }
    }

    [Fact]
    public async Task Day_zone_is_the_same_with_the_days_segments_loaded_and_without()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        _ = api.CreateClient(); // starting the host runs the migrations
        var segments = api.Services.GetRequiredService<SegmentStore>();
        await TwoZoneDaysAsync(cs);
        await StayInAsync(cs, "Pacific/Auckland", Utc(10, 23, 2), Utc(10, 23, 4));

        // Days with segments in two zones (and one with a tie), one with a single zone, days with none after a stay, and days before every stay.
        foreach (var date in new[] { D(10, 20), D(10, 21), D(10, 23), D(10, 24), D(10, 30), D(10, 1), D(1, 1) })
        {
            var light = await DayZone.FindAsync(segments, date, stored: null, Ct);
            var loaded = await DayZone.FindAsync(segments, date, await segments.FindDayAsync(date, Ct), Ct);
            Assert.Equal(loaded, light);
        }

        Assert.Equal("Europe/Oslo", await DayZone.FindAsync(segments, D(10, 20), stored: null, Ct));          // the first to start, though it has the higher id
        Assert.Equal("Asia/Tokyo", await DayZone.FindAsync(segments, D(10, 21), stored: null, Ct));           // two start together: the lower id
        Assert.Equal("Pacific/Auckland", await DayZone.FindAsync(segments, D(10, 23), stored: null, Ct));
        Assert.Equal("Pacific/Auckland", await DayZone.FindAsync(segments, D(10, 30), stored: null, Ct));     // none of its own: where the latest stay was
        Assert.Null(await DayZone.FindAsync(segments, D(10, 1), stored: null, Ct));                           // nothing before it either
    }

    [Fact]
    public async Task Points_of_a_day_with_none_are_an_empty_list()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        var day = await DayPointsAsync(client, "2026-10-20");

        Assert.Equal("2026-10-20", day.Date);
        Assert.Empty(day.Devices);
        Assert.Empty(day.Points);
        using var raw = await JsonOf(await client.GetAsync("/api/day/2026-10-20/points", Ct));
        Assert.Equal(JsonValueKind.Array, raw.RootElement.GetProperty("points").ValueKind);
        Assert.Equal(JsonValueKind.Array, raw.RootElement.GetProperty("devices").ValueKind);
    }

    [Theory]
    [InlineData("2026-13-01")]
    [InlineData("2026-1-5")]
    [InlineData("20261020")]
    [InlineData("yesterday")]
    [InlineData("2026-10-20T00:00:00")]
    public async Task Points_of_a_date_that_is_not_one_is_400(string date)
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        using var points = await client.GetAsync($"/api/day/{Uri.EscapeDataString(date)}/points", Ct);
        using var view = await client.GetAsync($"/api/day/{Uri.EscapeDataString(date)}", Ct);

        Assert.Equal(HttpStatusCode.BadRequest, points.StatusCode);
        Assert.Equal(view.StatusCode, points.StatusCode); // the same answer as the day view gives
        Assert.Equal(await view.Content.ReadAsStringAsync(Ct), await points.Content.ReadAsStringAsync(Ct));
    }

    [Theory]
    [InlineData("0001-01-01")]
    [InlineData("9999-12-31")]
    public async Task Points_of_the_first_and_last_days_there_are_do_not_fail(string date)
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        Assert.Empty((await DayPointsAsync(client, date)).Points);
    }

    // ---- reads leave removed points out ----------------------------------------------------------------------------------

    [Fact]
    public async Task Points_leave_out_removed_ones()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var store = api.Services.GetRequiredService<PointStore>();
        await StayInAsync(cs, "Europe/Oslo", Utc(10, 22, 6), Utc(10, 22, 7));
        await InsertAsync(cs,
            new Pt(Utc(10, 22, 6), Lon: 1), new Pt(Utc(10, 22, 7), Lon: 2), new Pt(Utc(10, 22, 8), Lon: 3),
            new Pt(Utc(10, 22, 9), Lon: 4), new Pt(Utc(10, 22, 10), Lon: 5), new Pt(Utc(10, 22, 7), "watch", Lon: 6));
        // The point at 07:00 of the phone is removed; the watch's at the same instant is another point.
        await Sql.ExecAsync(cs,
            "insert into excluded_point (device, time, batch_id) values ('phone', @t1, gen_random_uuid()), ('phone', @t2, gen_random_uuid())",
            new { t1 = Utc(10, 22, 7), t2 = Utc(10, 22, 9) }, Ct);

        var day = await DayPointsAsync(client, "2026-10-22");
        Assert.Equal([1d, 6d, 3d, 5d], day.Points.Select(p => p.Lon));

        // Processing reads the same way: the load, and the point after the load that tells where a stay ended.
        var loaded = await store.LoadAsync(Utc(10, 22, 6), Utc(10, 22, 8), includeNextPoint: true, Ct);
        Assert.Equal([1d, 6d, 3d, 5d], loaded.Select(p => p.Longitude)); // 07:00 and 09:00 of the phone are gone, so 10:00 is the next point
        var withoutNext = await store.LoadAsync(Utc(10, 22, 6), Utc(10, 22, 8), includeNextPoint: false, Ct);
        Assert.Equal([1d, 6d, 3d], withoutNext.Select(p => p.Longitude));
        var atTheEdge = await store.LoadAsync(Utc(10, 22, 7), Utc(10, 22, 7), includeNextPoint: true, Ct);
        Assert.Equal([6d, 3d], atTheEdge.Select(p => p.Longitude)); // the watch's point at 07:00, and 08:00 after it
        var beforeTheRemoved = await store.LoadAsync(Utc(10, 22, 8), Utc(10, 22, 8), includeNextPoint: true, Ct);
        Assert.Equal([3d, 5d], beforeTheRemoved.Select(p => p.Longitude)); // the next point after 08:00 is 10:00: 09:00 is removed

        // The nearest point is not a removed one, on either side of the instant.
        Assert.Equal("watch", (await store.NearestAsync(Utc(10, 22, 7, 5), TimeSpan.FromMinutes(30), Ct))?.Device); // not the phone's, at the same time
        Assert.Null(await store.NearestAsync(Utc(10, 22, 9, 5), TimeSpan.FromMinutes(30), Ct)); // the only point within 30 minutes before it is removed
        Assert.Null(await store.NearestAsync(Utc(10, 22, 8, 50), TimeSpan.FromMinutes(30), Ct)); // and the only one within 30 minutes after it
        // The raw rows are all still there.
        Assert.Equal(6, await CountAsync(cs, "locationlog"));
    }

    [Fact]
    public async Task Night_point_ignores_removed_points()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var builder = api.Services.GetRequiredService<NightBuilder>();
        // The night of 10 June is read at 01:00 UTC on the 11th (Oslo, UTC+2), with nothing stored to say where the person was.
        await TimelineSeeder.InsertSegmentAsync(cs, "gap", Utc(6, 10, 18), Utc(6, 11, 8), D(6, 10), D(6, 11));
        var earlier = Geo.Offset(Spots.Home, 0, -5_000);
        var later = Geo.Offset(Spots.Home, 0, 5_000);
        await InsertAsync(cs,
            new Pt(Utc(6, 11, 0, 50), Lon: earlier.Longitude, Lat: earlier.Latitude),  // 10 minutes before the instant: the nearer
            new Pt(Utc(6, 11, 1, 20), Lon: later.Longitude, Lat: later.Latitude));     // 20 minutes after it

        async Task<(Night Night, string Source)> NightAsync()
        {
            var built = await builder.BuildAsync(Utc(6, 10, 12), Utc(6, 11, 12), Ct);
            return Assert.Single(built.Nights, n => n.Night.Date == D(6, 10));
        }

        var (night, source) = await NightAsync();
        Assert.Equal(("point", earlier.Longitude), (source, night.Position!.Value.Longitude));

        // The nearer is removed: the night is where the other one is.
        await Sql.ExecAsync(cs, "insert into excluded_point (device, time, batch_id) values ('phone', @t, gen_random_uuid())", new { t = Utc(6, 11, 0, 50) }, Ct);
        (night, source) = await NightAsync();
        Assert.Equal(("point", later.Longitude), (source, night.Position!.Value.Longitude));

        // With both removed there is no point to say where the night was.
        await Sql.ExecAsync(cs, "insert into excluded_point (device, time, batch_id) values ('phone', @t, gen_random_uuid())", new { t = Utc(6, 11, 1, 20) }, Ct);
        (night, source) = await NightAsync();
        Assert.Null(night.Position);
        Assert.NotEqual("point", source);
    }

    // ---- removing -------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Remove_stores_the_points_in_one_batch_and_leaves_the_raw_rows()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertAsync(cs, new Pt(Utc(10, 22, 6)), new Pt(Utc(10, 22, 7), "watch"), new Pt(Utc(10, 22, 8)));

        var (batch, count) = await RemoveOkAsync(client, new Pt(Utc(10, 22, 6)), new Pt(Utc(10, 22, 7), "watch"));

        Assert.Equal(2, count);
        Assert.NotEqual(Guid.Empty, batch);
        var rows = await Sql.QueryAsync<(string Device, DateTime Time, Guid Batch)>(cs,
            "select device as Device, time as Time, batch_id as Batch from excluded_point order by time", ct: Ct);
        Assert.Equal([("phone", Utc(10, 22, 6), batch), ("watch", Utc(10, 22, 7), batch)], rows);
        Assert.Equal(3, await CountAsync(cs, "locationlog")); // never deleted
    }

    [Fact]
    public async Task Remove_ignores_points_that_do_not_exist()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertAsync(cs, new Pt(Utc(10, 22, 6)), new Pt(Utc(10, 22, 7)));

        var (_, count) = await RemoveOkAsync(client,
            new Pt(Utc(10, 22, 7)),                    // there
            new Pt(Utc(10, 22, 6), "watch"),           // another device's at the time of one that is there
            new Pt(Utc(10, 22, 6, 0, 0, 1)),           // a microsecond off
            new Pt(Utc(10, 25, 6)),                    // nothing near it
            new Pt(Utc(10, 22, 7)));                   // asked for twice

        Assert.Equal(1, count);
        Assert.Equal([Utc(10, 22, 7)], await Sql.QueryAsync<DateTime>(cs, "select time from excluded_point", ct: Ct));
        // The range to rebuild is the points that were removed, not the ones that were asked for.
        var range = await Sql.SingleAsync(cs, "select from_utc, to_utc from dirty_range", ct: Ct);
        Assert.Equal((Utc(10, 22, 7), Utc(10, 22, 7)), ((DateTime)range.from_utc, (DateTime)range.to_utc));
    }

    [Fact]
    public async Task Remove_of_nothing_answers_a_null_batch_and_queues_nothing()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertAsync(cs, new Pt(Utc(10, 22, 6)), new Pt(Utc(10, 22, 7)));

        await RemoveNothingAsync(client);                                          // no points asked for
        await RemoveNothingAsync(client, new Pt(Utc(10, 25, 6)), new Pt(Utc(10, 22, 6), "watch")); // none of them exists
        Assert.Equal(0, await CountAsync(cs, "excluded_point"));
        Assert.Equal(0, await CountAsync(cs, "dirty_range"));

        // Every one is removed already: nothing more is removed, and nothing more is asked of the worker.
        await RemoveOkAsync(client, new Pt(Utc(10, 22, 6)), new Pt(Utc(10, 22, 7)));
        Assert.Equal(1, await CountAsync(cs, "dirty_range"));
        await RemoveNothingAsync(client, new Pt(Utc(10, 22, 6)), new Pt(Utc(10, 22, 7)));
        Assert.Equal(2, await CountAsync(cs, "excluded_point"));
        Assert.Equal(1, await CountAsync(cs, "dirty_range"));
    }

    [Fact]
    public async Task Remove_is_due_at_once()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(Utc(10, 23, 12)));
        await using var api = new ApiFactory(cs, time: clock);
        var client = api.CreateClient();
        var queue = api.Services.GetRequiredService<ProcessingQueue>();
        var debounce = api.Services.GetRequiredService<ProcessingOptions>().Debounce;
        Assert.True(debounce > TimeSpan.Zero);
        await InsertAsync(cs, new Pt(Utc(10, 22, 9)), new Pt(Utc(10, 22, 6)), new Pt(Utc(10, 22, 7)), new Pt(Utc(10, 22, 8)));

        // An ingest's range a moment ago is not due: it waits out the debounce.
        await Sql.ExecAsync(cs, "insert into dirty_range (from_utc, to_utc, created_at) values (@from, @to, @at)",
            new { from = Utc(10, 1, 6), to = Utc(10, 1, 7), at = clock.GetUtcNow().UtcDateTime.AddSeconds(-1) }, Ct);
        Assert.Empty(await queue.DueRangesAsync(clock.GetUtcNow().UtcDateTime, ct: Ct));

        await RemoveOkAsync(client, new Pt(Utc(10, 22, 9)), new Pt(Utc(10, 22, 6)), new Pt(Utc(10, 22, 7)));

        // One range, from the first removed point to the last, recorded as if the debounce had run out already.
        var removal = await Sql.SingleAsync(cs, "select from_utc, to_utc, created_at from dirty_range where from_utc >= @from", new { from = Utc(10, 22, 0) }, Ct);
        Assert.Equal(Utc(10, 22, 6), (DateTime)removal.from_utc);
        Assert.Equal(Utc(10, 22, 9), (DateTime)removal.to_utc);
        Assert.Equal(clock.GetUtcNow().UtcDateTime - debounce, (DateTime)removal.created_at);
        var due = Assert.Single(await queue.DueRangesAsync(clock.GetUtcNow().UtcDateTime, ct: Ct));
        Assert.Equal((Utc(10, 22, 6), Utc(10, 22, 9)), (due.FromUtc, due.ToUtc));
    }

    [Fact]
    public async Task Remove_twice_keeps_the_first_batch()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertAsync(cs, new Pt(Utc(10, 22, 6)), new Pt(Utc(10, 22, 7)), new Pt(Utc(10, 22, 8)));

        var (first, firstCount) = await RemoveOkAsync(client, new Pt(Utc(10, 22, 6)), new Pt(Utc(10, 22, 7)));
        var firstAt = await Sql.ScalarAsync<DateTime>(cs, "select min(excluded_at) from excluded_point", ct: Ct);
        var (second, secondCount) = await RemoveOkAsync(client, new Pt(Utc(10, 22, 7)), new Pt(Utc(10, 22, 8)));
        await RemoveNothingAsync(client, new Pt(Utc(10, 22, 6)), new Pt(Utc(10, 22, 8))); // both are in a batch already

        Assert.Equal((2, 1), (firstCount, secondCount)); // what is inserted, not what is asked
        Assert.NotEqual(first, second);
        var rows = await Sql.QueryAsync<(DateTime Time, Guid Batch, DateTime At)>(cs,
            "select time as Time, batch_id as Batch, excluded_at as At from excluded_point order by time", ct: Ct);
        Assert.Equal([(Utc(10, 22, 6), first), (Utc(10, 22, 7), first), (Utc(10, 22, 8), second)], rows.Select(r => (r.Time, r.Batch))); // 07:00 stays in the first
        Assert.Equal(firstAt, rows[1].At); // and keeps the time it was removed at
        // Nothing was removed by the third: no range for it. The first two asked for one each.
        Assert.Equal(2, await CountAsync(cs, "dirty_range"));

        // Restoring the second leaves the first's points removed.
        using var restored = await client.DeleteAsync($"/api/points/removed/{second}", Ct);
        Assert.Equal(HttpStatusCode.NoContent, restored.StatusCode);
        Assert.Equal([Utc(10, 22, 6), Utc(10, 22, 7)], await Sql.QueryAsync<DateTime>(cs, "select time from excluded_point order by time", ct: Ct));
    }

    [Fact]
    public async Task Remove_matches_a_point_with_sub_millisecond_time()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await StayInAsync(cs, "Europe/Oslo", Utc(10, 22, 6), Utc(10, 22, 7));
        var exact = Utc(10, 22, 6, 30, 15, 123_457); // not a whole millisecond
        await InsertAsync(cs, new Pt(exact, Lon: 7));
        Assert.Equal(exact, await Sql.ScalarAsync<DateTime>(cs, "select time from locationlog", ct: Ct)); // stored as it was sent

        // What the client is told is what it sends back.
        var day = await DayPointsAsync(client, "2026-10-22");
        var told = Assert.Single(day.Points).T;
        Assert.Equal(Micros(exact), told);
        Assert.NotEqual(0, told % 1000); // not a millisecond, or a rounding to one would do as well

        // A time rounded to the millisecond is another time, and no point.
        using (var rounded = await client.PostAsJsonAsync("/api/points/remove",
                   new { points = new[] { new { device = "phone", t = told / 1000 * 1000 } } }, Ct))
            Assert.Equal("""{"batch":null,"count":0}""", await rounded.Content.ReadAsStringAsync(Ct));

        using (var exactly = await client.PostAsJsonAsync("/api/points/remove", new { points = new[] { new { device = "phone", t = told } } }, Ct))
        using (var body = await JsonOf(exactly))
            Assert.Equal(1, body.RootElement.GetProperty("count").GetInt32());
        Assert.Equal(exact, await Sql.ScalarAsync<DateTime>(cs, "select time from excluded_point", ct: Ct));
        Assert.Empty((await DayPointsAsync(client, "2026-10-22")).Points);
    }

    [Fact]
    public async Task Remove_over_limit_is_400()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertAsync(cs, new Pt(Utc(10, 22, 6)));
        Pt[] Many(int n) => [.. Enumerable.Range(0, n).Select(i => new Pt(Utc(10, 22, 6).AddSeconds(i)))];

        using var over = await RemoveAsync(client, Many(50_001));
        Assert.Equal(HttpStatusCode.BadRequest, over.StatusCode);
        Assert.Contains("50000", await over.Content.ReadAsStringAsync(Ct)); // the limit is in the message
        Assert.Equal(0, await CountAsync(cs, "excluded_point")); // none of them, not even the one that exists
        Assert.Equal(0, await CountAsync(cs, "dirty_range"));

        // The limit itself is allowed (nearly all of these are no points at all, and are ignored).
        var (_, count) = await RemoveOkAsync(client, Many(50_000));
        Assert.Equal(1, count);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"points":null}""")]
    [InlineData("""{"points":{"device":"phone","t":1}}""")]
    [InlineData("""{"points":[null]}""")]
    [InlineData("""{"points":[{"t":1}]}""")]
    [InlineData("""{"points":[{"device":null,"t":1}]}""")]
    [InlineData("""{"points":[{"device":"phone"}]}""")]
    [InlineData("""{"points":[{"device":"phone","t":null}]}""")]
    [InlineData("""{"points":[{"device":"phone","t":1.5}]}""")]
    [InlineData("""{"points":[{"device":"phone","t":9223372036854775807}]}""")]
    [InlineData("""{"points":[{"device":"phone","t":253402300800000000}]}""")]
    [InlineData("""{"points":[{"device":"phone","t":-62135596800000001}]}""")]
    [InlineData("not json")]
    [InlineData("[")]
    public async Task Remove_with_a_body_that_is_not_points_is_400(string body)
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertAsync(cs, new Pt(Utc(10, 22, 6)));

        using var response = await client.PostAsync("/api/points/remove", new StringContent(body, Encoding.UTF8, "application/json"), Ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(0, await CountAsync(cs, "excluded_point"));
        Assert.Equal(0, await CountAsync(cs, "dirty_range"));
    }

    [Fact]
    public async Task Remove_is_a_json_write()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertAsync(cs, new Pt(Utc(10, 22, 6)));

        using var asText = await client.PostAsync("/api/points/remove",
            new StringContent($$"""{"points":[{"device":"phone","t":{{Micros(Utc(10, 22, 6))}}}]}""", Encoding.UTF8, "text/plain"), Ct);

        Assert.Equal(HttpStatusCode.UnsupportedMediaType, asText.StatusCode);
        Assert.Equal(0, await CountAsync(cs, "excluded_point"));
    }

    // ---- a removal reaches the timeline ----------------------------------------------------------------------------------

    /// <summary>
    /// A morning on 22 October: an hour at home, a walk north to 2 km, two bad fixes 600 m east of the path (two of them in a row, which the
    /// cleaner does not take for a glitch), the rest of the walk to 4 km north and an hour there. The bad fixes are the second list.
    /// </summary>
    private static (List<TrackPoint> All, List<TrackPoint> Bad) MorningWithBadFixes()
    {
        var builder = new TrackBuilder(Utc(10, 22, 7), Spots.Home)
            .Stay(TimeSpan.FromHours(1), Every2min)
            .Travel(Geo.Offset(Spots.Home, 2_000, 0), 18, Every10s);
        var before = builder.Build().Count;
        builder.Spike(600).Spike(600);
        var bad = builder.Build()[before..];
        var all = builder.Travel(Geo.Offset(Spots.Home, 4_000, 0), 18, Every10s).Stay(TimeSpan.FromHours(1), Every2min).Build();
        return (all, bad);
    }

    private sealed class Rig(ApiFactory api, FakeTimeProvider clock, string cs, List<TrackPoint> bad) : IAsyncDisposable
    {
        public HttpClient Client { get; } = api.CreateClient();
        public TimelineWorker Worker { get; } = api.Services.GetRequiredService<TimelineWorker>();
        public FakeTimeProvider Clock { get; } = clock;
        public string Cs { get; } = cs;

        /// <summary>The two bad fixes of the morning.</summary>
        public List<TrackPoint> Bad { get; } = bad;

        public async Task FinishAsync()
        {
            for (var pass = 0; await Worker.RunOnceAsync(Ct); pass++)
                Assert.True(pass < 100, "the worker keeps finding work");
        }

        public ValueTask DisposeAsync() => api.DisposeAsync();
    }

    /// <summary>The morning is stored, the timeline built from it by the worker, and the clock is after it.</summary>
    private static async Task<Rig> StartWithMorningAsync(DatabaseFixture db)
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(Utc(10, 23, 12)));
        var (all, bad) = MorningWithBadFixes();
        var rig = new Rig(new ApiFactory(cs, NoPause, clock), clock, cs, bad);
        await PointSeeder.InsertAsync(cs, all, Ct);
        await rig.FinishAsync();
        return rig;
    }

    /// <summary>The farthest east any vertex of the day's moves reaches, in degrees of longitude past home.</summary>
    private static async Task<double> EastwardReachOfMovesAsync(HttpClient client, string date)
    {
        using var day = await JsonOf(await client.GetAsync($"/api/day/{date}", Ct));
        var moves = day.RootElement.GetProperty("segments").EnumerateArray().Where(s => s.GetProperty("kind").GetString() == "move").ToList();
        Assert.NotEmpty(moves);
        return moves.SelectMany(m => m.GetProperty("geometry").EnumerateArray()).Max(v => v[0].GetDouble()) - Spots.Home.Longitude;
    }

    private static Pt[] AsPoints(IEnumerable<TrackPoint> points) => [.. points.Select(p => new Pt(p.TimeUtc, p.Device, p.Longitude, p.Latitude))];

    /// <summary>600 m east at this latitude is about 0.011 degrees of longitude: more than 0.005 is a vertex on the bad fixes.</summary>
    private const double SpikeReach = 0.005;

    [Fact]
    public async Task Remove_hides_points_and_rebuilds_the_day()
    {
        await using var rig = await StartWithMorningAsync(db);
        var (cs, bad) = (rig.Cs, rig.Bad);
        Assert.True(await EastwardReachOfMovesAsync(rig.Client, "2026-10-22") > SpikeReach, "the move goes through the bad fixes before they are removed");
        var points = await CountAsync(cs, "locationlog");

        var (_, count) = await RemoveOkAsync(rig.Client, AsPoints(bad));
        Assert.Equal(2, count);
        Assert.True(await rig.Worker.RunOnceAsync(Ct), "the worker finds the removal due, however little time has passed");
        await rig.FinishAsync();

        Assert.True(await EastwardReachOfMovesAsync(rig.Client, "2026-10-22") < SpikeReach, "the move no longer goes through them");
        Assert.Equal(points, await CountAsync(cs, "locationlog"));
        Assert.Equal(0, await CountAsync(cs, "dirty_range"));
        using var view = await JsonOf(await rig.Client.GetAsync("/api/day/2026-10-22", Ct));
        Assert.Equal("done", view.RootElement.GetProperty("state").GetString());
        Assert.Equal(["stay", "move", "stay"], view.RootElement.GetProperty("segments").EnumerateArray().Select(s => s.GetProperty("kind").GetString()));
        // The day's points no longer list them either.
        var day = await DayPointsAsync(rig.Client, "2026-10-22");
        Assert.DoesNotContain(day.Points, p => p.Lon > Spots.Home.Longitude + SpikeReach);
        Assert.Equal(points - 2, day.Points.Length);
    }

    [Fact]
    public async Task Restore_brings_the_batch_back_and_rebuilds()
    {
        await using var rig = await StartWithMorningAsync(db);
        var (cs, bad) = (rig.Cs, rig.Bad);
        var (batch, _) = await RemoveOkAsync(rig.Client, AsPoints(bad));
        await rig.FinishAsync();
        Assert.True(await EastwardReachOfMovesAsync(rig.Client, "2026-10-22") < SpikeReach);

        using var restored = await rig.Client.DeleteAsync($"/api/points/removed/{batch}", Ct);

        Assert.Equal(HttpStatusCode.NoContent, restored.StatusCode);
        Assert.Equal(string.Empty, await restored.Content.ReadAsStringAsync(Ct));
        Assert.Equal(0, await CountAsync(cs, "excluded_point"));
        // Due at once, over the span of what was restored.
        var range = await Sql.SingleAsync(cs, "select from_utc, to_utc, created_at from dirty_range", ct: Ct);
        Assert.Equal((bad[0].TimeUtc, bad[^1].TimeUtc), ((DateTime)range.from_utc, (DateTime)range.to_utc));
        Assert.True(await rig.Worker.RunOnceAsync(Ct));
        await rig.FinishAsync();
        Assert.True(await EastwardReachOfMovesAsync(rig.Client, "2026-10-22") > SpikeReach, "the move goes through them again");
        Assert.Equal(2, (await DayPointsAsync(rig.Client, "2026-10-22")).Points.Count(p => p.Lon > Spots.Home.Longitude + SpikeReach));

        // The batch is gone: restoring it again is restoring nothing.
        using var again = await rig.Client.DeleteAsync($"/api/points/removed/{batch}", Ct);
        Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);
        Assert.Equal(0, await CountAsync(cs, "dirty_range"));
    }

    [Fact]
    public async Task Removed_points_stay_out_after_a_rebuild()
    {
        await using var rig = await StartWithMorningAsync(db);
        var (cs, bad) = (rig.Cs, rig.Bad);
        await RemoveOkAsync(rig.Client, AsPoints(bad));
        await rig.FinishAsync();

        // A new version of the algorithm rebuilds all of the timeline from the raw points: what the owner removed is still out.
        await Sql.ExecAsync(cs, "update processing_state set algorithm_version = 'an older one' where id = 1", ct: Ct);
        await rig.FinishAsync();
        Assert.True(await EastwardReachOfMovesAsync(rig.Client, "2026-10-22") < SpikeReach, "after a rebuild of everything");
        Assert.Equal(2, await CountAsync(cs, "excluded_point"));

        // And the rebuild of a stretch that a later batch of points from the phone asks for, as ingest records it.
        rig.Clock.Advance(TimeSpan.FromHours(1));
        await Sql.ExecAsync(cs, "insert into dirty_range (from_utc, to_utc, created_at) values (@from, @to, @at)",
            new { from = bad[0].TimeUtc.AddMinutes(-10), to = bad[^1].TimeUtc.AddMinutes(10), at = rig.Clock.GetUtcNow().UtcDateTime.AddMinutes(-5) }, Ct);
        Assert.True(await rig.Worker.RunOnceAsync(Ct));
        await rig.FinishAsync();
        Assert.Equal(0, await CountAsync(cs, "dirty_range"));
        Assert.True(await EastwardReachOfMovesAsync(rig.Client, "2026-10-22") < SpikeReach, "after a rebuild of the stretch");
    }

    [Fact]
    public async Task Restore_unknown_batch_is_404()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertAsync(cs, new Pt(Utc(10, 22, 6)));
        await RemoveOkAsync(client, new Pt(Utc(10, 22, 6)));

        using var unknown = await client.DeleteAsync($"/api/points/removed/{Guid.NewGuid()}", Ct);
        using var empty = await client.DeleteAsync($"/api/points/removed/{Guid.Empty}", Ct);
        using var malformed = await client.DeleteAsync("/api/points/removed/not-a-batch", Ct);

        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, empty.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, malformed.StatusCode); // not an id at all
        Assert.Equal(1, await CountAsync(cs, "excluded_point")); // nothing was restored
        Assert.Equal(1, await CountAsync(cs, "dirty_range")); // and nothing asked for beyond the removal
    }

    // ---- the removed batches -------------------------------------------------------------------------------------------

    [Fact]
    public async Task Removed_list_is_empty_when_nothing_was_removed()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        using var list = await JsonOf(await client.GetAsync("/api/points/removed", Ct));

        Assert.Equal(JsonValueKind.Array, list.RootElement.ValueKind);
        Assert.Equal(0, list.RootElement.GetArrayLength());
    }

    [Fact]
    public async Task Removed_list_newest_first_with_local_dates()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // 19 and 20 October are spent in Tokyo (UTC+9), 3 November in Oslo (UTC+1).
        await StayInAsync(cs, "Asia/Tokyo", Utc(10, 18, 16), Utc(10, 20, 10));
        await StayInAsync(cs, "Europe/Oslo", Utc(11, 3, 8), Utc(11, 3, 18));
        var tokyo = new[] { new Pt(Utc(10, 19, 16, 0, 0, 5)), new Pt(Utc(10, 19, 14, 0, 0, 7)), new Pt(Utc(10, 19, 14, 30), "watch") }; // 23:00 and 23:30 on the 19th, and 01:00 on the 20th
        var oslo = new[] { new Pt(Utc(11, 3, 12)) };
        await InsertAsync(cs, [.. tokyo, .. oslo]);

        var (older, _) = await RemoveOkAsync(client, tokyo);
        var (newer, _) = await RemoveOkAsync(client, oslo);
        await Sql.ExecAsync(cs, "update excluded_point set excluded_at = @at where batch_id = @batch", new { at = Utc(10, 21, 10), batch = older }, Ct);
        await Sql.ExecAsync(cs, "update excluded_point set excluded_at = @at where batch_id = @batch", new { at = Utc(10, 22, 10), batch = newer }, Ct);

        using var list = await JsonOf(await client.GetAsync("/api/points/removed", Ct));

        var batches = list.RootElement.EnumerateArray().ToList();
        Assert.Equal(2, batches.Count);
        Assert.All(batches, b => Assert.Equal(["batch", "removedAt", "count", "from", "to", "localDates"], b.EnumerateObject().Select(p => p.Name)));
        Assert.Equal([newer, older], batches.Select(b => b.GetProperty("batch").GetGuid()));

        var (first, second) = (batches[0], batches[1]);
        Assert.Equal(Utc(10, 22, 10), first.GetProperty("removedAt").GetDateTime());
        Assert.Equal(1, first.GetProperty("count").GetInt32());
        Assert.Equal(Utc(11, 3, 12), first.GetProperty("from").GetDateTime());
        Assert.Equal(Utc(11, 3, 12), first.GetProperty("to").GetDateTime());
        Assert.Equal(["2026-11-03"], first.GetProperty("localDates").EnumerateArray().Select(d => d.GetString()));

        Assert.Equal(Utc(10, 21, 10), second.GetProperty("removedAt").GetDateTime());
        Assert.Equal(3, second.GetProperty("count").GetInt32());
        Assert.Equal(Utc(10, 19, 14, 0, 0, 7), second.GetProperty("from").GetDateTime());
        Assert.Equal(Utc(10, 19, 16, 0, 0, 5), second.GetProperty("to").GetDateTime());
        Assert.Equal(["2026-10-19", "2026-10-20"], second.GetProperty("localDates").EnumerateArray().Select(d => d.GetString())); // in Tokyo, not in UTC

        // Restoring a batch takes it off the list.
        using var restored = await client.DeleteAsync($"/api/points/removed/{newer}", Ct);
        Assert.Equal(HttpStatusCode.NoContent, restored.StatusCode);
        using var after = await JsonOf(await client.GetAsync("/api/points/removed", Ct));
        Assert.Equal([older], after.RootElement.EnumerateArray().Select(b => b.GetProperty("batch").GetGuid()));
    }
}
