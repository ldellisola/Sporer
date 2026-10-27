using Sporer.Api.Configuration;
using Sporer.Api.Features.Trips;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

/// <summary>
/// Keeps the stored timeline up to date in the background, through <see cref="ITimelineProcessor.ReprocessAsync"/>:
/// it drains the dirty ranges that ingest records, backfills the whole history (oldest first, in chunks) the first time
/// and whenever the detection thresholds or code change, and never lets a failure stop it or hold up ingest (ingest only
/// writes rows; it never waits for this). What is derived from the timeline (the nights, homes and trips) is refreshed once
/// at the end of each pass, over what the pass rebuilt, through <see cref="ITripRefresher"/>.
/// </summary>
public sealed class TimelineWorker(
    ProcessingQueue queue,
    ITimelineProcessor processor,
    TripStore trips,
    ITripRefresher refresher,
    PointStore points,
    DetectionOptions detection,
    ProcessingOptions options,
    TimeProvider time,
    ILogger<TimelineWorker> logger) : BackgroundService
{
    // A backfill step that fails is retried with the same growing delay as a dirty range, so a step that cannot be processed
    // does not repeat its error every poll. How often it has been started without finishing is counted in the database (see
    // ProcessingQueue.CountBackfillAttemptAsync), and after SetAsideAfterAttempts the step is set aside: while the backfill
    // is open the live ranges wait for it (see RunOnceAsync), so one step that can never succeed would freeze everything
    // after it. The delay and the error are kept in memory: a restart tries again at once, and the count tells whether that
    // is still worth doing.
    private DateTime _backfillRetryAt = DateTime.MinValue;
    private string? _backfillError;

    // A refresh that fails never fails the range or the chunk that was rebuilt: the window it was for stays in the database
    // (see TripStore.ExtendPendingAsync) and is tried again. The error is kept here and is part of what each pass saves as
    // the last error, as _backfillError is, until a refresh succeeds: recording it once would be overwritten by the next
    // pass's save. A refresh works out the homes and trips from the whole history, so it waits out the same growing delay as
    // a backfill step before it is tried again, instead of repeating that on every poll. Like the others, the delay is in
    // memory: a restart tries again at once.
    private DateTime _refreshRetryAt = DateTime.MinValue;
    private int _refreshFailures;
    private string? _refreshError;

    /// <summary>
    /// One pass: starts a backfill if the algorithm version changed, processes the dirty ranges that are due, does
    /// one backfill step unless it is paused, and refreshes the nights, homes and trips over everything that was rebuilt
    /// since the last refresh. Returns whether it did any work: a refresh counts only if it succeeded, so that one that keeps
    /// failing does not keep the loop from waiting for the next poll. Times (debounce, backoff) are read from
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
                // are done, or failed, together. What each piece rebuilt is noted as soon as it is done, so that a stop before
                // the refresh does not lose it.
                foreach (var (from, to) in Pieces(range.FromUtc, range.ToUtc, ChunkLength))
                {
                    var rebuilt = await processor.ReprocessAsync(from, to, ct);
                    await trips.ExtendPendingAsync(rebuilt.RebuiltFromUtc, rebuilt.RebuiltToUtc, ct);
                }
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
            (state, pause) = await BackfillStepAsync(state, cursor, chunkEnd, backfillTo, ct);
        }

        // 4. Saved before the refresh and the pause, so that a stop during either keeps the cursor. The refresh loads the whole
        // history, and a process that is stopped or killed in it must not lose the step that has just been done: the attempt
        // was counted before the step ran, and three of them would set a good chunk aside as one the process cannot get through.
        var saved = CurrentError();
        await queue.SaveStateAsync(state with { LastRunAt = Now(), LastError = saved }, ct);

        // 5. Once per pass, whatever the ranges and the step rebuilt. Its error is saved too, if it changed the last error.
        if (await RefreshTripsAsync(ct))
            didWork = true;
        if (CurrentError() != saved)
            await queue.SaveStateAsync(state with { LastRunAt = Now(), LastError = CurrentError() }, ct);

        if (pause && options.BackfillPause > TimeSpan.Zero)
            await Task.Delay(options.BackfillPause, ct);

        return didWork;
    }

    /// <summary>
    /// Runs the backfill chunk <paramref name="cursor"/> to <paramref name="chunkEnd"/>. The start is counted and stored
    /// first: a process that dies in the middle of the chunk (it ran out of memory) leaves the count behind, and the start
    /// that finds it at <see cref="ProcessingQueue.SetAsideAfterAttempts"/> sets the chunk aside without running it. A failure
    /// that is caught counts the same way, and a counted start is never taken back, so every kind of stop converges. A chunk that is set aside becomes a failed dirty range (retried behind the cursor
    /// with the usual backoff: a fix or a changed setting may let it through), the cursor moves on, and the rebuilds after it
    /// stay clear of it (see <see cref="SegmentStore.FindAnchorsAsync"/>). Returns the new state, and whether the chunk was done
    /// (the backfill then pauses).
    /// </summary>
    private async Task<(ProcessingState State, bool Pause)> BackfillStepAsync(
        ProcessingState state, DateTime cursor, DateTime chunkEnd, DateTime backfillTo, CancellationToken ct)
    {
        if (state.BackfillChunkAttempts >= ProcessingQueue.SetAsideAfterAttempts)
        {
            logger.LogError(
                "Backfill of {FromUtc:o} to {ToUtc:o} was started {Attempts} times without finishing (the process stopped during it); setting it aside to be retried later and going on",
                cursor, chunkEnd, state.BackfillChunkAttempts);
            return (await SetAsideAsync(state, cursor, chunkEnd, backfillTo,
                _backfillError ?? $"The process stopped during this range {state.BackfillChunkAttempts} times in a row (out of memory, or killed)", ct), false);
        }

        var attempts = await queue.CountBackfillAttemptAsync(ct);
        try
        {
            var rebuilt = await processor.ReprocessAsync(cursor, chunkEnd, ct);
            await trips.ExtendPendingAsync(rebuilt.RebuiltFromUtc, rebuilt.RebuiltToUtc, ct);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            var failedAt = Now();
            _backfillRetryAt = failedAt + ProcessingQueue.Backoff(attempts);
            _backfillError = Describe(ex);
            state = state with { BackfillChunkAttempts = attempts };

            if (attempts < ProcessingQueue.SetAsideAfterAttempts)
            {
                logger.LogError(ex, "Backfill of {FromUtc:o} to {ToUtc:o} failed; it will be retried after {RetryAt:o}", cursor, chunkEnd, _backfillRetryAt);
                return (state, false);
            }

            // Not a transient error.
            logger.LogError(ex, "Backfill of {FromUtc:o} to {ToUtc:o} failed {Attempts} times; setting it aside to be retried later and going on", cursor, chunkEnd, attempts);
            return (await SetAsideAsync(state, cursor, chunkEnd, backfillTo, _backfillError, ct), false);
        }

        (_backfillRetryAt, _backfillError) = (DateTime.MinValue, null);
        return (state with { BackfillCursor = chunkEnd, BackfillChunkAttempts = 0 }, true);
    }

    /// <summary>
    /// Refreshes the nights, homes and trips over the window that is waiting (the union of what was rebuilt since the last
    /// refresh), then empties it. Returns whether it refreshed. A failure is not an error of the pass: it is logged and
    /// kept (<see cref="_refreshError"/>), and the window stays to be tried again once the delay is over, which is also where
    /// it is found after a restart.
    /// </summary>
    private async Task<bool> RefreshTripsAsync(CancellationToken ct)
    {
        // Waiting out the delay of a failure: the window stays, and so does the error that each pass saves.
        if (Now() < _refreshRetryAt)
            return false;

        try
        {
            if (await trips.TakePendingAsync(ct) is not { } window)
            {
                ForgetRefreshFailure(); // nothing is waiting, so nothing is failing
                return false;
            }

            await refresher.RefreshAsync(window.From, window.To, ct);
            await trips.ClearPendingAsync(window.From, window.To, ct);

            ForgetRefreshFailure();
            return true;
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            _refreshFailures++;
            _refreshRetryAt = Now() + ProcessingQueue.Backoff(_refreshFailures);
            _refreshError = $"Refreshing homes and trips failed: {Describe(ex)}";
            logger.LogError(ex, "Refreshing the homes and trips failed; it stays pending and will be tried again after {RetryAt:o}", _refreshRetryAt);
            return false;
        }
    }

    private void ForgetRefreshFailure() => (_refreshError, _refreshRetryAt, _refreshFailures) = (null, DateTime.MinValue, 0);

    /// <summary>What a pass saves as the last error: the backfill's and the refresh's, whichever are failing, or null.</summary>
    private string? CurrentError()
        => _backfillError is not null && _refreshError is not null ? $"{_backfillError}; {_refreshError}" : _backfillError ?? _refreshError;

    /// <summary>
    /// Records the chunk as a set-aside dirty range and moves the cursor past it. The range covers the chunk after it too
    /// (up to where the backfill ends): that one is rebuilt without reaching back into this one, which can leave a cut stay
    /// at their edge, and the retry of this range rebuilds both.
    /// </summary>
    private async Task<ProcessingState> SetAsideAsync(
        ProcessingState state, DateTime cursor, DateTime chunkEnd, DateTime backfillTo, string error, CancellationToken ct)
    {
        var coveredTo = chunkEnd + ChunkLength < backfillTo ? chunkEnd + ChunkLength : backfillTo;
        await queue.SetBackfillStepAsideAsync(cursor, chunkEnd, coveredTo, error, Now(), ct);
        (_backfillRetryAt, _backfillError) = (DateTime.MinValue, null);
        return state with { BackfillCursor = chunkEnd, BackfillChunkAttempts = 0 };
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

        (_backfillRetryAt, _backfillError) = (DateTime.MinValue, null);
        ForgetRefreshFailure(); // the window it was for is cleared with the rest
        logger.LogInformation(
            "Algorithm version is {Version} (was {Previous}); rebuilding the timeline from {FromUtc:o}",
            version, state.AlgorithmVersion ?? "none", from);
        return state with { AlgorithmVersion = version, BackfillFrom = from, BackfillTo = to, BackfillCursor = from, LastError = null, BackfillChunkAttempts = 0 };
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
