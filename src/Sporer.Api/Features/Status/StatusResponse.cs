using System.Text.Json.Serialization;

namespace Sporer.Api.Features.Status;

/// <summary>
/// How the timeline processing is doing, as served by <c>GET /api/status</c>: whether the backfill of the whole history is
/// moving, what waits or has failed, how far the naming of places has come, and what start-up found wrong. Times are
/// ISO-8601 UTC (<c>Z</c>). Properties that have no value are <c>null</c>, not left out.
/// </summary>
/// <param name="AlgorithmVersion">The version of the algorithm that produced the stored timeline; null until the first run.</param>
/// <param name="Backfill">Progress of the (re)build of the whole history.</param>
/// <param name="PendingRanges">
/// How many dirty ranges wait to be processed: all of them, including the failed ones, which are still unprocessed.
/// </param>
/// <param name="FailedRanges">The dirty ranges that were tried and failed (at least once), in time order.</param>
/// <param name="LastRunAt">When the worker last finished a pass.</param>
/// <param name="LastError">
/// The error the worker last recorded, null when there is none. A backfill step that keeps failing holds back every
/// range that lies ahead of its cursor without those ranges having been tried, so they are not in
/// <paramref name="FailedRanges"/>: this is where it shows.
/// </param>
/// <param name="Places">How far the naming of places has come.</param>
/// <param name="Transit">How far the fetching of railway and bus-route lines has come.</param>
/// <param name="Warnings">What start-up found that the owner should know about, and an ingest that is open.</param>
public sealed record StatusResponse(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? AlgorithmVersion,
    BackfillStatus Backfill,
    long PendingRanges,
    IReadOnlyList<FailedRangeDto> FailedRanges,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] DateTime? LastRunAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? LastError,
    PlaceStatus Places,
    TransitStatus Transit,
    IReadOnlyList<string> Warnings);

/// <summary>
/// The backfill's range and where its cursor stands (all null when there is no backfill). <paramref name="Percent"/> is
/// the elapsed share of the range at the cursor, 0 to 100 in steps of 0.1 and rounded down, so it says 100 only for a
/// backfill that is done; it is 100 when there is nothing to backfill.
/// </summary>
public sealed record BackfillStatus(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] DateTime? From,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] DateTime? To,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] DateTime? Cursor,
    double Percent,
    bool Paused);

/// <summary>A dirty range that failed <paramref name="Attempts"/> times, and the error of the last time.</summary>
public sealed record FailedRangeDto(
    DateTime From,
    DateTime To,
    int Attempts,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? LastError);

/// <summary>
/// The places in use, those that are not merged into another and are shown by a segment (the ones the namer works on;
/// an orphan left behind by a reprocessing is not counted): <paramref name="Unnamed"/> are waiting for a name,
/// <paramref name="Failed"/> could not be named.
/// </summary>
public sealed record PlaceStatus(long Total, long Unnamed, long Failed);

/// <summary>
/// The railway and bus-route lines (transit spec section 4): <paramref name="Enabled"/> is whether they are fetched from Overpass
/// (<c>Transit:Enabled</c>, and a user agent to send; those already cached are used either way), and <paramref name="Tiles"/> counts the tiles.
/// </summary>
public sealed record TransitStatus(bool Enabled, TransitTilesStatus Tiles);

/// <summary>
/// Tiles of 0.1 by 0.1 degrees, of either kind: <paramref name="Cached"/> have been fetched and are used, <paramref name="Waiting"/> are to be
/// fetched (some of them after a failure), and <paramref name="Failed"/> failed five times and are tried again once a day.
/// </summary>
public sealed record TransitTilesStatus(long Cached, long Waiting, long Failed);
