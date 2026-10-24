using System.Net;
using System.Text.Json;
using static Sporer.Api.Tests.TimelineSeeder;

namespace Sporer.Api.Tests;

[Collection("db")]
public class HeatEndpointTests(DatabaseFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime Utc(int month, int day, int hour = 0, int minute = 0)
        => new(2026, month, day, hour, minute, 0, DateTimeKind.Utc);

    private static DateOnly D(int month, int day) => new(2026, month, day);

    /// <summary>One cell of the answer: <c>[lon, lat, seconds]</c>, as the response writes it.</summary>
    private sealed record Cell(double Lon, double Lat, long Seconds);

    private sealed record Heat(long MaxSeconds, IReadOnlyList<Cell> Cells);

    /// <summary>GETs the heat of a range, expects 200 and returns what it says.</summary>
    private static async Task<Heat> GetHeatAsync(HttpClient client, string from, string to)
    {
        var response = await client.GetAsync($"/api/heat?from={from}&to={to}", Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"GET /api/heat?from={from}&to={to} returned {(int)response.StatusCode}: {text}");
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);

        using var body = JsonDocument.Parse(text);
        var root = body.RootElement;
        Assert.Equal(new[] { "maxSeconds", "cells" }, root.EnumerateObject().Select(p => p.Name));
        var cells = root.GetProperty("cells").EnumerateArray().Select(c =>
        {
            Assert.Equal(3, c.GetArrayLength());
            return new Cell(c[0].GetDouble(), c[1].GetDouble(), c[2].GetInt64());
        }).ToList();
        return new Heat(root.GetProperty("maxSeconds").GetInt64(), cells);
    }

    [Fact]
    public async Task Heat_weights_by_time_not_points()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // starting the host runs the migrations
        // Six hours with 3 points logged, and ten minutes with 60: the long stay is the hot one, whatever the points say. The place
        // of a stay is somewhere else than the stay's own centre, and the heat is where the stay is.
        var farAway = await InsertPlaceAsync(cs, lat: 40.0, lon: 20.0);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 12), D(10, 22), D(10, 22),
            placeId: farAway, lat: 59.921, lon: 10.751, pointCount: 3);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 13), Utc(10, 22, 13, 10), D(10, 22), D(10, 22),
            placeId: farAway, lat: 59.95, lon: 10.8, pointCount: 60);

        var heat = await GetHeatAsync(client, "2026-10-22", "2026-10-22");

        Assert.Equal(new[] { new Cell(10.751, 59.921, 6 * 3600), new Cell(10.8, 59.95, 10 * 60) }, heat.Cells);
        Assert.Equal(6 * 3600, heat.MaxSeconds);
    }

    [Fact]
    public async Task Heat_buckets_nearby_stays_together()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // Two stays 30 m apart (0.00027 degrees of latitude), at different times: one cell, with both their times. The cell is
        // named by the rounded position, not by either stay.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 8), D(10, 22), D(10, 22), lat: 59.92010, lon: 10.75020);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 10), Utc(10, 22, 13), D(10, 22), D(10, 22), lat: 59.92037, lon: 10.75020);
        // 1 km north is another cell, and a cell is told from its neighbour by the rounding, so two stays that straddle the
        // edge between two buckets are two cells even when they are 22 m apart.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 14), Utc(10, 22, 15), D(10, 22), D(10, 22), lat: 59.93010, lon: 10.75020);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 16), Utc(10, 22, 17, 30), D(10, 22), D(10, 22), lat: 59.94049, lon: 10.75020);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 18), Utc(10, 22, 18, 30), D(10, 22), D(10, 22), lat: 59.94051, lon: 10.75020);

        var heat = await GetHeatAsync(client, "2026-10-22", "2026-10-22");

        Assert.Equal(
            new[]
            {
                new Cell(10.75, 59.92, 5 * 3600),
                new Cell(10.75, 59.94, 90 * 60),
                new Cell(10.75, 59.93, 3600),
                new Cell(10.75, 59.941, 30 * 60),
            },
            heat.Cells);
        Assert.Equal(5 * 3600, heat.MaxSeconds);
    }

    [Fact]
    public async Task Heat_cell_is_the_rounded_position_in_every_hemisphere()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // The rounding is to the nearest bucket centre whichever way the sign goes, and a longitude of -0.0004 is 0, not -0.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 1), Utc(10, 22, 5), D(10, 22), D(10, 22), "Australia/Sydney", lat: -33.86882, lon: 151.20929);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 9), D(10, 22), D(10, 22), "America/New_York", lat: 40.71284, lon: -74.00604);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 10), Utc(10, 22, 12), D(10, 22), D(10, 22), "Europe/London", lat: 51.50001, lon: -0.0004);

        var heat = await GetHeatAsync(client, "2026-10-21", "2026-10-23");

        Assert.Equal(
            new[] { new Cell(151.209, -33.869, 4 * 3600), new Cell(-74.006, 40.713, 3 * 3600), new Cell(0, 51.5, 2 * 3600) },
            heat.Cells);
        Assert.All(heat.Cells, cell => Assert.False(double.IsNegative(cell.Lon) && cell.Lon == 0, "a negative zero"));
    }

    [Fact]
    public async Task Heat_orders_by_weight_then_by_position()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // Three cells with the same time, added in an order that is neither by latitude nor by longitude, and a heavier one last:
        // the answer must be the same every time it is asked, or the tag of the response would change with nothing else.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 1), Utc(10, 22, 2), D(10, 22), D(10, 22), lat: 60.2, lon: 10.1);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 3), Utc(10, 22, 4), D(10, 22), D(10, 22), lat: 59.8, lon: 10.9);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 5), Utc(10, 22, 6), D(10, 22), D(10, 22), lat: 59.8, lon: 10.2);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 7), Utc(10, 22, 10), D(10, 22), D(10, 22), lat: 61.0, lon: 11.0);

        var heat = await GetHeatAsync(client, "2026-10-22", "2026-10-22");

        Assert.Equal(
            new[] { new Cell(11.0, 61.0, 3 * 3600), new Cell(10.2, 59.8, 3600), new Cell(10.9, 59.8, 3600), new Cell(10.1, 60.2, 3600) },
            heat.Cells);
        var again = await GetHeatAsync(client, "2026-10-22", "2026-10-22");
        Assert.Equal(heat.Cells, again.Cells);
    }

    [Fact]
    public async Task Heat_counts_only_the_time_of_a_stay_inside_the_range()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // 22:00 to 08:00 the next morning in Oslo (UTC+2), across the midnight of the 22nd to the 23rd.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 20), Utc(10, 23, 6), D(10, 22), D(10, 23), lat: 59.92, lon: 10.75);

        var expected = new (string From, string To, long Seconds)[]
        {
            ("2026-10-22", "2026-10-22", 2 * 3600),  // the evening only
            ("2026-10-23", "2026-10-23", 8 * 3600),  // the morning only
            ("2026-10-22", "2026-10-23", 10 * 3600), // all of it
            ("2026-10-20", "2026-10-25", 10 * 3600), // all of it, with room to spare
        };
        foreach (var (from, to, seconds) in expected)
        {
            var heat = await GetHeatAsync(client, from, to);
            var cell = Assert.Single(heat.Cells);
            Assert.True(seconds == cell.Seconds, $"{from}..{to}: {cell.Seconds} s, not {seconds}");
            Assert.Equal(seconds, heat.MaxSeconds);
        }
    }

    [Fact]
    public async Task Heat_clips_in_the_zone_of_the_stay_across_clock_changes()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // The clocks go back in Oslo on 2026-10-25 at 01:00 UTC: the 25th is a day of 25 hours, and 22:00 on the 24th to 08:00
        // on the 25th is 11 hours, 9 of them on the 25th.
        await InsertSegmentAsync(cs, "stay", Utc(10, 24, 20), Utc(10, 25, 7), D(10, 24), D(10, 25), lat: 59.92, lon: 10.75);
        // Tokyo is UTC+9: 23:00 on the 22nd to 09:00 on the 23rd local time, one hour of it on the 22nd.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 14), Utc(10, 23, 0), D(10, 22), D(10, 23), "Asia/Tokyo", lat: 35.68, lon: 139.76);

        var oslo = await GetHeatAsync(client, "2026-10-25", "2026-10-25");
        Assert.Equal(new[] { new Cell(10.75, 59.92, 9 * 3600) }, oslo.Cells);
        var both = await GetHeatAsync(client, "2026-10-24", "2026-10-25");
        Assert.Equal(new[] { new Cell(10.75, 59.92, 11 * 3600) }, both.Cells);
        var tokyo = await GetHeatAsync(client, "2026-10-22", "2026-10-22");
        Assert.Equal(new[] { new Cell(139.76, 35.68, 3600) }, tokyo.Cells);
    }

    [Fact]
    public async Task Heat_leaves_out_stays_with_no_time_in_the_range()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // Ends exactly at the range's first midnight (00:00 on the 23rd in Oslo is 22:00 UTC): its local dates touch the range,
        // but it was not there, so it makes no cell, as it is no visit in the range API.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 18), Utc(10, 22, 22), D(10, 22), D(10, 23), lat: 59.0, lon: 10.0);
        // The same at the other end: starts exactly when the day after the range does.
        await InsertSegmentAsync(cs, "stay", Utc(10, 23, 22), Utc(10, 24, 2), D(10, 24), D(10, 24), lat: 58.0, lon: 9.0);
        // Wholly before and wholly after the range.
        await InsertSegmentAsync(cs, "stay", Utc(10, 20, 6), Utc(10, 20, 9), D(10, 20), D(10, 20), lat: 57.0, lon: 8.0);
        await InsertSegmentAsync(cs, "stay", Utc(10, 26, 6), Utc(10, 26, 9), D(10, 26), D(10, 26), lat: 56.0, lon: 7.0);
        // One hour inside it.
        await InsertSegmentAsync(cs, "stay", Utc(10, 23, 6), Utc(10, 23, 7), D(10, 23), D(10, 23), lat: 60.0, lon: 11.0);

        var heat = await GetHeatAsync(client, "2026-10-23", "2026-10-23");

        Assert.Equal(new[] { new Cell(11.0, 60.0, 3600) }, heat.Cells);
        Assert.Equal(3600, heat.MaxSeconds);
    }

    [Fact]
    public async Task Heat_is_made_of_stays_with_a_position_and_nothing_else()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await InsertPlaceAsync(cs);
        // Moves and gaps are not time spent anywhere, even where a row happens to carry a position.
        await InsertSegmentAsync(cs, "move", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), mode: "drive", lat: 50.0, lon: 5.0);
        await InsertSegmentAsync(cs, "gap", Utc(10, 22, 7), Utc(10, 22, 9), D(10, 22), D(10, 22), lat: 51.0, lon: 6.0);
        // A stay without a position cannot be drawn, and one at a position that is not on the globe (ingest stores whatever a
        // client sends) would stop the map from drawing the rest.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 10), Utc(10, 22, 11), D(10, 22), D(10, 22), placeId: place);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 11), Utc(10, 22, 12), D(10, 22), D(10, 22), lat: 95.0, lon: 10.0);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 12), Utc(10, 22, 13), D(10, 22), D(10, 22), lat: -91.0, lon: 10.0);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 13), Utc(10, 22, 14), D(10, 22), D(10, 22), lat: 10.0, lon: 181.0);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 14), Utc(10, 22, 15), D(10, 22), D(10, 22), lat: 10.0, lon: -180.5);
        // A stay that matched no place is still time spent there.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 15), Utc(10, 22, 17), D(10, 22), D(10, 22), placeId: null, lat: 59.92, lon: 10.75);
        // The very edge of the globe is on it.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 17), Utc(10, 22, 18), D(10, 22), D(10, 22), lat: 90.0, lon: -180.0);

        var heat = await GetHeatAsync(client, "2026-10-22", "2026-10-22");

        Assert.Equal(new[] { new Cell(10.75, 59.92, 2 * 3600), new Cell(-180, 90, 3600) }, heat.Cells);
    }

    [Fact]
    public async Task Heat_counts_each_stay_once_whatever_becomes_of_its_place()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // Heat is where the stays are, so a place that was merged away, one that was merged into another and a merge cycle
        // (which the app does not write, though the schema allows it) change nothing about it.
        var survivor = await InsertPlaceAsync(cs, lat: 59.5, lon: 10.5);
        var merged = await InsertPlaceAsync(cs, lat: 60.1, lon: 5.3, mergedInto: survivor);
        var first = await InsertPlaceAsync(cs);
        var second = await InsertPlaceAsync(cs, mergedInto: first);
        await Sql.ExecAsync(cs, "update place set merged_into_id = @second where id = @first", new { first, second }, Ct);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: survivor, lat: 59.51, lon: 10.51);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 8), Utc(10, 22, 10), D(10, 22), D(10, 22), placeId: merged, lat: 60.11, lon: 5.31);
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 11), Utc(10, 22, 14), D(10, 22), D(10, 22), placeId: first, lat: 58.12, lon: 9.13);

        var heat = await GetHeatAsync(client, "2026-10-22", "2026-10-22");

        Assert.Equal(
            new[] { new Cell(9.13, 58.12, 3 * 3600), new Cell(5.31, 60.11, 2 * 3600), new Cell(10.51, 59.51, 3600) },
            heat.Cells);
    }

    [Fact]
    public async Task Heat_empty_range_is_ok()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        var response = await client.GetAsync("/api/heat?from=2026-10-12&to=2026-10-18", Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("""{"maxSeconds":0,"cells":[]}""", await response.Content.ReadAsStringAsync(Ct));
    }

    [Fact]
    public async Task Heat_is_written_the_way_the_client_reads_it()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // 17 days at one spot: 1 468 800 s, a whole number, with the longitude first as in GeoJSON.
        await InsertSegmentAsync(cs, "stay", Utc(10, 1), Utc(10, 18), D(10, 1), D(10, 18), lat: 59.921, lon: 10.751);

        var response = await client.GetAsync("/api/heat?from=2026-10-01&to=2026-10-31", Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("""{"maxSeconds":1468800,"cells":[[10.751,59.921,1468800]]}""", await response.Content.ReadAsStringAsync(Ct));
    }

    [Fact]
    public async Task Heat_rejects_invalid_range()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var first = new DateOnly(2026, 1, 1);
        string Text(DateOnly date) => date.ToString("yyyy-MM-dd");

        var invalid = new (string? From, string? To)[]
        {
            (null, null), (null, "2026-10-31"), ("2026-10-01", null), ("", ""), ("2026-10-01", ""),
            ("2026-1-5", "2026-10-31"), ("20261001", "20261031"), ("2026-02-30", "2026-03-05"), ("2026-10-01T00:00", "2026-10-31"),
            (" 2026-10-01", "2026-10-31"), ("today", "tomorrow"),
            ("2026-10-31", "2026-10-01"),                  // the wrong way round
            (Text(first), Text(first.AddDays(400))),        // 401 days
            ("0001-01-01", "9999-12-31"),
        };
        foreach (var (from, to) in invalid)
        {
            var query = string.Join('&', new[]
            {
                from is null ? null : $"from={Uri.EscapeDataString(from)}",
                to is null ? null : $"to={Uri.EscapeDataString(to)}",
            }.Where(p => p is not null));
            var response = await client.GetAsync($"/api/heat?{query}", Ct);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"{query} gave {(int)response.StatusCode}");
        }

        var noQuery = await client.GetAsync("/api/heat", Ct);
        Assert.Equal(HttpStatusCode.BadRequest, noQuery.StatusCode);

        // 400 days, counting both ends, is the most; one day is the least.
        Assert.Empty((await GetHeatAsync(client, Text(first), Text(first.AddDays(399)))).Cells);
        Assert.Empty((await GetHeatAsync(client, "2026-10-22", "2026-10-22")).Cells);
    }
}
