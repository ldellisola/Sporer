using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Time.Testing;
using Sporer.Api.Database;
using Sporer.Api.Features.Timeline;
using Sporer.Testing;

namespace Sporer.Api.Tests;

[Collection("db")]
public class StatusEndpointTests(DatabaseFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime Utc(int month, int day, int hour = 0, int minute = 0, int second = 0)
        => new(2026, month, day, hour, minute, second, DateTimeKind.Utc);

    /// <summary>GETs the status, expects 200 and returns the parsed body (the caller disposes it).</summary>
    private static async Task<JsonDocument> GetStatusAsync(HttpClient client)
    {
        var response = await client.GetAsync("/api/status", Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"GET /api/status returned {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text);
    }

    private static string[] Warnings(JsonElement status)
        => status.GetProperty("warnings").EnumerateArray().Select(w => w.GetString()!).ToArray();

    private static Task SetStateAsync(
        string cs, DateTime? from = null, DateTime? to = null, DateTime? cursor = null, bool paused = false,
        string? algorithmVersion = null, DateTime? lastRunAt = null, string? lastError = null) => Sql.ExecAsync(cs,
        """
        update processing_state
        set backfill_from = @from, backfill_to = @to, backfill_cursor = @cursor, paused = @paused,
            algorithm_version = @algorithmVersion, last_run_at = @lastRunAt, last_error = @lastError
        where id = 1
        """,
        new { from, to, cursor, paused, algorithmVersion, lastRunAt, lastError }, Ct);

    private static Task InsertDirtyRangeAsync(string cs, DateTime from, DateTime to, int attempts = 0, string? lastError = null)
        => Sql.ExecAsync(cs,
            "insert into dirty_range (from_utc, to_utc, attempts, last_error) values (@from, @to, @attempts, @lastError)",
            new { from, to, attempts, lastError }, Ct);

    private static Task<long> InsertPlaceAsync(string cs, string geocodeState, long? mergedInto = null, double lat = 59.92)
        => Sql.ScalarAsync<long>(cs,
            "insert into place (latitude, longitude, geocode_state, merged_into_id) values (@lat, 10.75, @geocodeState, @mergedInto) returning id",
            new { lat, geocodeState, mergedInto }, Ct);

    /// <summary>A stay at <paramref name="placeId"/>, so that the place is shown on the timeline.</summary>
    private static Task InsertSegmentAsync(string cs, long placeId, int hour = 8) => Sql.ExecAsync(cs,
        """
        insert into segment (kind, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date, place_id)
        values ('stay', @start, @end, 'Europe/Oslo', 'Europe/Oslo', '2026-10-22', '2026-10-22', @placeId)
        """,
        new { start = Utc(10, 22, hour), end = Utc(10, 22, hour + 1), placeId }, Ct);

    [Fact]
    public async Task Status_reports_backfill_progress()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await SetStateAsync(cs, from: Utc(1, 1), to: Utc(1, 11), cursor: Utc(1, 6),
            algorithmVersion: "1:3fa2b9c01d2e", lastRunAt: Utc(1, 6, 12, 30));

        using var body = await GetStatusAsync(client);

        var status = body.RootElement;
        Assert.Equal("1:3fa2b9c01d2e", status.GetProperty("algorithmVersion").GetString());
        var backfill = status.GetProperty("backfill");
        Assert.Equal(Utc(1, 1), backfill.GetProperty("from").GetDateTime());
        Assert.Equal(Utc(1, 11), backfill.GetProperty("to").GetDateTime());
        Assert.Equal(Utc(1, 6), backfill.GetProperty("cursor").GetDateTime());
        Assert.EndsWith("Z", backfill.GetProperty("cursor").GetString());
        Assert.Equal(50.0, backfill.GetProperty("percent").GetDouble());
        Assert.False(backfill.GetProperty("paused").GetBoolean());
        Assert.Equal(Utc(1, 6, 12, 30), status.GetProperty("lastRunAt").GetDateTime());
        Assert.Equal(JsonValueKind.Null, status.GetProperty("lastError").ValueKind);

        await SetStateAsync(cs, from: Utc(1, 1), to: Utc(1, 11), cursor: Utc(1, 6), paused: true);
        using var paused = await GetStatusAsync(client);
        Assert.True(paused.RootElement.GetProperty("backfill").GetProperty("paused").GetBoolean());
    }

    [Fact]
    public async Task Percent_is_the_elapsed_share_and_complete_only_when_the_cursor_reached_the_end()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        // (from, to, cursor) -> percent. Never 100 before the end is reached, however close the cursor is.
        var cases = new (DateTime? From, DateTime? To, DateTime? Cursor, double Percent)[]
        {
            (null, null, null, 100),                           // no backfill
            (Utc(1, 1), Utc(1, 11), Utc(1, 1), 0),             // just started
            (Utc(1, 1), Utc(2, 10), Utc(1, 18), 42.5),         // 17 of 40 days
            (Utc(1, 1), Utc(1, 11), Utc(1, 10, 23, 59, 59), 99.9),
            (Utc(1, 1), Utc(1, 11), Utc(1, 11), 100),          // finished
            (Utc(1, 1), Utc(1, 11), Utc(1, 20), 100),          // a cursor beyond the end
            (Utc(1, 5), Utc(1, 11), Utc(1, 2), 0),             // a cursor before the start
            (Utc(1, 1), Utc(1, 11), null, 0),                  // a range without a cursor
            (Utc(1, 5), Utc(1, 5), Utc(1, 5), 100),            // a range that is no time at all
        };

        foreach (var (from, to, cursor, percent) in cases)
        {
            await SetStateAsync(cs, from, to, cursor);
            using var body = await GetStatusAsync(client);
            Assert.True(
                percent == body.RootElement.GetProperty("backfill").GetProperty("percent").GetDouble(),
                $"{from:O} to {to:O} at {cursor:O} should be {percent}%, got {body.RootElement.GetProperty("backfill").GetProperty("percent").GetDouble()}%");
        }
    }

    [Fact]
    public async Task Status_of_a_new_installation_is_quiet_and_complete()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, new Dictionary<string, string?> { ["OVERLAND_TOKEN"] = "s3cret" });
        var client = api.CreateClient();

        using var body = await GetStatusAsync(client);

        var status = body.RootElement;
        Assert.Equal(JsonValueKind.Null, status.GetProperty("algorithmVersion").ValueKind);
        var backfill = status.GetProperty("backfill");
        Assert.Equal(JsonValueKind.Null, backfill.GetProperty("from").ValueKind);
        Assert.Equal(JsonValueKind.Null, backfill.GetProperty("to").ValueKind);
        Assert.Equal(JsonValueKind.Null, backfill.GetProperty("cursor").ValueKind);
        Assert.Equal(100.0, backfill.GetProperty("percent").GetDouble());
        Assert.False(backfill.GetProperty("paused").GetBoolean());
        Assert.Equal(0, status.GetProperty("pendingRanges").GetInt32());
        Assert.Empty(status.GetProperty("failedRanges").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, status.GetProperty("lastRunAt").ValueKind);
        Assert.Equal(JsonValueKind.Null, status.GetProperty("lastError").ValueKind);
        var places = status.GetProperty("places");
        Assert.Equal((0, 0, 0), (places.GetProperty("total").GetInt32(), places.GetProperty("unnamed").GetInt32(), places.GetProperty("failed").GetInt32()));
        Assert.Empty(Warnings(status));
    }

    [Fact]
    public async Task Status_lists_failed_ranges()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // Inserted latest first: they are listed by time.
        await InsertDirtyRangeAsync(cs, Utc(10, 22, 12), Utc(10, 22, 13), attempts: 2, lastError: "NpgsqlException: boom");
        await InsertDirtyRangeAsync(cs, Utc(10, 21, 8), Utc(10, 21, 9), attempts: 1, lastError: "InvalidOperationException: no stay");
        await InsertDirtyRangeAsync(cs, Utc(10, 23, 8), Utc(10, 23, 9)); // waiting, never tried

        using var body = await GetStatusAsync(client);

        var failed = body.RootElement.GetProperty("failedRanges").EnumerateArray().ToList();
        Assert.Equal(2, failed.Count);
        Assert.Equal(Utc(10, 21, 8), failed[0].GetProperty("from").GetDateTime());
        Assert.Equal(Utc(10, 21, 9), failed[0].GetProperty("to").GetDateTime());
        Assert.Equal(1, failed[0].GetProperty("attempts").GetInt32());
        Assert.Equal("InvalidOperationException: no stay", failed[0].GetProperty("lastError").GetString());
        Assert.Equal(Utc(10, 22, 12), failed[1].GetProperty("from").GetDateTime());
        Assert.Equal(2, failed[1].GetProperty("attempts").GetInt32());
        Assert.Equal("NpgsqlException: boom", failed[1].GetProperty("lastError").GetString());
    }

    [Fact]
    public async Task Pending_ranges_count_every_range_still_waiting_failed_ones_included()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await InsertDirtyRangeAsync(cs, Utc(10, 22, 8), Utc(10, 22, 9));
        await InsertDirtyRangeAsync(cs, Utc(10, 22, 10), Utc(10, 22, 11));
        await InsertDirtyRangeAsync(cs, Utc(10, 22, 12), Utc(10, 22, 13), attempts: 3, lastError: "boom");

        using var body = await GetStatusAsync(client);

        Assert.Equal(3, body.RootElement.GetProperty("pendingRanges").GetInt32());
        Assert.Single(body.RootElement.GetProperty("failedRanges").EnumerateArray());
    }

    [Fact]
    public async Task Places_are_counted_over_the_places_in_use()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        // In use: active and shown by a segment. A place under several segments is still one place.
        var survivor = await InsertPlaceAsync(cs, "done");
        await InsertSegmentAsync(cs, survivor);
        await InsertSegmentAsync(cs, survivor, hour: 12);
        foreach (var state in new[] { "done", "pending", "pending", "pending", "failed" })
            await InsertSegmentAsync(cs, await InsertPlaceAsync(cs, state));

        // Orphans, left behind by a reprocessing that moved a stay: the namer never asks about them, so they are not counted.
        foreach (var state in new[] { "done", "pending", "pending", "failed" })
            await InsertPlaceAsync(cs, state);

        // Merged away: whatever their state, and even if a segment still points at them, they are not places any more.
        foreach (var state in new[] { "done", "pending", "failed" })
        {
            await InsertSegmentAsync(cs, await InsertPlaceAsync(cs, state, mergedInto: survivor));
            await InsertPlaceAsync(cs, state, mergedInto: survivor);
        }

        using var body = await GetStatusAsync(client);

        var places = body.RootElement.GetProperty("places");
        Assert.Equal(6, places.GetProperty("total").GetInt32());
        Assert.Equal(3, places.GetProperty("unnamed").GetInt32());
        Assert.Equal(1, places.GetProperty("failed").GetInt32());
    }

    [Fact]
    public async Task Status_warns_open_ingest()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var open = new ApiFactory(cs); // no OVERLAND_TOKEN
        using (var body = await GetStatusAsync(open.CreateClient()))
            Assert.Single(Warnings(body.RootElement), w => w.Contains("Overland ingest is open", StringComparison.Ordinal));

        var protectedCs = await db.CreateDatabaseAsync(Ct);
        await using var closed = new ApiFactory(protectedCs, new Dictionary<string, string?> { ["OVERLAND_TOKEN"] = "s3cret" });
        using (var body = await GetStatusAsync(closed.CreateClient()))
            Assert.DoesNotContain(Warnings(body.RootElement), w => w.Contains("Overland", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Status_serves_the_database_warnings()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, new Dictionary<string, string?> { ["OVERLAND_TOKEN"] = "s3cret" });
        var client = api.CreateClient();
        api.Services.GetRequiredService<DatabaseWarnings>().Add("A retention policy exists on locationLog.");
        api.Services.GetRequiredService<DatabaseWarnings>().Add("Compression is enabled on locationLog.");

        using var body = await GetStatusAsync(client);

        Assert.Equal(
            new[] { "A retention policy exists on locationLog.", "Compression is enabled on locationLog." },
            Warnings(body.RootElement));
    }

    [Theory]
    [InlineData("true", "", true)]
    [InlineData("true", "   ", true)]
    [InlineData("true", "Sporer/1.0 (test@example.com)", false)]
    [InlineData("false", "", false)] // naming switched off: nothing to warn about
    public async Task Status_warns_when_naming_is_enabled_but_has_no_user_agent(string enabled, string userAgent, bool warned)
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, new Dictionary<string, string?>
        {
            ["OVERLAND_TOKEN"] = "s3cret", ["Nominatim:Enabled"] = enabled, ["Nominatim:UserAgent"] = userAgent,
        });
        var client = api.CreateClient();

        using var body = await GetStatusAsync(client);

        // Once: the warning is the one the start-up check recorded, not a second copy made for the status.
        var matches = Warnings(body.RootElement).Where(w => w.Contains("Place naming disabled", StringComparison.Ordinal)).ToList();
        Assert.Equal(warned ? 1 : 0, matches.Count);
    }

    [Fact]
    public async Task Status_shows_the_last_worker_error_of_a_backfill_that_cannot_proceed()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(Utc(10, 23)));
        await using var api = new ApiFactory(cs, time: clock, configureServices: services =>
        {
            services.RemoveAll<ITimelineProcessor>();
            services.AddSingleton<ITimelineProcessor, FailingProcessor>();
        });
        var client = api.CreateClient();
        await PointSeeder.InsertAsync(cs, new TrackBuilder(Utc(10, 1, 7), Spots.Home).Stay(TimeSpan.FromHours(1), TimeSpan.FromMinutes(2)).Build(), Ct);
        await InsertDirtyRangeAsync(cs, Utc(10, 22, 8), Utc(10, 22, 9)); // live: held back behind the unfinished backfill

        await api.Services.GetRequiredService<TimelineWorker>().RunOnceAsync(Ct);

        using var body = await GetStatusAsync(client);

        var status = body.RootElement;
        Assert.Contains("chunk exploded", status.GetProperty("lastError").GetString());
        Assert.Equal(Utc(10, 23), status.GetProperty("lastRunAt").GetDateTime());
        var backfill = status.GetProperty("backfill");
        Assert.Equal(Utc(10, 1, 7), backfill.GetProperty("cursor").GetDateTime()); // stuck where it started
        Assert.Equal(0.0, backfill.GetProperty("percent").GetDouble());
        Assert.Equal(1, status.GetProperty("pendingRanges").GetInt32());
        Assert.Empty(status.GetProperty("failedRanges").EnumerateArray()); // the held-back range was never tried: only lastError says why
    }

    private sealed class FailingProcessor : ITimelineProcessor
    {
        public Task<int> ReprocessAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct)
            => throw new InvalidOperationException("chunk exploded");
    }
}
