using Dapper;
using Npgsql;
using Sporer.Api.Configuration;

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

/// <summary>The single row of <c>processing_state</c>. All times are UTC.</summary>
public sealed record ProcessingState(
    string? AlgorithmVersion,
    DateTime? BackfillFrom,
    DateTime? BackfillTo,
    DateTime? BackfillCursor,
    bool Paused,
    DateTime? LastRunAt,
    string? LastError);

/// <summary>
/// The processing worker's database side: the queue of dirty ranges that ingest fills, and the state of the backfill.
/// </summary>
public sealed class ProcessingQueue(NpgsqlDataSource dataSource, ProcessingOptions options)
{
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
    /// The ranges to process at <paramref name="nowUtc"/>: rows recorded at least the debounce time ago (so a stream of
    /// batches is processed together) and not waiting out a backoff, with rows that overlap or lie within an hour of each
    /// other merged. With <paramref name="endingBeforeUtc"/> only rows that end before it are considered, and rows that do
    /// not stay untouched (this is how ranges ahead of an unfinished backfill are held back).
    /// </summary>
    public async Task<List<DueRange>> DueRangesAsync(DateTime nowUtc, DateTime? endingBeforeUtc = null, CancellationToken ct = default)
    {
        var now = AsUtc(nowUtc);
        var sql =
            """
            select id as Id, from_utc as FromUtc, to_utc as ToUtc
            from dirty_range
            where created_at <= @Cutoff and (next_attempt_at is null or next_attempt_at <= @Now)
            """
            + (endingBeforeUtc is null ? "" : " and to_utc < @EndingBefore")
            + " order by from_utc, id";

        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<RangeRow>(new CommandDefinition(
            sql,
            new { Cutoff = now - options.Debounce, Now = now, EndingBefore = endingBeforeUtc is { } before ? AsUtc(before) : (DateTime?)null },
            cancellationToken: ct));

        var merged = new List<DueRange>();
        DateTime from = default, to = default;
        List<long>? ids = null;
        foreach (var row in rows) // by start, so a row can only join the range being built
        {
            var rowFrom = AsUtc(row.FromUtc);
            var rowTo = AsUtc(row.ToUtc);
            if (ids is not null && rowFrom <= to + MergeGap)
            {
                to = rowTo > to ? rowTo : to;
                ids.Add(row.Id);
                continue;
            }

            if (ids is not null)
                merged.Add(new DueRange(from, to, ids));
            (from, to, ids) = (rowFrom, rowTo, [row.Id]);
        }

        if (ids is not null)
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
    /// <see cref="Backoff"/> after <paramref name="nowUtc"/>.
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
                   backfill_cursor as BackfillCursor, paused as Paused, last_run_at as LastRunAt, last_error as LastError
            from processing_state where id = 1
            """, cancellationToken: ct));

        return row is null
            ? new ProcessingState(null, null, null, null, false, null, null)
            : new ProcessingState(
                row.AlgorithmVersion, Utc(row.BackfillFrom), Utc(row.BackfillTo), Utc(row.BackfillCursor),
                row.Paused, Utc(row.LastRunAt), row.LastError);
    }

    /// <summary>
    /// Stores everything the worker owns: the version, the backfill's range and cursor, the last run and the last error.
    /// <see cref="ProcessingState.Paused"/> is not written: it belongs to whoever pauses the backfill, and the worker
    /// holds a state for the length of a pass, so writing it back could undo a pause made in the meantime.
    /// </summary>
    public async Task SaveStateAsync(ProcessingState state, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            """
            insert into processing_state (id, algorithm_version, backfill_from, backfill_to, backfill_cursor, last_run_at, last_error)
            values (1, @AlgorithmVersion, @BackfillFrom, @BackfillTo, @BackfillCursor, @LastRunAt, @LastError)
            on conflict (id) do update set
                algorithm_version = excluded.algorithm_version, backfill_from = excluded.backfill_from,
                backfill_to = excluded.backfill_to, backfill_cursor = excluded.backfill_cursor,
                last_run_at = excluded.last_run_at, last_error = excluded.last_error
            """,
            new
            {
                state.AlgorithmVersion,
                BackfillFrom = Utc(state.BackfillFrom),
                BackfillTo = Utc(state.BackfillTo),
                BackfillCursor = Utc(state.BackfillCursor),
                LastRunAt = Utc(state.LastRunAt),
                state.LastError,
            },
            cancellationToken: ct));
    }

    /// <summary>
    /// Starts the backfill over for <paramref name="algorithmVersion"/>: stores the version and the range to process,
    /// with the cursor at its start (no range, for an empty history, means there is nothing to backfill), and deletes every
    /// stored segment, in one transaction. The old segments came from another algorithm; if they stayed, the stays among
    /// them would anchor the rebuild (see <see cref="SegmentStore.FindAnchorsAsync"/>) and carry its output into the
    /// new one. Places are kept, and the raw points are never touched.
    /// </summary>
    public async Task RestartBackfillAsync(string algorithmVersion, DateTime? fromUtc, DateTime? toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        await connection.ExecuteAsync(new CommandDefinition("delete from segment", transaction: transaction, cancellationToken: ct));
        await connection.ExecuteAsync(new CommandDefinition(
            """
            insert into processing_state (id, algorithm_version, backfill_from, backfill_to, backfill_cursor, last_error)
            values (1, @AlgorithmVersion, @From, @To, @From, null)
            on conflict (id) do update set
                algorithm_version = excluded.algorithm_version, backfill_from = excluded.backfill_from,
                backfill_to = excluded.backfill_to, backfill_cursor = excluded.backfill_cursor, last_error = null
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
    }
}
