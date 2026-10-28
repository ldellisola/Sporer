using Dapper;
using Npgsql;
using Sporer.Api.Configuration;
using Sporer.Api.Features.Trips;

namespace Sporer.Api.Features.Timeline;

/// <summary>
/// Time ranges waiting to be reprocessed. <paramref name="Ids"/> are the <c>dirty_range</c> rows the range stands for:
/// one row, or several that overlap or lie close together.
/// </summary>
public sealed record DueRange(DateTime FromUtc, DateTime ToUtc, IReadOnlyList<long> Ids);

/// <summary>A dirty range whose processing failed <paramref name="Attempts"/> times, and why the last time. All times are UTC.</summary>
public sealed record FailedRange(DateTime FromUtc, DateTime ToUtc, int Attempts, string? LastError);

/// <summary>
/// What waits in the queue: <paramref name="Pending"/> is every dirty range (the failed ones too: they are still unprocessed),
/// <paramref name="Failed"/> those that have been tried and failed, in time order.
/// </summary>
public sealed record ProcessingBacklog(long Pending, IReadOnlyList<FailedRange> Failed);

/// <summary>
/// The single row of <c>processing_state</c>. All times are UTC. <paramref name="BackfillChunkAttempts"/> is how many times in
/// a row the backfill has started the chunk at its cursor without finishing it.
/// </summary>
public sealed record ProcessingState(
    string? AlgorithmVersion,
    DateTime? BackfillFrom,
    DateTime? BackfillTo,
    DateTime? BackfillCursor,
    bool Paused,
    DateTime? LastRunAt,
    string? LastError,
    int BackfillChunkAttempts = 0);

/// <summary>
/// The processing worker's database side: the queue of dirty ranges that ingest fills, and the state of the backfill.
/// </summary>
public sealed class ProcessingQueue(NpgsqlDataSource dataSource, ProcessingOptions options)
{
    /// <summary>
    /// A dirty range that has failed this many times is <em>set aside</em>: it stays in the table and is retried with the
    /// usual backoff, but rebuilds of later ranges no longer reach back into it (see <see cref="SegmentStore.FindAnchorsAsync"/>),
    /// so a stretch that cannot be processed does not hold up the data after it. A backfill chunk is set aside after this
    /// many failed or interrupted starts.
    /// </summary>
    public const int SetAsideAfterAttempts = 3;

    /// <summary>Ranges that overlap or are at most this far apart are processed as one.</summary>
    private static readonly TimeSpan MergeGap = TimeSpan.FromHours(1);

    private static readonly TimeSpan MaxBackoff = TimeSpan.FromHours(6);

    /// <summary>How long to wait before trying again after the <paramref name="attempts"/>-th failure: 2, 4, 8, ... minutes, at most 6 hours.</summary>
    public static TimeSpan Backoff(int attempts)
    {
        // Capped before the power so that a huge count cannot overflow.
        var wait = TimeSpan.FromMinutes(Math.Pow(2, Math.Clamp(attempts, 0, 20)));
        return wait < MaxBackoff ? wait : MaxBackoff;
    }

    /// <summary>
    /// The ranges to process at <paramref name="nowUtc"/>. Rows that are not waiting out a backoff are merged into groups
    /// (rows that overlap or lie within an hour of each other), and a group is due once its <em>oldest</em> row has been
    /// recorded for the debounce time; it takes its newer rows with it, however recent. So a stream of batches is processed
    /// at most once per debounce, instead of every batch becoming due a debounce after it arrived and being processed as
    /// often as batches come. With <paramref name="endingBeforeUtc"/> only rows that end before it are considered, and rows
    /// that do not stay untouched (this is how ranges ahead of an unfinished backfill are held back).
    /// </summary>
    public async Task<List<DueRange>> DueRangesAsync(DateTime nowUtc, DateTime? endingBeforeUtc = null, CancellationToken ct = default)
    {
        var now = AsUtc(nowUtc);
        var sql =
            """
            select id as Id, from_utc as FromUtc, to_utc as ToUtc, created_at as CreatedAt
            from dirty_range
            where (next_attempt_at is null or next_attempt_at <= @Now)
            """
            + (endingBeforeUtc is null ? "" : " and to_utc < @EndingBefore")
            + " order by from_utc, id";

        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<RangeRow>(new CommandDefinition(
            sql,
            new { Now = now, EndingBefore = endingBeforeUtc is { } before ? AsUtc(before) : (DateTime?)null },
            cancellationToken: ct));

        var cutoff = now - options.Debounce;
        var merged = new List<DueRange>();
        DateTime from = default, to = default, oldest = default;
        List<long>? ids = null;
        foreach (var row in rows) // by start, so a row can only join the group being built
        {
            var rowFrom = AsUtc(row.FromUtc);
            var rowTo = AsUtc(row.ToUtc);
            var rowCreated = AsUtc(row.CreatedAt);
            if (ids is not null && rowFrom <= to + MergeGap)
            {
                to = rowTo > to ? rowTo : to;
                oldest = rowCreated < oldest ? rowCreated : oldest;
                ids.Add(row.Id);
                continue;
            }

            if (ids is not null && oldest <= cutoff)
                merged.Add(new DueRange(from, to, ids));
            (from, to, oldest, ids) = (rowFrom, rowTo, rowCreated, [row.Id]);
        }

        if (ids is not null && oldest <= cutoff)
            merged.Add(new DueRange(from, to, ids));
        return merged;
    }

