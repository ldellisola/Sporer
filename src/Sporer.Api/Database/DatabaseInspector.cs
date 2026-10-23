using Dapper;
using Npgsql;

namespace Sporer.Api.Database;

/// <summary>
/// Looks for TimescaleDB settings on <c>locationLog</c> that could delete or complicate raw points.
/// Reads catalog views only; it never changes anything.
/// </summary>
public static class DatabaseInspector
{
    public static async Task<IReadOnlyList<string>> InspectAsync(NpgsqlDataSource dataSource, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var warnings = new List<string>();

        var retentionPolicies = await connection.ExecuteScalarAsync<int>(new CommandDefinition(
            """
            select count(*) from timescaledb_information.jobs
            where proc_name = 'policy_retention' and hypertable_name = 'locationlog'
            """, cancellationToken: ct));
        if (retentionPolicies > 0)
            warnings.Add("A retention policy exists on locationLog. It deletes raw location points as they age.");

        var compressionEnabled = await connection.ExecuteScalarAsync<bool?>(new CommandDefinition(
            "select compression_enabled from timescaledb_information.hypertables where hypertable_name = 'locationlog'",
            cancellationToken: ct));
        if (compressionEnabled == true)
            warnings.Add("Compression is enabled on locationLog. On some TimescaleDB versions it affects adding columns and late inserts.");

        return warnings;
    }
}
