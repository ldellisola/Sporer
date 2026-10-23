using Dapper;
using Npgsql;

namespace Sporer.Api.Tests;

/// <summary>Small Dapper wrappers so tests can run SQL against a test database in one line.</summary>
public static class Sql
{
    public static async Task ExecAsync(string connectionString, string sql, object? param = null, CancellationToken ct = default)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.ExecuteAsync(new CommandDefinition(sql, param, cancellationToken: ct));
    }

    public static async Task<dynamic> SingleAsync(string connectionString, string sql, object? param = null, CancellationToken ct = default)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        return await connection.QuerySingleAsync(new CommandDefinition(sql, param, cancellationToken: ct));
    }

    /// <remarks>Returns <c>default</c> on SQL NULL, so use a nullable <typeparamref name="T"/> where NULL is possible.</remarks>
    public static async Task<T?> ScalarAsync<T>(string connectionString, string sql, object? param = null, CancellationToken ct = default)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        return await connection.ExecuteScalarAsync<T>(new CommandDefinition(sql, param, cancellationToken: ct));
    }

    public static async Task<IReadOnlyList<dynamic>> QueryAsync(string connectionString, string sql, object? param = null, CancellationToken ct = default)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        return (await connection.QueryAsync(new CommandDefinition(sql, param, cancellationToken: ct))).AsList();
    }
}