    /// <summary>
    /// Whether something that can still change the stored timeline between <paramref name="fromUtc"/> (inclusive) and
    /// <paramref name="toUtc"/> (exclusive) is waiting: a dirty range that overlaps it, however it is scheduled (a range
    /// deferred after a failure is unprocessed too), or a backfill that has not finished and whose cursor has not reached
    /// <paramref name="toUtc"/> yet.
    /// </summary>
    public async Task<bool> HasPendingWorkAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        return await connection.ExecuteScalarAsync<bool>(new CommandDefinition(
            """
            select exists (select 1 from dirty_range where from_utc < @To and to_utc >= @From)
                or exists (select 1 from processing_state
                           where id = 1 and backfill_cursor < backfill_to and backfill_cursor < @To)
            """,
            new { From = AsUtc(fromUtc), To = AsUtc(toUtc) }, cancellationToken: ct));
    }

    /// <summary>The rows are done with: they are removed.</summary>
    public async Task CompleteAsync(IReadOnlyList<long> ids, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "delete from dirty_range where id = any(@Ids)", new { Ids = ids.ToArray() }, cancellationToken: ct));
    }

    /// <summary>
    /// Records a failed attempt: each row's attempts go up by one, its error is stored, and it is not due again until
    /// <see cref="Backoff"/> after <paramref name="nowUtc"/>. A row that reaches <see cref="SetAsideAfterAttempts"/> is set
    /// aside: it stays and is retried, and rebuilds of later ranges keep clear of it.
    /// </summary>
    public async Task FailAsync(IReadOnlyList<long> ids, string error, DateTime nowUtc, CancellationToken ct = default)
    {
        var now = AsUtc(nowUtc);
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<AttemptsRow>(new CommandDefinition(
            "select id as Id, attempts as Attempts from dirty_range where id = any(@Ids)", new { Ids = ids.ToArray() }, cancellationToken: ct));

        var failed = rows.Select(r => new { r.Id, Attempts = r.Attempts + 1, Error = error }).ToList();
        if (failed.Count == 0)
            return;

        await connection.ExecuteAsync(new CommandDefinition(
            "update dirty_range set attempts = @Attempts, last_error = @Error, next_attempt_at = @NextAttemptAt where id = @Id",
            failed.Select(f => new { f.Id, f.Attempts, f.Error, NextAttemptAt = now + Backoff(f.Attempts) }).ToList(),
            cancellationToken: ct));
    }

    /// <summary>
    /// Sets a backfill chunk aside so that the backfill can go on: a failed dirty range (with <see cref="SetAsideAfterAttempts"/>
    /// attempts, retried after the usual backoff, behind the cursor) is recorded for <paramref name="fromUtc"/> to
    /// <paramref name="coveredToUtc"/>, and the cursor, which must be at <paramref name="fromUtc"/>, moves to
    /// <paramref name="chunkEndUtc"/> with the chunk's attempt count back at zero. The range reaches beyond the chunk
    /// (the worker passes the end of the chunk after it): the chunk after a set-aside one is rebuilt without reaching back
    /// into it and so can leave a cut stay at their edge, which the retry of this range then rebuilds along with the rest.
    /// One transaction: both happen or neither.
    /// </summary>
    public async Task SetBackfillStepAsideAsync(
        DateTime fromUtc, DateTime chunkEndUtc, DateTime coveredToUtc, string error, DateTime nowUtc, CancellationToken ct = default)
    {
        var now = AsUtc(nowUtc);
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        await connection.ExecuteAsync(new CommandDefinition(
            """
            insert into dirty_range (from_utc, to_utc, created_at, attempts, next_attempt_at, last_error)
            values (@From, @CoveredTo, @Now, @Attempts, @NextAttemptAt, @Error)
            """,
            new
            {
                From = AsUtc(fromUtc), CoveredTo = AsUtc(coveredToUtc), Now = now, Attempts = SetAsideAfterAttempts,
                NextAttemptAt = now + Backoff(SetAsideAfterAttempts), Error = error,
            },
            transaction, cancellationToken: ct));
        await connection.ExecuteAsync(new CommandDefinition(
            "update processing_state set backfill_cursor = @ChunkEnd, backfill_chunk_attempts = 0 where id = 1 and backfill_cursor = @From",
            new { From = AsUtc(fromUtc), ChunkEnd = AsUtc(chunkEndUtc) }, transaction, cancellationToken: ct));

        await transaction.CommitAsync(ct);
    }

    /// <summary>
    /// Counts one more start of the backfill chunk at the cursor and returns the count. Called, and stored, before the
    /// chunk runs: a process killed in the middle of it (out of memory) cannot record anything afterwards, and the count is
    /// what lets the next start see that this chunk has not got to the end <see cref="SetAsideAfterAttempts"/> times.
    /// </summary>
    public async Task<int> CountBackfillAttemptAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        return await connection.ExecuteScalarAsync<int>(new CommandDefinition(
            "update processing_state set backfill_chunk_attempts = backfill_chunk_attempts + 1 where id = 1 returning backfill_chunk_attempts",
            cancellationToken: ct));
    }

    /// <summary>How many dirty ranges wait, and which of them have failed. Reads only; whether a range is due does not matter.</summary>
    public async Task<ProcessingBacklog> GetBacklogAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var grid = await connection.QueryMultipleAsync(new CommandDefinition(
            """
            select count(*) from dirty_range;
            select from_utc as FromUtc, to_utc as ToUtc, attempts as Attempts, last_error as LastError
            from dirty_range where attempts > 0 order by from_utc, id;
            """, cancellationToken: ct));

        var pending = await grid.ReadSingleAsync<long>();
        var failed = (await grid.ReadAsync<FailedRow>()).Select(r => new FailedRange(AsUtc(r.FromUtc), AsUtc(r.ToUtc), r.Attempts, r.LastError));
        return new ProcessingBacklog(pending, [.. failed]);
    }

    public async Task<ProcessingState> GetStateAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var row = await connection.QuerySingleOrDefaultAsync<StateRow>(new CommandDefinition(
            """
            select algorithm_version as AlgorithmVersion, backfill_from as BackfillFrom, backfill_to as BackfillTo,
                   backfill_cursor as BackfillCursor, paused as Paused, last_run_at as LastRunAt, last_error as LastError,
                   backfill_chunk_attempts as BackfillChunkAttempts
            from processing_state where id = 1
            """, cancellationToken: ct));

        return row is null
            ? new ProcessingState(null, null, null, null, false, null, null)
            : new ProcessingState(
                row.AlgorithmVersion, Utc(row.BackfillFrom), Utc(row.BackfillTo), Utc(row.BackfillCursor),
                row.Paused, Utc(row.LastRunAt), row.LastError, row.BackfillChunkAttempts);
    }

    /// <summary>
    /// Stores everything the worker owns: the version, the backfill's range, cursor and chunk attempts, the last run and the last error.
    /// <see cref="ProcessingState.Paused"/> is not written: it belongs to whoever pauses the backfill, and the worker
    /// holds a state for the length of a pass, so writing it back could undo a pause made in the meantime.
    /// </summary>
    public async Task SaveStateAsync(ProcessingState state, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            """
            insert into processing_state (id, algorithm_version, backfill_from, backfill_to, backfill_cursor, last_run_at, last_error, backfill_chunk_attempts)
            values (1, @AlgorithmVersion, @BackfillFrom, @BackfillTo, @BackfillCursor, @LastRunAt, @LastError, @BackfillChunkAttempts)
            on conflict (id) do update set
                algorithm_version = excluded.algorithm_version, backfill_from = excluded.backfill_from,
                backfill_to = excluded.backfill_to, backfill_cursor = excluded.backfill_cursor,
                last_run_at = excluded.last_run_at, last_error = excluded.last_error,
                backfill_chunk_attempts = excluded.backfill_chunk_attempts
            """,
            new
            {
                state.AlgorithmVersion,
                BackfillFrom = Utc(state.BackfillFrom),
                BackfillTo = Utc(state.BackfillTo),
                BackfillCursor = Utc(state.BackfillCursor),
                LastRunAt = Utc(state.LastRunAt),
                state.LastError,
                state.BackfillChunkAttempts,
            },
            cancellationToken: ct));
    }

    /// <summary>
    /// Starts the backfill over for <paramref name="algorithmVersion"/>: stores the version and the range to process,
    /// with the cursor at its start (no range, for an empty history, means there is nothing to backfill), and deletes every
    /// stored segment, in one transaction. The old segments came from another algorithm; if they stayed, the stays among
    /// them would anchor the rebuild (see <see cref="SegmentStore.FindAnchorsAsync"/>) and carry its output into the
    /// new one. The set-aside dirty ranges go too, and the chunk attempts return to zero: the backfill goes over all of that
    /// history again, and a set-aside range that stayed would be listed twice, and would hold back the new rebuilds.
    /// What is derived from the segments goes with them: every night, every trip and the detected home periods are deleted
    /// (under the advisory lock that whatever writes them holds, see <see cref="TripRefresher.AdvisoryLockKey"/>),
    /// and the window waiting to be refreshed is cleared, because the backfill refreshes it all again as it goes. The
    /// home periods the owner set (<c>user</c>) are not derived from anything and stay. Places are kept, with the names and
    /// merges the owner made, and so are the owner's other tables (<c>excluded_point</c>, <c>trip_edit</c>, <c>app_setting</c>), which
    /// this never reads or writes. The raw points are never touched.
    /// </summary>
    public async Task RestartBackfillAsync(string algorithmVersion, DateTime? fromUtc, DateTime? toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        // The nights, homes and trips are written only under this lock (see TripRefresher), and this deletes them: a refresh or an
        // edit's recompute that is working from them finishes first, and one that comes after finds none.
        await connection.ExecuteAsync(new CommandDefinition(
            "select pg_advisory_xact_lock(@Key)", new { Key = TripRefresher.AdvisoryLockKey }, transaction, cancellationToken: ct));
        await connection.ExecuteAsync(new CommandDefinition("delete from segment", transaction: transaction, cancellationToken: ct));
        await connection.ExecuteAsync(new CommandDefinition(
            """
            delete from night;
            delete from trip;
            delete from home_period where source = 'detected';
            update night_refresh set from_utc = null, to_utc = null where id = 1;
            """,
            transaction: transaction, cancellationToken: ct));
        await connection.ExecuteAsync(new CommandDefinition(
            "delete from dirty_range where attempts >= @SetAside",
            new { SetAside = SetAsideAfterAttempts }, transaction, cancellationToken: ct));
        await connection.ExecuteAsync(new CommandDefinition(
            """
            insert into processing_state (id, algorithm_version, backfill_from, backfill_to, backfill_cursor, last_error, backfill_chunk_attempts)
            values (1, @AlgorithmVersion, @From, @To, @From, null, 0)
            on conflict (id) do update set
                algorithm_version = excluded.algorithm_version, backfill_from = excluded.backfill_from,
                backfill_to = excluded.backfill_to, backfill_cursor = excluded.backfill_cursor, last_error = null,
                backfill_chunk_attempts = 0
            """,
            new { AlgorithmVersion = algorithmVersion, From = Utc(fromUtc), To = Utc(toUtc) },
            transaction, cancellationToken: ct));

        await transaction.CommitAsync(ct);
    }

    /// <summary>Stores <paramref name="error"/> as the last error, for a failure that is not about one range.</summary>
    public async Task RecordErrorAsync(string error, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "update processing_state set last_error = @Error where id = 1", new { Error = error }, cancellationToken: ct));
    }

    /// <summary>Npgsql returns timestamptz as UTC already; this only makes sure of the kind, as it must be UTC to be written back.</summary>
    private static DateTime AsUtc(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
    };

    private static DateTime? Utc(DateTime? value) => value is { } v ? AsUtc(v) : null;

    // Classes with setters rather than records: Dapper matches a record's constructor by exact column types.
    private sealed class RangeRow
    {
        public long Id { get; set; }
        public DateTime FromUtc { get; set; }
        public DateTime ToUtc { get; set; }
        public DateTime CreatedAt { get; set; }
    }

    private sealed class FailedRow
    {
        public DateTime FromUtc { get; set; }
        public DateTime ToUtc { get; set; }
        public int Attempts { get; set; }
        public string? LastError { get; set; }
    }

    private sealed class AttemptsRow
    {
        public long Id { get; set; }
        public int Attempts { get; set; }
    }

    private sealed class StateRow
    {
        public string? AlgorithmVersion { get; set; }
        public DateTime? BackfillFrom { get; set; }
        public DateTime? BackfillTo { get; set; }
        public DateTime? BackfillCursor { get; set; }
        public bool Paused { get; set; }
        public DateTime? LastRunAt { get; set; }
        public string? LastError { get; set; }
        public int BackfillChunkAttempts { get; set; }
    }
}
