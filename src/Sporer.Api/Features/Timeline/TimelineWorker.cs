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
    // A backfill step that keeps failing is retried with the same growing delay as a dirty range, so a step that cannot
    // be processed does not repeat its error every poll. Kept in memory: a restart tries again at once.
    private int _backfillFailures;
    private DateTime _backfillRetryAt = DateTime.MinValue;
    private string? _backfillError;

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
                await processor.ReprocessAsync(range.FromUtc, range.ToUtc, ct);
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
            var chunk = TimeSpan.FromDays(Math.Clamp(options.BackfillChunkDays, 1, 36_500));
            var chunkEnd = backfillTo - cursor <= chunk ? backfillTo : cursor + chunk;

            didWork = true;
            try
            {
                await processor.ReprocessAsync(cursor, chunkEnd, ct);
                state = state with { BackfillCursor = chunkEnd };
                (_backfillFailures, _backfillRetryAt, _backfillError) = (0, DateTime.MinValue, null);
                pause = true;
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                var failedAt = Now();
                _backfillFailures++;
                _backfillRetryAt = failedAt + ProcessingQueue.Backoff(_backfillFailures);
                _backfillError = Describe(ex);
                logger.LogError(ex, "Backfill of {FromUtc:o} to {ToUtc:o} failed; it will be retried after {RetryAt:o}", cursor, chunkEnd, _backfillRetryAt);
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

        (_backfillFailures, _backfillRetryAt, _backfillError) = (0, DateTime.MinValue, null);
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

    private DateTime Now() => time.GetUtcNow().UtcDateTime;

    private static string Describe(Exception error) => $"{error.GetType().Name}: {error.Message}";
}
