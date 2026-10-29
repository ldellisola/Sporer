namespace Sporer.Api.Features.Trips;

/// <summary>
/// What an edit does about the homes and trips once its write is committed: it works them out again at once
/// (<see cref="ITripRefresher.RecomputeAsync"/>), so that its answer is never of homes and trips that the edit has made out of date.
/// Every edit that moves them (merging and separating places, and the trip and home edits after them) calls
/// <see cref="RecomputeAfterEditAsync"/> and nothing else for it.
/// </summary>
/// <remarks>
/// The edit is done when this is called, and a recompute that fails does not undo it: the failure is logged as an error, and the
/// worker is asked to do it instead. Its pending window (<c>night_refresh</c>, see <see cref="TripStore.ExtendPendingAsync"/>) is
/// extended by a tiny one, the day of the latest stored night, which is all the worker needs to refresh on its next pass: it works
/// the homes and trips out from every night, whatever the window, and its own error reporting then covers a failure that repeats. With
/// no night stored there is nothing to work out, and the window is the present moment. If that cannot be written either, it is logged
/// too, and the homes and trips stay as they were until the next refresh or edit.
/// </remarks>
public sealed class EditRecompute(
    ITripRefresher refresher, TripStore trips, NightStore nights, TimeProvider time, ILogger<EditRecompute> logger)
{
    /// <summary>
    /// Works the homes and trips out again, or, when that fails, asks the worker to. It does not throw (a request that is cancelled
    /// has its recompute stopped, and the worker is asked to do it all the same): the caller answers that the edit is done. True when
    /// the homes and trips were worked out, false when they were left to the worker: an edit that answers with what the trips are
    /// now (a trip's new id) says what it can work out for itself, then.
    /// </summary>
    public async Task<bool> RecomputeAfterEditAsync(CancellationToken ct)
    {
        try
        {
            await refresher.RecomputeAsync(ct);
            return true;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Working out the homes and trips after an edit failed; the edit is stored, and the worker is asked to do it");
        }

        try
        {
            // Not the request's token: the edit is done, and asking for the refresh must not be one more thing the request can stop.
            var day = await nights.FindLatestDateAsync(CancellationToken.None);
            var at = day is { } date ? date.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc) : time.GetUtcNow().UtcDateTime;
            await trips.ExtendPendingAsync(at, at, CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Asking the worker to work out the homes and trips failed; they stay as they were until the next refresh");
        }

        return false;
    }
}
