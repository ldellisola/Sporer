using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Npgsql;
using Sporer.Api.Database;

namespace Sporer.Api.Tests;

[Collection("db")]
public class MigrationTests(DatabaseFixture db)
{
    // The table exactly as the original src/Sporer.Api/DB/01-Create-table.sql created it,
    // applied by hand on the owner's database before migrations existed.
    private const string OldCreateTableScript = """
        CREATE EXTENSION if not exists timescaledb;

        CREATE TABLE locationLog (
            time      TIMESTAMPTZ       NOT NULL,
            longitude DOUBLE precision  NOT NULL,
            latitude  DOUBLE PRECISION  NOT NULL,
            device    text              NOT NULL,
            speed     DOUBLE PRECISION  NULL,
            altitude  numeric           NOT NULL
        );

        SELECT create_hypertable('locationLog', by_range('time'));
        """;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<IReadOnlyList<string>> ColumnNames(string cs, string table)
        => (await Columns(cs, table)).Select(c => c.Name).ToList();

    private static async Task<IReadOnlyList<(string Name, string DataType, string IsNullable)>> Columns(string cs, string table)
        => (await Sql.QueryAsync(cs, """
                select column_name, data_type, is_nullable
                from information_schema.columns
                where table_schema = 'public' and table_name = @table
                order by ordinal_position
                """, new { table }, Ct))
            .Select(r => ((string)r.column_name, (string)r.data_type, (string)r.is_nullable))
            .ToList();

    private static async Task<IReadOnlyList<(string Name, string Definition)>> Indexes(string cs, string table)
        => (await Sql.QueryAsync(cs,
                "select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = @table order by indexname",
                new { table }, Ct))
            .Select(r => ((string)r.indexname, (string)r.indexdef))
            .ToList();

    private static async Task<IReadOnlyList<(DateTime Time, double Longitude, double Latitude, string Device, double? Speed, decimal Altitude)>> Rows(string cs)
        => (await Sql.QueryAsync(cs,
                "select time, longitude, latitude, device, speed, altitude from locationlog order by time", ct: Ct))
            .Select(r => ((DateTime)r.time, (double)r.longitude, (double)r.latitude, (string)r.device, (double?)r.speed, (decimal)r.altitude))
            .ToList();

    private static DatabaseWarnings Warnings(ApiFactory api) => api.Services.GetRequiredService<DatabaseWarnings>();

    [Fact]
    public async Task Migrates_fresh_database()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        _ = api.Services; // starting the host runs the migrations

