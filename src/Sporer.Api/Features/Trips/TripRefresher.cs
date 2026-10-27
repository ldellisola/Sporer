using Sporer.Api.Features.Timeline;
using Sporer.Timeline;

namespace Sporer.Api.Features.Trips;

/// <summary>Brings the nights, the home periods and the trips up to date after the timeline was rebuilt.</summary>
public interface ITripRefresher
{
    /// <summary>
    /// Refreshes after the timeline between <paramref name="fromUtc"/> and <paramref name="toUtc"/> was rebuilt. The window
    /// says which nights to build again; the homes and the trips are always worked out afresh from every night.
    /// </summary>
    Task RefreshAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct);
}

/// <summary>
/// The one path from the stored timeline to the nights, homes and trips: it builds the nights of the window that changed,
/// then works out the home periods and the trips from all of them. Whether a place is home depends on 90 nights, and a trip
/// on the nights on both sides of it, so a change in one window can move either of them anywhere in the history. They are
/// therefore not patched but recomputed in memory (a few thousand nights and the stays), and written in one transaction.
/// </summary>
public sealed class TripRefresher(
    NightBuilder builder,
    NightStore nights,
    SegmentStore segments,
    PlaceStore places,
    TripStore trips,
    DetectionOptions options) : ITripRefresher
{
    public async Task RefreshAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct)
    {
        // The nights of the window are rebuilt and stored; the dates the builder leaves out lose their rows.
        var (from, to, built) = await builder.BuildAsync(fromUtc, toUtc, ct);
        await nights.ReplaceAsync(from, to, built, ct);

        // A night keeps the place its stay had, which may have been merged into another since: the home is the survivor.
        var survivors = await places.LoadSurvivorsAsync(ct);
        var all = (await nights.LoadAllAsync(ct))
            .Select(n => n.PlaceId is { } id && survivors.TryGetValue(id, out var survivor) ? n with { PlaceId = survivor } : n)
            .ToList();

        var homes = HomeDetector.Detect(all, options);
        var homePositions = await places.LoadPositionsAsync(homes.Select(h => h.PlaceId), ct);
        var detected = TripDetector.Detect(all, homes, homePositions, await segments.LoadStayPositionsAsync(ct), options);

        await trips.ReplaceDetectedAsync(homes, detected, ct);
    }
}
