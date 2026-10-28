using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Day;

/// <summary>
/// The zone a local day is shown in, which is what says where the day begins and ends. One rule, used by everything that has to agree with
/// <c>GET /api/day/{date}</c> about what a day is: the day view, the raw points of the day, and the dates a removal falls on.
/// </summary>
internal static class DayZone
{
    /// <summary>What the day view calls the zone of a day it knows no zone for.</summary>
    public const string Unknown = "UTC";

    /// <summary>
    /// The zone the day <paramref name="date"/> is shown in: where its first segment starts (<paramref name="stored"/> are the day's
    /// segments, as <see cref="SegmentStore.FindDayAsync"/> gives them), else where the latest stay before the day was. Null when
    /// there is neither: the day view then says <see cref="Unknown"/>.
    /// </summary>
    public static async Task<string?> FindAsync(SegmentStore segments, DateOnly date, IReadOnlyList<DaySegment> stored, CancellationToken ct)
        => stored.Count > 0 ? stored[0].StartTz : await segments.FindZoneBeforeAsync(date, ct);

    /// <summary>
    /// From local midnight to the next one of <paramref name="date"/>, as UTC (the end is exclusive): the stretch of raw points that the
    /// day is. It is in the zone the day view shows, so a day with no zone known is the UTC day that the view calls it (and not the
    /// widest span <see cref="DaySpan.Of"/> gives a day it knows no zone for, which is for telling whether a day is still open).
    /// </summary>
    public static async Task<(DateTime FromUtc, DateTime ToUtc)> FindPointSpanAsync(SegmentStore segments, DateOnly date, CancellationToken ct)
    {
        var stored = await segments.FindDayAsync(date, ct);
        var zone = await FindAsync(segments, date, stored, ct);
        return DaySpan.Of(date, zone ?? Unknown);
    }
}