        Assert.Equal(
            new[] { "time", "longitude", "latitude", "device", "speed", "altitude", "horizontal_accuracy", "motion" },
            await ColumnNames(cs, "locationlog"));
        Assert.True(await Sql.ScalarAsync<bool>(cs, "select to_regclass('dirty_range') is not null", ct: Ct));
        foreach (var table in new[] { "place", "segment", "geocode_cache", "processing_state" })
            Assert.True(await Sql.ScalarAsync<bool>(cs, $"select to_regclass('{table}') is not null", ct: Ct), table);
        Assert.Equal(1, await Sql.ScalarAsync<long>(cs, "select count(*) from processing_state where id = 1", ct: Ct));
        Assert.Contains(("backfill_chunk_attempts", "integer", "NO"), await Columns(cs, "processing_state"));
        Assert.Equal(0, await Sql.ScalarAsync<int>(cs, "select backfill_chunk_attempts from processing_state where id = 1", ct: Ct));
        Assert.Empty(Warnings(api).Items);
    }

    [Fact]
    public async Task Migrates_existing_database_keeping_rows()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await Sql.ExecAsync(cs, OldCreateTableScript, ct: Ct);
        await Sql.ExecAsync(cs, """
            insert into locationlog (time, longitude, latitude, device, speed, altitude) values
              ('2026-01-01T08:00:00Z', 10.10, 59.10, 'phone-a', 1.5, 11),
              ('2026-01-01T08:05:00Z', 10.20, 59.20, 'phone-a', null, 12.5),
              ('2026-02-03T09:00:00Z', 10.30, 59.30, 'phone-b', 0, 13)
            """, ct: Ct);
        var columnsBefore = await Columns(cs, "locationlog");
        var indexesBefore = await Indexes(cs, "locationlog");
        var rowsBefore = await Rows(cs);
        Assert.Equal(3, rowsBefore.Count);

        await using var api = new ApiFactory(cs);
        _ = api.Services;

        Assert.Equal(
            columnsBefore.Concat(new[] { ("horizontal_accuracy", "double precision", "YES"), ("motion", "ARRAY", "YES") }),
            await Columns(cs, "locationlog"));
        Assert.Equal(indexesBefore, await Indexes(cs, "locationlog"));
        Assert.Equal(rowsBefore, await Rows(cs));
        Assert.Equal(0, await Sql.ScalarAsync<int>(cs,
            "select count(*) from locationlog where horizontal_accuracy is not null or motion is not null", ct: Ct));
    }

    [Fact]
    public async Task Second_startup_does_not_run_migrations_again()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using (var first = new ApiFactory(cs))
            _ = first.Services;
        var applied = await Sql.ScalarAsync<int>(cs, "select count(*) from schemaversions", ct: Ct);
        Assert.Equal(4, applied);

        await using var second = new ApiFactory(cs);
        _ = second.Services;

        Assert.Equal(applied, await Sql.ScalarAsync<int>(cs, "select count(*) from schemaversions", ct: Ct));
    }

    [Fact]
    public async Task Rerunning_every_script_on_a_migrated_database_succeeds_and_changes_nothing()
    {
        // DbUp journals scripts by name: if the journal is lost, or a script is renamed, they all run again.
        var cs = await db.CreateDatabaseAsync(Ct);
        await using (var first = new ApiFactory(cs))
            _ = first.Services;
        await Sql.ExecAsync(cs, "insert into locationlog (time, longitude, latitude, device, speed, altitude) values ('2026-01-01T08:00:00Z', 10.1, 59.1, 'phone', 1, 11)", ct: Ct);
        await Sql.ExecAsync(cs, "update processing_state set algorithm_version = '1:abc', backfill_cursor = '2026-01-01T00:00:00Z', last_error = 'kept'", ct: Ct);
        var placeId = await Sql.ScalarAsync<long>(cs, "insert into place (latitude, longitude, user_name) values (59.1, 10.1, 'Mine') returning id", ct: Ct);
        await Sql.ExecAsync(cs,
            """
            insert into segment (kind, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date, place_id)
            values ('stay', '2026-01-01T08:00:00Z', '2026-01-01T09:00:00Z', 'Europe/Oslo', 'Europe/Oslo', '2026-01-01', '2026-01-01', @placeId)
            """, new { placeId }, Ct);
        await Sql.ExecAsync(cs, "insert into dirty_range (from_utc, to_utc) values ('2026-01-01T08:00:00Z', '2026-01-01T09:00:00Z')", ct: Ct);
        var tables = new[] { "locationlog", "dirty_range", "place", "segment", "geocode_cache", "processing_state" };
        var columns = new Dictionary<string, IReadOnlyList<(string, string, string)>>();
        var indexes = new Dictionary<string, IReadOnlyList<(string, string)>>();
        foreach (var table in tables)
        {
            columns[table] = await Columns(cs, table);
            indexes[table] = await Indexes(cs, table);
        }
        await Sql.ExecAsync(cs, "delete from schemaversions", ct: Ct);

        await using var second = new ApiFactory(cs);
        _ = second.Services; // does not throw

        Assert.Equal(4, await Sql.ScalarAsync<int>(cs, "select count(*) from schemaversions", ct: Ct));
        foreach (var table in tables)
        {
            Assert.Equal(columns[table], await Columns(cs, table));
            Assert.Equal(indexes[table], await Indexes(cs, table));
        }
        Assert.Equal(1, await Sql.ScalarAsync<long>(cs, "select count(*) from locationlog", ct: Ct));
        Assert.Equal(1, await Sql.ScalarAsync<long>(cs, "select count(*) from place where user_name = 'Mine'", ct: Ct));
        Assert.Equal(1, await Sql.ScalarAsync<long>(cs, "select count(*) from segment", ct: Ct));
        Assert.Equal(1, await Sql.ScalarAsync<long>(cs, "select count(*) from dirty_range", ct: Ct));
        var state = await Sql.SingleAsync(cs, "select count(*) over () as n, algorithm_version, last_error from processing_state", ct: Ct);
        Assert.Equal((1L, "1:abc", "kept"), ((long)state.n, (string)state.algorithm_version, (string)state.last_error)); // still the one row, not reset
    }

    [Fact]
    public async Task Warns_when_retention_policy_exists()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await Sql.ExecAsync(cs, OldCreateTableScript, ct: Ct);
        await Sql.ExecAsync(cs, "SELECT add_retention_policy('locationlog', INTERVAL '5 years')", ct: Ct);

        await using var api = new ApiFactory(cs);

        Assert.Contains(Warnings(api).Items, w => w.Contains("retention", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Warns_when_compression_enabled()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await Sql.ExecAsync(cs, OldCreateTableScript, ct: Ct);
        // Test setup on a throwaway database only; the application never alters compression.
        await Sql.ExecAsync(cs, "ALTER TABLE locationlog SET (timescaledb.compress)", ct: Ct);

        await using var api = new ApiFactory(cs);

        Assert.Contains(Warnings(api).Items, w => w.Contains("compression", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(
            new[] { "time", "longitude", "latitude", "device", "speed", "altitude", "horizontal_accuracy", "motion" },
            await ColumnNames(cs, "locationlog"));
    }

    [Fact]
    public async Task Inspection_failures_become_warnings_instead_of_throwing()
    {
        // Without the timescaledb extension there are no timescaledb_information views, like on a
        // TimescaleDB version whose catalog differs: every check fails. The test image installs the
        // extension in template1, so a new database has it and the test drops it (throwaway DB only).
        var cs = await db.CreateDatabaseAsync(Ct);
        await Sql.ExecAsync(cs, "DROP EXTENSION IF EXISTS timescaledb", ct: Ct);
        await Sql.ExecAsync(cs, "CREATE TABLE locationLog (time timestamptz NOT NULL)", ct: Ct); // there is a table to inspect
        Assert.False(await Sql.ScalarAsync<bool>(cs, "select to_regnamespace('timescaledb_information') is not null", ct: Ct));
        await using var dataSource = NpgsqlDataSource.Create(cs);

        var warnings = await DatabaseInspector.InspectAsync(dataSource, Ct);

        Assert.Equal(2, warnings.Count);
        Assert.Contains(warnings, w => w.StartsWith("Could not check retention", StringComparison.Ordinal));
        Assert.Contains(warnings, w => w.StartsWith("Could not check compression", StringComparison.Ordinal));
        Assert.All(warnings, w => Assert.Contains("timescaledb_information", w));
    }

    [Fact]
    public async Task Inspection_failures_of_any_kind_become_warnings()
    {
        // A catalog whose column has another type than expected fails in the driver's conversion, not in the database:
        // the exception is not an NpgsqlException, and the check must still only warn.
        var cs = await db.CreateDatabaseAsync(Ct);
        await Sql.ExecAsync(cs, "DROP EXTENSION IF EXISTS timescaledb", ct: Ct);
        await Sql.ExecAsync(cs,
            """
            CREATE TABLE locationLog (time timestamptz NOT NULL);
            CREATE SCHEMA timescaledb_information;
            CREATE VIEW timescaledb_information.jobs AS SELECT 'policy_retention'::text AS proc_name, 'locationlog'::text AS hypertable_name;
            CREATE VIEW timescaledb_information.hypertables AS SELECT 'locationlog'::text AS hypertable_name, 'perhaps'::text AS compression_enabled;
            """, ct: Ct);
        await using var dataSource = NpgsqlDataSource.Create(cs);

        var warnings = await DatabaseInspector.InspectAsync(dataSource, Ct);

        Assert.Equal(2, warnings.Count);
        Assert.Contains(warnings, w => w.Contains("retention policy exists", StringComparison.OrdinalIgnoreCase)); // the check that worked
        Assert.Contains(warnings, w => w.StartsWith("Could not check compression", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Inspection_has_nothing_to_say_before_locationlog_exists()
    {
        // A new database is inspected before the migrations have created anything, perhaps without even the extension.
        var cs = await db.CreateDatabaseAsync(Ct);
        await Sql.ExecAsync(cs, "DROP EXTENSION IF EXISTS timescaledb", ct: Ct);
        await using var dataSource = NpgsqlDataSource.Create(cs);

        Assert.Empty(await DatabaseInspector.InspectAsync(dataSource, Ct));
    }

    [Fact]
    public async Task Warnings_about_locationlog_are_logged_even_when_a_migration_then_fails()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await Sql.ExecAsync(cs, OldCreateTableScript, ct: Ct);
        await Sql.ExecAsync(cs, "SELECT add_retention_policy('locationlog', INTERVAL '5 years')", ct: Ct);
        await Sql.ExecAsync(cs, "CREATE TABLE segment (unrelated int)", ct: Ct); // not the table 0003 expects: it cannot index it
        var log = new CapturingLoggerProvider();
        await using var api = new ApiFactory(cs, configureServices: services => services.AddSingleton<ILoggerProvider>(log));

        Assert.ThrowsAny<Exception>(() => api.Services); // the app does not start

        Assert.Contains(log.Messages, m => m.Contains("retention", StringComparison.OrdinalIgnoreCase));
    }

    private sealed class CapturingLoggerProvider : ILoggerProvider
    {
        private readonly System.Collections.Concurrent.ConcurrentQueue<string> _messages = new();

        public IEnumerable<string> Messages => _messages;

        public ILogger CreateLogger(string categoryName) => new Capture(_messages);

        public void Dispose()
        {
        }

        private sealed class Capture(System.Collections.Concurrent.ConcurrentQueue<string> messages) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
                => messages.Enqueue(formatter(state, exception));
        }
    }
}
