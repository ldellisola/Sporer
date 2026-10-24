using Sporer.Api.Configuration;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

/// <summary>
/// Keeps the stored timeline up to date in the background, through <see cref="ITimelineProcessor.ReprocessAsync"/>:
/// it drains the dirty ranges that ingest records, backfills the whole history (oldest first, in chunks) the first time
/// and whenever the detection thresholds or code change, and never lets a failure stop it or hold up ingest (ingest only
/// writes rows; it never waits for this).
/// </summary>
public sealed class TimelineWorker(
    ProcessingQueue queue,
    ITimelineProcessor processor,
    PointStore points,
    DetectionOptions detection,
    ProcessingOptions options,
    TimeProvider time,
    ILogger<TimelineWorker> logger) : BackgroundService
{
    /// <summary>How many times in a row a backfill step may fail before it is set aside so that the backfill can go on.</summary>
    private const int MaxBackfillFailures = 3;

    // A backfill step that keeps failing is retried with the same growing delay as a dirty range, so a step that cannot
    // be processed does not repeat its error every poll, and is set aside after MaxBackfillFailures failures: while the
    // backfill is open the live ranges wait for it (see RunOnceAsync), so one step that can never succeed would freeze
    // everything after it. Kept in memory: a restart tries again at once.
    private int _backfillFailures;
    private DateTime _backfillRetryAt = DateTime.MinValue;
    private string? _backfillError;

    // Where the step after a set-aside one begins. Its rebuild must not be widened back to the last stored stay, which lies
    // before the set-aside step (nothing of that was stored): it would load the same data again and fail on it again.
    private DateTime? _anchorFloor;

    /// <summary>
    /// One pass: starts a backfill if the algorithm version changed, processes the dirty ranges that are due, and does
    /// one backfill step unless it is paused. Returns whether it did any work. Times (debounce, backoff) are read from
    /// the injected <see cref="TimeProvider"/>; the pause after a backfill step is real time, as it is there to
    /// leave the database to other work. Throws <see cref="OperationCanceledException"/> when <paramref name="ct"/> is
    /// cancelled, including during that pause.
    /// </summary>
    public async Task<bool> RunOnceAsync(CancellationToken ct)
    {
        var didWork = false;
        var state = await queue.GetStateAsync(ct);

        // 1. A new algorithm version (or none yet): what is stored is out of date, so start over from the oldest point.
        var version = AlgorithmVersion.Compute(detection);
        if (state.AlgorithmVersion != version)
        {
            state = await RestartBackfillAsync(state, version, ct);
            didWork = true;
        }

        // 2. Dirty ranges. While the backfill is unfinished, a range that reaches the cursor or beyond waits: processing
        // it would anchor across the part nobody has processed yet and load all of that history. Behind the cursor
        // everything is stored, so those are processed as usual.
        var backfillOpen = state is { BackfillCursor: { } position, BackfillTo: { } target } && position < target;
        foreach (var range in await queue.DueRangesAsync(Now(), backfillOpen ? state.BackfillCursor : null, ct))
        {
            didWork = true;
            try
            {
                // A range can be as long as the history (a client sending a year of points at once), and a rebuild loads
                // what it covers: in pieces no longer than a backfill step, oldest first, so memory stays bounded. The rows
                // are done, or failed, together.
                foreach (var (from, to) in Pieces(range.FromUtc, range.ToUtc, ChunkLength))
                    await processor.ReprocessAsync(from, to, ct);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                var failedAt = Now();
                logger.LogError(ex, "Processing {FromUtc:o} to {ToUtc:o} failed; it will be retried", range.FromUtc, range.ToUtc);
                await queue.FailAsync(range.Ids, Describe(ex), failedAt, ct);
                continue;
            }

            await queue.CompleteAsync(range.Ids, ct);
        }

        // 3. One backfill step, oldest first.
        var pause = false;
        if (!state.Paused && backfillOpen && Now() >= _backfillRetryAt)
        {
            var cursor = state.BackfillCursor!.Value;
            var backfillTo = state.BackfillTo!.Value;
            var chunkEnd = backfillTo - cursor <= ChunkLength ? backfillTo : cursor + ChunkLength;

            didWork = true;
            try
            {
                await processor.ReprocessAsync(cursor, chunkEnd, ct, _anchorFloor);
                state = state with { BackfillCursor = chunkEnd };
                (_backfillFailures, _backfillRetryAt, _backfillError) = (0, DateTime.MinValue, null);
                _anchorFloor = null;
                pause = true;
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                var failedAt = Now();
                _backfillFailures++;
                _backfillRetryAt = failedAt + ProcessingQueue.Backoff(_backfillFailures);
                _backfillError = Describe(ex);

                if (_backfillFailures < MaxBackfillFailures)
                {
                    logger.LogError(ex, "Backfill of {FromUtc:o} to {ToUtc:o} failed; it will be retried after {RetryAt:o}", cursor, chunkEnd, _backfillRetryAt);
                }
                else
                {
                    // Not a transient error. The step becomes a failed dirty range, retried behind the cursor with the usual
                    // backoff (a fix or a changed setting may let it through), and the backfill goes on after it.
                    logger.LogError(ex, "Backfill of {FromUtc:o} to {ToUtc:o} failed {Attempts} times; setting it aside to be retried later and going on", cursor, chunkEnd, _backfillFailures);
                    await queue.SetBackfillStepAsideAsync(cursor, chunkEnd, _backfillFailures, _backfillError, failedAt, ct);
                    state = state with { BackfillCursor = chunkEnd };
                    (_backfillFailures, _backfillRetryAt, _backfillError) = (0, DateTime.MinValue, null);
                    _anchorFloor = chunkEnd;
                }
            }
        }

        // 4. Saved before the pause, so a stop during it keeps the cursor.
        await queue.SaveStateAsync(state with { LastRunAt = Now(), LastError = _backfillError }, ct);

        if (pause && options.BackfillPause > TimeSpan.Zero)
            await Task.Delay(options.BackfillPause, ct);

        return didWork;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var didWork = false;
            try
            {
                didWork = await RunOnceAsync(stoppingToken);
            }
            catch (Exception) when (stoppingToken.IsCancellationRequested)
            {
                return; // stopping: whatever the pass was interrupted by, it is not an error
            }
            catch (Exception ex)
            {
                // Whatever went wrong (the database restarting, a bug), the next pass tries again: ingest does not depend on this loop.
                logger.LogError(ex, "A timeline processing pass failed; trying again in {PollInterval}", options.PollInterval);
                await TryRecordErrorAsync(ex, stoppingToken);
            }

            if (didWork)
                continue;

            try
            {
                await Task.Delay(options.PollInterval > TimeSpan.Zero ? options.PollInterval : TimeSpan.FromMilliseconds(1), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task<ProcessingState> RestartBackfillAsync(ProcessingState state, string version, CancellationToken ct)
    {
        var from = await points.FindFirstTimeAsync(ct);
        DateTime? to = from is null ? null : Now(); // no points, no backfill
        await queue.RestartBackfillAsync(version, from, to, ct);

        (_backfillFailures, _backfillRetryAt, _backfillError, _anchorFloor) = (0, DateTime.MinValue, null, null);
        logger.LogInformation(
            "Algorithm version is {Version} (was {Previous}); rebuilding the timeline from {FromUtc:o}",
            version, state.AlgorithmVersion ?? "none", from);
        return state with { AlgorithmVersion = version, BackfillFrom = from, BackfillTo = to, BackfillCursor = from, LastError = null };
    }

    private async Task TryRecordErrorAsync(Exception error, CancellationToken ct)
    {
        try
        {
            await queue.RecordErrorAsync(Describe(error), ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not record the error in processing_state");
        }
    }

    /// <summary>The longest range one rebuild is asked for: a backfill step.</summary>
    private TimeSpan ChunkLength => TimeSpan.FromDays(Math.Clamp(options.BackfillChunkDays, 1, 36_500));

    /// <summary><paramref name="from"/> to <paramref name="to"/> as consecutive ranges of at most <paramref name="length"/>, oldest first (one, for a range that is not longer).</summary>
    private static IEnumerable<(DateTime From, DateTime To)> Pieces(DateTime from, DateTime to, TimeSpan length)
    {
        var start = from;
        while (true)
        {
            var end = to - start <= length ? to : start + length;
            yield return (start, end);
            if (end >= to)
                yield break;
            start = end;
        }
    }

    private DateTime Now() => time.GetUtcNow().UtcDateTime;

    private static string Describe(Exception error) => $"{error.GetType().Name}: {error.Message}";
}
