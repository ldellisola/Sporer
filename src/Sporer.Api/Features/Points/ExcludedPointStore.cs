using Dapper;
using Npgsql;
using NpgsqlTypes;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Points;

/// <summary>A point of <c>locationlog</c>, told from the others by its device and its exact time.</summary>
public sealed record PointKey(string Device, DateTime TimeUtc);

/// <summary>
/// One removal the owner made, as it can be undone: <paramref name="Batch"/> is what it is undone by, <paramref name="RemovedAt"/> when it was
/// made and <paramref name="TimesUtc"/> the times of its points, oldest first (the count, the first and the last are in them).
/// </summary>
public sealed record RemovedBatch(Guid Batch, DateTime RemovedAt, IReadOnlyList<DateTime> TimesUtc);

/// <summary>
/// The points the owner removed from the timeline: the rows of <c>excluded_point</c>. The raw point stays in <c>locationlog</c>, which is
/// never written to; every read of points for processing leaves a removed one out (<see cref="PointStore"/>), and removing or restoring
/// points asks for the stretch they are in to be rebuilt at once (<see cref="ProcessingQueue.EnqueueNowAsync"/>).
/// </summary>
public sealed class ExcludedPointStore(NpgsqlDataSource dataSource, ProcessingQueue queue)
{
    /// <summary>
    /// Removes the points of <paramref name="points"/> that exist and are not removed already, as one batch, and asks for a rebuild of the
    /// stretch from the first to the last of them, due at once as of <paramref name="nowUtc"/>. Both happen or neither. A point that does
    /// not exist (no row of <c>locationlog</c> has its device and exact time) or that an earlier removal holds is left alone: it stays in
    /// the batch it is in. Returns the batch, which is a new one whatever happens to the points, and how many were removed; none is no
    /// batch to speak of (nothing is stored under it) and asks for no rebuild.
    /// </summary>
    public async Task<(Guid Batch, int Count)> RemoveAsync(IReadOnlyList<PointKey> points, DateTime nowUtc, CancellationToken ct = default)
    {
        var batch = Guid.NewGuid();
        if (points.Count == 0)
            return (batch, 0);

        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        // The bounds say which chunks of the hypertable can hold a point of the request, so that the probe for each does not look in all of them.
        var removed = new List<DateTime>();
        await using (var insert = new NpgsqlCommand(
            """
            insert into excluded_point (device, time, batch_id)
            select p.device, p.time, @batch
            from unnest(@devices, @times) as p(device, time)
            where exists (select 1 from locationlog l
                          where l.time >= @from and l.time <= @to and l.device = p.device and l.time = p.time)
            on conflict (device, time) do nothing
            returning time
            """, connection, transaction))
        {
            insert.Parameters.Add(new NpgsqlParameter("batch", NpgsqlDbType.Uuid) { Value = batch });
            insert.Parameters.Add(new NpgsqlParameter("devices", NpgsqlDbType.Array | NpgsqlDbType.Text) { Value = points.Select(p => p.Device).ToArray() });
            insert.Parameters.Add(new NpgsqlParameter("times", NpgsqlDbType.Array | NpgsqlDbType.TimestampTz) { Value = points.Select(p => p.TimeUtc).ToArray() });
            insert.Parameters.Add(new NpgsqlParameter("from", NpgsqlDbType.TimestampTz) { Value = points.Min(p => p.TimeUtc) });
            insert.Parameters.Add(new NpgsqlParameter("to", NpgsqlDbType.TimestampTz) { Value = points.Max(p => p.TimeUtc) });
            await using var reader = await insert.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
                removed.Add(reader.GetDateTime(0));
        }

        if (removed.Count > 0)
            await queue.EnqueueNowAsync(connection, transaction, removed.Min(), removed.Max(), nowUtc, ct);

        await transaction.CommitAsync(ct);
        return (batch, removed.Count);
    }

    /// <summary>
    /// The removals, newest first (the ones made at the same instant by their id): when each was made and the times of its points.
    /// </summary>
    public async Task<IReadOnlyList<RemovedBatch>> ListAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<RemovedRow>(new CommandDefinition(
            "select batch_id as Batch, time as Time, excluded_at as ExcludedAt from excluded_point order by batch_id, time",
            cancellationToken: ct));

        return [.. rows
            .GroupBy(r => r.Batch)
            .Select(group => new RemovedBatch(
                group.Key, DateTime.SpecifyKind(group.Min(r => r.ExcludedAt), DateTimeKind.Utc),
                [.. group.Select(r => DateTime.SpecifyKind(r.Time, DateTimeKind.Utc))])) // the query's order: oldest first
            .OrderByDescending(batch => batch.RemovedAt)
            .ThenBy(batch => batch.Batch)];
    }

    /// <summary>
    /// Restores the points of <paramref name="batch"/>: deletes its rows, and asks for a rebuild of the stretch from the first to the last of
    /// them, due at once as of <paramref name="nowUtc"/>; both happen or neither. False, with nothing done, when there is no such batch
    /// (it never was one, or was restored already).
    /// </summary>
    public async Task<bool> RestoreAsync(Guid batch, DateTime nowUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        var restored = (await connection.QueryAsync<DateTime>(new CommandDefinition(
            "delete from excluded_point where batch_id = @Batch returning time", new { Batch = batch }, transaction, cancellationToken: ct))).AsList();
        if (restored.Count == 0)
            return false;

        await queue.EnqueueNowAsync(connection, transaction, restored.Min(), restored.Max(), nowUtc, ct);
        await transaction.CommitAsync(ct);
        return true;
    }

    // A class with setters rather than a record: Dapper matches a record's constructor by exact column types.
    private sealed class RemovedRow
    {
        public Guid Batch { get; set; }
        public DateTime Time { get; set; }
        public DateTime ExcludedAt { get; set; }
    }
}
