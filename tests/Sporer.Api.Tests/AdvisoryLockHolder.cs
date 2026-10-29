using Npgsql;
using Sporer.Api.Features.Trips;

namespace Sporer.Api.Tests;

/// <summary>
/// Somebody else holding the lock that the nights, homes and trips are written under (<see cref="TripRefresher.AdvisoryLockKey"/>), as a refresh
/// or a recompute does while it works, for the tests of what waits for it. <see cref="WaitForWaitersAsync"/> is how a test knows that what it
/// started is asking for the lock, without a wait of a fixed length. Disposing it lets go (by rolling back, if <see cref="ReleaseAsync"/>
/// has not committed), so that a test that fails does not leave the lock held.
/// </summary>
internal sealed class AdvisoryLockHolder : IAsyncDisposable
{
    private readonly NpgsqlConnection _connection;
    private readonly NpgsqlTransaction _transaction;

    private AdvisoryLockHolder(NpgsqlConnection connection, NpgsqlTransaction transaction)
    {
        _connection = connection;
        _transaction = transaction;
    }

    /// <summary>Takes the lock on a connection of its own, and holds it until <see cref="ReleaseAsync"/> or the disposal.</summary>
    public static async Task<AdvisoryLockHolder> HoldAsync(string cs, CancellationToken ct)
    {
        var connection = new NpgsqlConnection(cs);
        try
        {
            await connection.OpenAsync(ct);
            var transaction = await connection.BeginTransactionAsync(ct);
            await using var take = new NpgsqlCommand("select pg_advisory_xact_lock(@key)", connection, transaction);
            take.Parameters.AddWithValue("key", TripRefresher.AdvisoryLockKey);
            await take.ExecuteNonQueryAsync(ct);
            return new AdvisoryLockHolder(connection, transaction);
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    /// <summary>How many sessions of the database wait for an advisory lock.</summary>
    public static Task<long> WaitersAsync(string cs, CancellationToken ct) => Sql.ScalarAsync<long>(cs,
        """
        select count(*) from pg_locks
        where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())
        """, ct: ct);

    /// <summary>
    /// Returns once <paramref name="count"/> sessions wait for an advisory lock, and fails if one of <paramref name="started"/> is done before
    /// (it did not wait), or if they have not all begun to wait within 20 seconds. Each is a task the test started, with a name for the failure.
    /// </summary>
    public static async Task WaitForWaitersAsync(string cs, int count, CancellationToken ct, params (Task Task, string Name)[] started)
    {
        var until = DateTime.UtcNow.AddSeconds(20);
        while (await WaitersAsync(cs, ct) < count)
        {
            foreach (var (task, name) in started)
                Assert.False(task.IsCompleted, $"{name} did not wait for the lock");
            Assert.True(DateTime.UtcNow < until, $"timed out waiting for {count} to wait for the lock");
            await Task.Delay(20, ct);
        }
    }

    /// <summary>Lets go of the lock, as a refresh does when it commits.</summary>
    public Task ReleaseAsync(CancellationToken ct) => _transaction.CommitAsync(ct);

    public async ValueTask DisposeAsync()
    {
        await _transaction.DisposeAsync();
        await _connection.DisposeAsync();
    }
}
