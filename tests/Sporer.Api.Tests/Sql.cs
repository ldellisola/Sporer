using Dapper;
using Npgsql;

namespace Sporer.Api.Tests;

/// <summary>Small Dapper wrappers so tests can run SQL against a test database in one line.</summary>
public static class Sql
{
    public static async Task ExecAsync(string connectionString, string sql, object? param = null)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.ExecuteAsync(sql, param);
    }

    public static async Task<dynamic> SingleAsync(string connectionString, string sql, object? param = null)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        return await connection.QuerySingleAsync(sql, param);
    }

    public static async Task<T?> ScalarAsync<T>(string connectionString, string sql, object? param = null)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        return await connection.ExecuteScalarAsync<T>(sql, param);
    }

    public static async Task<IReadOnlyList<dynamic>> QueryAsync(string connectionString, string sql, object? param = null)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        return (await connection.QueryAsync(sql, param)).AsList();
    }
}
