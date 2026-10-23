using Npgsql;
using Testcontainers.PostgreSql;

namespace Sporer.Api.Tests;

/// <summary>
/// One TimescaleDB container shared by every test in the "db" collection.
/// Each test asks for its own empty database so tests stay independent.
/// </summary>
public sealed class DatabaseFixture : IAsyncLifetime
{
    // Every test gets its own database and so its own connection pool, and a pool keeps its idle connections for minutes:
    // across a whole run they add up to more than PostgreSQL's default of 100 connections.
    private readonly PostgreSqlContainer _container =
        new PostgreSqlBuilder("timescale/timescaledb:2.17.2-pg16").WithCommand("-c", "max_connections=1000").Build();

    public async ValueTask InitializeAsync() => await _container.StartAsync();

    public async ValueTask DisposeAsync() => await _container.DisposeAsync();

    /// <summary>Creates a fresh, empty database and returns its connection string.</summary>
    public async Task<string> CreateDatabaseAsync(CancellationToken ct = default)
    {
        var name = $"t_{Guid.NewGuid():N}";

        await using (var admin = new NpgsqlConnection(_container.GetConnectionString()))
        {
            await admin.OpenAsync(ct);
            await using var command = admin.CreateCommand();
            command.CommandText = $"CREATE DATABASE {name}";
            await command.ExecuteNonQueryAsync(ct);
        }

        return new NpgsqlConnectionStringBuilder(_container.GetConnectionString()) { Database = name }
            .ConnectionString;
    }
}

[CollectionDefinition("db")]
public sealed class DatabaseCollection : ICollectionFixture<DatabaseFixture>;
