using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;

namespace Sporer.Api.Tests;

[Collection("db")]
public class OverlandIngestTests(DatabaseFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static StringContent Json(string body) => new(body, Encoding.UTF8, "application/json");

    private static DateTime Utc(int hour, int minute) => new(2026, 10, 22, hour, minute, 0, DateTimeKind.Utc);

    private static string OnePoint() =>
        Payload.One(time: "2026-10-22T07:00:00Z", lon: 10.75, lat: 59.91, speed: 1, altitude: 12, device: "phone");

    private static async Task<HttpResponseMessage> PostAsync(
        HttpClient client, string body, string url = "/api/overland", AuthenticationHeaderValue? authorization = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = Json(body) };
        request.Headers.Authorization = authorization;
        return await client.SendAsync(request, Ct);
    }

    private static Task<long> CountAsync(string cs, string table) =>
        Sql.ScalarAsync<long>(cs, $"select count(*) from {table}", ct: Ct);

    [Fact]
    public async Task Ingest_stores_point_like_today()
    {
        var cs = await db.CreateDatabaseAsync(TestContext.Current.CancellationToken);
        await using var api = new ApiFactory(cs);
        var res = await api.CreateClient().PostAsync("/api/overland", Json(Payload.One(
            time: "2026-10-22T07:00:00Z", lon: 10.75, lat: 59.91, speed: -1, altitude: 12, device: "phone")),
            TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("""{"result":"ok"}""", await res.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        var row = await Sql.SingleAsync(cs, "select time, longitude, latitude, device, speed, altitude from locationlog", ct: TestContext.Current.CancellationToken);
        Assert.Equal(new DateTime(2026,10,22,7,0,0,DateTimeKind.Utc), row.time);
        Assert.Equal((10.75, 59.91, "phone"), ((double)row.longitude, (double)row.latitude, (string)row.device));
        Assert.Null(row.speed);
        Assert.Equal(12m, row.altitude);
    }

    [Fact]
    public async Task Ingest_is_open_when_no_token_configured()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);

        var res = await PostAsync(api.CreateClient(), OnePoint());

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(1, await CountAsync(cs, "locationlog"));
    }

    [Fact]
    public async Task Ingest_rejects_missing_or_wrong_token()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, new Dictionary<string, string?> { ["OVERLAND_TOKEN"] = "s3cret" });
        var client = api.CreateClient();

        var attempts = new (string Name, string Url, AuthenticationHeaderValue? Authorization)[]
        {
            ("no token", "/api/overland", null),
            ("wrong query token", "/api/overland?token=nope", null),
            ("wrong query token of the same length", "/api/overland?token=s3creX", null),
            ("empty query token", "/api/overland?token=", null),
            ("wrong bearer token", "/api/overland", new AuthenticationHeaderValue("Bearer", "nope")),
            ("right token under another scheme", "/api/overland", new AuthenticationHeaderValue("Basic", "s3cret")),
        };

        foreach (var (name, url, authorization) in attempts)
        {
            var res = await PostAsync(client, OnePoint(), url, authorization);
            Assert.True(res.StatusCode == HttpStatusCode.Unauthorized, $"{name}: expected 401 but got {(int)res.StatusCode}");
            Assert.Equal("", await res.Content.ReadAsStringAsync(Ct));
        }

        Assert.Equal(0, await CountAsync(cs, "locationlog"));
        Assert.Equal(0, await CountAsync(cs, "dirty_range"));
    }

    [Fact]
    public async Task Ingest_accepts_token_in_query_or_bearer_header()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, new Dictionary<string, string?> { ["OVERLAND_TOKEN"] = "s3cret" });
        var client = api.CreateClient();

        var inQuery = await PostAsync(client, OnePoint(), "/api/overland?token=s3cret");
        var inBearer = await PostAsync(client, OnePoint(), authorization: new AuthenticationHeaderValue("Bearer", "s3cret"));
        var lowerCaseScheme = await PostAsync(client, OnePoint(), authorization: new AuthenticationHeaderValue("bearer", "s3cret"));

        Assert.Equal(HttpStatusCode.OK, inQuery.StatusCode);
        Assert.Equal(HttpStatusCode.OK, inBearer.StatusCode);
        Assert.Equal(HttpStatusCode.OK, lowerCaseScheme.StatusCode);
        Assert.Equal("""{"result":"ok"}""", await inQuery.Content.ReadAsStringAsync(Ct));
        Assert.Equal(3, await CountAsync(cs, "locationlog"));
    }

    [Fact]
    public async Task Ingest_reads_token_from_overland_section_and_prefers_OVERLAND_TOKEN()
    {
        var cs = await db.CreateDatabaseAsync(Ct);

        await using (var sectionOnly = new ApiFactory(cs, new Dictionary<string, string?> { ["Overland:Token"] = "from-section" }))
        {
            var client = sectionOnly.CreateClient();
            Assert.Equal(HttpStatusCode.Unauthorized, (await PostAsync(client, OnePoint())).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await PostAsync(client, OnePoint(), "/api/overland?token=from-section")).StatusCode);
        }

        await using (var both = new ApiFactory(cs, new Dictionary<string, string?>
                     {
                         ["OVERLAND_TOKEN"] = "from-env",
                         ["Overland:Token"] = "from-section",
                     }))
        {
            var client = both.CreateClient();
            Assert.Equal(HttpStatusCode.Unauthorized, (await PostAsync(client, OnePoint(), "/api/overland?token=from-section")).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await PostAsync(client, OnePoint(), "/api/overland?token=from-env")).StatusCode);
        }
    }

    [Fact]
    public async Task Startup_warns_once_when_ingest_is_open_and_not_when_a_token_is_set()
    {
        var cs = await db.CreateDatabaseAsync(Ct);

        var openLogs = new CapturingLoggerProvider();
        await using (var open = new ApiFactory(cs).WithWebHostBuilder(b => b.ConfigureLogging(l => l.AddProvider(openLogs))))
            _ = open.CreateClient();

        var tokenLogs = new CapturingLoggerProvider();
        await using (var secured = new ApiFactory(cs, new Dictionary<string, string?> { ["OVERLAND_TOKEN"] = "s3cret" })
                         .WithWebHostBuilder(b => b.ConfigureLogging(l => l.AddProvider(tokenLogs))))
            _ = secured.CreateClient();

        var warning = Assert.Single(openLogs.Entries, e => e.Message.Contains("OVERLAND_TOKEN"));
        Assert.Equal(LogLevel.Warning, warning.Level);
        Assert.DoesNotContain(tokenLogs.Entries, e => e.Message.Contains("OVERLAND_TOKEN"));
    }

    [Fact]
    public async Task Ingest_writes_accuracy_motion_and_dirty_range()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var now = new DateTimeOffset(2026, 10, 22, 7, 10, 0, TimeSpan.Zero);
        await using var api = new ApiFactory(cs, time: new FakeTimeProvider(now));

        // Latest point first, so the range has to come from min/max and not from the batch order.
        var res = await PostAsync(api.CreateClient(), Payload.Many(
            Payload.Point("2026-10-22T07:05:00Z", 10.76, 59.92, speed: 5, altitude: 13, device: "phone",
                horizontalAccuracy: 12, motion: ["driving", "stationary"]),
            Payload.Point("2026-10-22T07:00:00Z", 10.75, 59.91, speed: 1, altitude: 12, device: "phone",
                horizontalAccuracy: 8, motion: ["walking"])));

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(new double?[] {8, 12}, await Sql.QueryAsync<double?>(cs, "select horizontal_accuracy from locationlog order by time", ct: Ct));
        Assert.Equal(new[] {"walking"}, await Sql.ScalarAsync<string[]>(cs, "select motion from locationlog order by time limit 1", ct: Ct));
        Assert.Equal(new[] {"driving", "stationary"}, await Sql.ScalarAsync<string[]>(cs, "select motion from locationlog order by time offset 1 limit 1", ct: Ct));

        Assert.Equal(1, await CountAsync(cs, "dirty_range"));
        var r = await Sql.SingleAsync(cs, "select from_utc, to_utc, created_at, attempts, next_attempt_at, last_error from dirty_range", ct: Ct);
        Assert.Equal((Utc(7,0), Utc(7,5)), ((DateTime)r.from_utc, (DateTime)r.to_utc));
        Assert.Equal(now.UtcDateTime, (DateTime)r.created_at); // from the injected clock, not the database's now()
        Assert.Equal(0, (int)r.attempts);
        Assert.Null(r.next_attempt_at);
        Assert.Null(r.last_error);
    }

    [Fact]
    public async Task Ingest_accepts_sparse_and_offset_payloads()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);

        // A has no speed, accuracy, motion or altitude. B carries a +02:00 offset and is 07:00Z.
        var res = await PostAsync(api.CreateClient(), Payload.Many(
            Payload.Point("2026-10-22T07:05:00Z", 10.76, 59.92, device: "phone"),
            Payload.Point("2026-10-22T09:00:00+02:00", 10.75, 59.91, speed: 1.5, altitude: 3, device: "phone")));

        var body = await res.Content.ReadAsStringAsync(Ct);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("""{"result":"ok"}""", body);

        var times = await Sql.QueryAsync<DateTime>(cs, "select time from locationlog order by time", ct: Ct);
        Assert.Equal(new[] {Utc(7,0), Utc(7,5)}, times);   // B (09:00+02:00) stored as 07:00Z

        var a = await Sql.SingleAsync(cs, "select speed, altitude, horizontal_accuracy, motion from locationlog where time = @time", new { time = Utc(7,5) }, Ct);
        Assert.Null(a.speed);
        Assert.Equal(0m, a.altitude);
        Assert.Null(a.horizontal_accuracy);
        Assert.Null(a.motion);

        var r = await Sql.SingleAsync(cs, "select from_utc, to_utc from dirty_range", ct: Ct);
        Assert.Equal((Utc(7,0), Utc(7,5)), ((DateTime)r.from_utc, (DateTime)r.to_utc));
    }

    [Fact]
    public async Task Ingest_keeps_points_when_secondary_writes_fail()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var logs = new CapturingLoggerProvider();
        await using var api = new ApiFactory(cs).WithWebHostBuilder(b => b.ConfigureLogging(l => l.AddProvider(logs)));
        var client = api.CreateClient(); // starting the host runs the migrations
        await Sql.ExecAsync(cs, "drop table dirty_range", ct: Ct);

        var res = await PostAsync(client, OnePoint());

        var body = await res.Content.ReadAsStringAsync(Ct);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("""{"result":"ok"}""", body);
        Assert.Equal(1, await Sql.ScalarAsync<long>(cs, "select count(*) from locationlog", ct: Ct));

        var error = Assert.Single(logs.Entries, e => e.Level >= LogLevel.Error);
        Assert.EndsWith("ConsumeEndpoint", error.Category);
        Assert.NotNull(error.Exception);
        Assert.Contains("2026-10-22T07:00:00", error.Message); // names the range, so it can be re-marked dirty
    }

    [Fact]
    public async Task Ingest_duplicate_batch_does_not_fail()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        var first = await PostAsync(client, OnePoint());
        var second = await PostAsync(client, OnePoint());

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.Equal("""{"result":"ok"}""", await second.Content.ReadAsStringAsync(Ct));
    }

    [Fact]
    public async Task Ingest_empty_batch_returns_ok_and_writes_nothing()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);

        var res = await PostAsync(api.CreateClient(), Payload.Many());

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("""{"result":"ok"}""", await res.Content.ReadAsStringAsync(Ct));
        Assert.Equal(0, await CountAsync(cs, "locationlog"));
        Assert.Equal(0, await CountAsync(cs, "dirty_range"));
    }

    private sealed record LogEntry(LogLevel Level, string Category, string Message, Exception? Exception);

    private sealed class CapturingLoggerProvider : ILoggerProvider
    {
        private readonly ConcurrentQueue<LogEntry> _entries = new();

        public IReadOnlyCollection<LogEntry> Entries => _entries;

        public ILogger CreateLogger(string categoryName) => new CapturingLogger(categoryName, _entries);

        public void Dispose()
        {
        }

        private sealed class CapturingLogger(string category, ConcurrentQueue<LogEntry> entries) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
                Func<TState, Exception?, string> formatter)
                => entries.Enqueue(new LogEntry(logLevel, category, formatter(state, exception), exception));
        }
    }
}
