using System.Net;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Npgsql;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// The warm-up that runs once in the background after a start (<see cref="TripWarmUp"/>): it reads the nights and works the homes and trips
/// out in memory, so that the first refresh and the first edit do not compile that code while the owner waits, and it writes nothing, takes
/// no lock, never holds up the start or ingest, and never stops the app when it fails.
/// </summary>
[Collection("db")]
public class TripWarmUpTests(DatabaseFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime Utc(int month, int day, int hour = 0) => new(2026, month, day, hour, 0, 0, DateTimeKind.Utc);

    private static Task<long> StayAsync(string cs, DateTime start, DateTime end, long place, GeoPoint at, string zone = "Europe/Oslo")
        => TimelineSeeder.InsertSegmentAsync(cs, "stay", start, end, LocalTime.LocalDate(start, zone), LocalTime.LocalDate(end, zone),
            zone, placeId: place, lat: at.Latitude, lon: at.Longitude);

    /// <summary>100 nights at home, three in Lisbon, then three more at home: 106 nights, one home period and one trip.</summary>
    private static async Task SeedOneTripAsync(string cs)
    {
        var home = await TimelineSeeder.InsertPlaceAsync(cs, lat: Spots.Home.Latitude, lon: Spots.Home.Longitude);
        var lisbon = await TimelineSeeder.InsertPlaceAsync(cs, lat: Spots.Lisbon.Latitude, lon: Spots.Lisbon.Longitude);
        await StayAsync(cs, Utc(3, 31, 12), Utc(7, 9, 7), home, Spots.Home);
        await StayAsync(cs, Utc(7, 9, 12), Utc(7, 12, 8), lisbon, Spots.Lisbon, "Europe/Lisbon");
        await StayAsync(cs, Utc(7, 12, 14), Utc(7, 15, 12), home, Spots.Home);
    }

    private sealed record TableState(string Table, long Rows, string Content);

    /// <summary>
    /// What every table of the app holds: its rows, and the transaction that wrote each of them (<c>xmin</c>), so that a row written again with
    /// the very same values is a change too.
    /// </summary>
    private static async Task<IReadOnlyList<TableState>> SnapshotAsync(string cs)
    {
        string[] tables =
        [
            "night", "home_period", "trip", "trip_edit", "app_setting", "night_refresh", "dirty_range", "segment", "place",
            "processing_state", "excluded_point", "geocode_cache", "locationlog",
        ];
        var sql = string.Join(" union all ", tables.Select(t =>
            $"select '{t}' as Table, count(*) as Rows, coalesce(md5(string_agg(x::text || ':' || x.xmin::text, ',' order by x::text)), '') as Content from {t} x"));
        return await Sql.QueryAsync<TableState>(cs, sql, ct: Ct);
    }

    /// <summary>A refresh that is waiting, a dirty range and an edit of the owner's, so that every table a warm-up could touch holds something.</summary>
    private static async Task LeaveSomethingInEveryTableAsync(string cs)
    {
        await Sql.ExecAsync(cs, "update night_refresh set from_utc = @from, to_utc = @to where id = 1", new { from = Utc(7, 1), to = Utc(7, 2) }, Ct);
        await TimelineSeeder.InsertDirtyRangeAsync(cs, Utc(7, 10), Utc(7, 11));
        await Sql.ExecAsync(cs, "insert into app_setting (key, value, updated_at) values ('tripMinDistanceKm', to_jsonb(60.0::double precision), now())", ct: Ct);
        await Sql.ExecAsync(cs, "insert into trip_edit (detected_id, detected_last_night, name) values ('2026-07-09', '2026-07-11', 'Lisbon')", ct: Ct);
    }

    private static string CategoryOf<T>() => typeof(T).FullName!;

    /// <summary>What the warm-up logs when it is done: the Information entry, which a warning for a failure is not.</summary>
    private static bool Warmed(LogEntry entry) => entry.Category == CategoryOf<TripWarmUp>() && entry.Level == LogLevel.Information;

    private static async Task WaitForAsync(Func<bool> condition, string what)
    {
        var until = DateTime.UtcNow.AddSeconds(20);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < until, $"timed out waiting for {what}");
            await Task.Delay(25, Ct);
        }
    }

    private static ApiFactory Api(string cs, CapturingLoggerProvider log, bool processing = false)
        => new(cs, new Dictionary<string, string?> { ["Processing:Enabled"] = processing ? "true" : "false" },
            configureServices: services => services.AddSingleton<ILoggerProvider>(log));

    /// <summary>Lets the worker note the algorithm version on an empty database, so that a host that runs it has no backfill to restart.</summary>
    private static async Task SettleTheWorkerAsync(string cs)
    {
        await using var api = new ApiFactory(cs);
        await api.Services.GetRequiredService<TimelineWorker>().RunOnceAsync(Ct);
    }

    [Fact]
    public async Task The_warm_up_works_the_homes_and_trips_out_and_writes_nothing()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var log = new CapturingLoggerProvider();
        await using var api = Api(cs, log);
        var refresher = api.Services.GetRequiredService<ITripRefresher>(); // starting the host runs the migrations
        await SeedOneTripAsync(cs);
        await refresher.RefreshAsync(Utc(4, 1), Utc(7, 15, 12), Ct);
        await LeaveSomethingInEveryTableAsync(cs);
        // What is stored is made different from what the nights say, and the owner's edit and a setting are in: a warm-up that wrote
        // (a recompute does) would change the trips, and one that cleared the window would be seen too.
        await Sql.ExecAsync(cs, "update trip set nights = 99; delete from home_period", ct: Ct);
        var before = await SnapshotAsync(cs);

        Assert.True(await api.Services.GetRequiredService<TripWarmUp>().RunAsync(Ct));

        Assert.Equal(before, await SnapshotAsync(cs));
        Assert.Equal(99, await Sql.ScalarAsync<int>(cs, "select nights from trip", ct: Ct));
        // It did the work, though: it says what it found (106 nights, the home from the first of them, one trip).
        var done = Assert.Single(log.Entries, e => e.Category == CategoryOf<TripWarmUp>());
        Assert.Equal(LogLevel.Information, done.Level);
        Assert.Contains("106 nights, 1 home periods, 1 trips", done.Message);
    }

    [Fact]
    public async Task The_warm_up_does_not_wait_for_the_lock_that_a_refresh_holds_while_it_writes()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = Api(cs, new CapturingLoggerProvider());
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        await SeedOneTripAsync(cs);
        await refresher.RefreshAsync(Utc(4, 1), Utc(7, 15, 12), Ct);
        var before = await SnapshotAsync(cs);

        await using (await AdvisoryLockHolder.HoldAsync(cs, Ct))
        {
            // A warm-up that asked for the lock would wait here until the 20 seconds are over.
            Assert.True(await api.Services.GetRequiredService<TripWarmUp>().RunAsync(Ct).WaitAsync(TimeSpan.FromSeconds(20), Ct));
            Assert.Equal(0, await AdvisoryLockHolder.WaitersAsync(cs, Ct));
        }

        Assert.Equal(before, await SnapshotAsync(cs));
    }

    [Fact]
    public async Task A_warm_up_that_fails_is_logged_as_a_warning_and_gives_no_error()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var log = new CapturingLoggerProvider();
        await using var api = Api(cs, log);
        var warmUp = api.Services.GetRequiredService<TripWarmUp>();
        await Sql.ExecAsync(cs, "alter table night rename to night_away", ct: Ct);

        Assert.False(await warmUp.RunAsync(Ct)); // does not throw

        var failed = Assert.Single(log.Entries, e => e.Category == CategoryOf<TripWarmUp>());
        Assert.Equal(LogLevel.Warning, failed.Level);
        Assert.IsType<PostgresException>(failed.Exception);
        Assert.Contains("failed", failed.Message);
    }

    [Fact]
    public async Task A_warm_up_that_is_stopped_is_not_a_failure()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var log = new CapturingLoggerProvider();
        await using var api = Api(cs, log);
        using var stopped = new CancellationTokenSource();
        await stopped.CancelAsync();

        Assert.False(await api.Services.GetRequiredService<TripWarmUp>().RunAsync(stopped.Token));

        Assert.DoesNotContain(log.Entries, e => e.Category == CategoryOf<TripWarmUp>());
    }

    [Fact]
    public async Task The_warm_up_runs_in_the_background_only_when_processing_is_enabled()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await SettleTheWorkerAsync(cs);

        await using (var off = Api(cs, new CapturingLoggerProvider())) // Processing:Enabled=false, as in every test
        {
            Assert.NotNull(off.Services.GetService<TripWarmUp>()); // still there to be driven by hand
            Assert.Empty(off.Services.GetServices<IHostedService>().OfType<TripWarmUp>());
        }

        var log = new CapturingLoggerProvider();
        await using var on = Api(cs, log, processing: true);
        var hosted = Assert.Single(on.Services.GetServices<IHostedService>().OfType<TripWarmUp>());
        Assert.Same(on.Services.GetRequiredService<TripWarmUp>(), hosted); // one warm-up, not a second copy
        await WaitForAsync(() => log.Entries.Any(Warmed), "the warm-up to run once the host is up");
        // Once, and it worked: on the first start, with no night stored yet, it finds nothing and says so, not a failure.
        var done = Assert.Single(log.Entries, e => e.Category == CategoryOf<TripWarmUp>());
        Assert.Equal(LogLevel.Information, done.Level);
        Assert.Contains("0 nights, 0 home periods, 0 trips", done.Message);
    }

    [Fact]
    public async Task A_warm_up_that_fails_in_the_background_does_not_stop_the_app()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await SettleTheWorkerAsync(cs);
        await Sql.ExecAsync(cs, "alter table night rename to night_away", ct: Ct);
        var log = new CapturingLoggerProvider();

        await using var api = Api(cs, log, processing: true);
        var client = api.CreateClient();

        await WaitForAsync(() => log.Entries.Any(e => e.Category == CategoryOf<TripWarmUp>() && e.Level == LogLevel.Warning), "the failed warm-up to be logged");
        // The host is up and answers, as a background service that throws would have stopped it.
        using var status = await client.GetAsync("/api/status", Ct);
        Assert.Equal(HttpStatusCode.OK, status.StatusCode);
        Assert.DoesNotContain(log.Entries, e => e.Category == CategoryOf<TripWarmUp>() && e.Level >= LogLevel.Error);
    }

    [Fact]
    public async Task The_warm_up_holds_up_neither_the_start_nor_ingest()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await SettleTheWorkerAsync(cs);
        var log = new CapturingLoggerProvider();

        // The night table is locked, so that the warm-up cannot read it until the lock is let go.
        await using var locked = new NpgsqlConnection(cs);
        await locked.OpenAsync(Ct);
        await using var transaction = await locked.BeginTransactionAsync(Ct);
        await using (var lockTable = new NpgsqlCommand("lock table night in access exclusive mode", locked, transaction))
            await lockTable.ExecuteNonQueryAsync(Ct);

        await using var api = Api(cs, log, processing: true);
        var client = api.CreateClient(); // the host has started: it did not wait for the warm-up
        using var body = new StringContent(Payload.One(time: "2026-07-09T10:00:00Z", lon: 10.75, lat: 59.92, speed: -1, altitude: 12, device: "phone"), Encoding.UTF8, "application/json");
        using var ingested = await client.PostAsync("/api/overland", body, Ct);

        Assert.Equal(HttpStatusCode.OK, ingested.StatusCode);
        Assert.Equal(1, await Sql.ScalarAsync<long>(cs, "select count(*) from locationlog", ct: Ct));
        Assert.DoesNotContain(log.Entries, e => e.Category == CategoryOf<TripWarmUp>()); // still waiting for the table

        await transaction.RollbackAsync(Ct);
        await WaitForAsync(() => log.Entries.Any(Warmed), "the warm-up to finish once the table is free");
        Assert.DoesNotContain(log.Entries, e => e.Category == CategoryOf<TripWarmUp>() && e.Level >= LogLevel.Warning);
    }
}
