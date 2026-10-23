using Dapper;
using Npgsql;

namespace Sporer.Api.Database;

/// <summary>
/// Looks for TimescaleDB settings on <c>locationLog</c> that could delete or complicate raw points.
/// Reads catalog views only; it never changes anything. It runs before the migrations, so that what it finds is reported
/// even if a migration then fails, and startup must not depend on it: a check that cannot run (another TimescaleDB
/// version, missing views, a column of another type, connection trouble) is reported as a warning instead of an exception.
/// There is nothing to inspect, and so nothing to report, before <c>locationLog</c> exists (a new database).
/// </summary>
public static class DatabaseInspector
{
    public static async Task<IReadOnlyList<string>> InspectAsync(NpgsqlDataSource dataSource, CancellationToken ct = default)
    {
        var warnings = new List<string>();

        await CheckAsync(warnings, "retention policies", dataSource, ct, async connection =>
        {
            var retentionPolicies = await connection.ExecuteScalarAsync<int>(new CommandDefinition(
                """
                select count(*) from timescaledb_information.jobs
                where proc_name = 'policy_retention' and hypertable_name = 'locationlog'
                """, cancellationToken: ct));

            return retentionPolicies > 0
                ? "A retention policy exists on locationLog. It deletes raw location points as they age."
                : null;
        });

        await CheckAsync(warnings, "compression", dataSource, ct, async connection =>
        {
            var compressionEnabled = await connection.ExecuteScalarAsync<bool?>(new CommandDefinition(
                "select compression_enabled from timescaledb_information.hypertables where hypertable_name = 'locationlog'",
                cancellationToken: ct));

            return compressionEnabled == true
                ? "Compression is enabled on locationLog. On some TimescaleDB versions it affects adding columns and late inserts."
                : null;
        });

        return warnings;
    }

    /// <summary>
    /// Runs one check on its own connection; any failure except cancellation becomes a warning, never an exception.
    /// Skipped when <c>locationLog</c> does not exist.
    /// </summary>
    private static async Task CheckAsync(
        List<string> warnings,
        string what,
        NpgsqlDataSource dataSource,
        CancellationToken ct,
        Func<NpgsqlConnection, Task<string?>> check)
    {
        try
        {
            await using var connection = await dataSource.OpenConnectionAsync(ct);
            if (await connection.ExecuteScalarAsync<bool>(new CommandDefinition("select to_regclass('locationlog') is null", cancellationToken: ct)))
                return;

            if (await check(connection) is { } warning)
                warnings.Add(warning);
        }
        catch (Exception ex) when (ex is not OperationCanceledException) // a database error, or one from converting what it returned
        {
            warnings.Add($"Could not check {what} on locationLog: {ex.Message}");
        }
    }
}
