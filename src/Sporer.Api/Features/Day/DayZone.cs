using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Day;

/// <summary>
/// The zones a local day is in, which is what says where the day begins and ends. The rules, used by everything that has to agree with
/// <c>GET /api/day/{date}</c> about what a day is: the day view (<see cref="FindAsync"/>), and the raw points of the day and the dates a
/// removal falls on (<see cref="FindPointSpanAsync"/>).
/// </summary>
internal static class DayZone
{
    /// <summary>What the day view calls the zone of a day it knows no zone for.</summary>
    public const string Unknown = "UTC";

    /// <summary>
    /// The zone the day view shows the day <paramref name="date"/> in: where its first segment starts (<paramref name="stored"/> are the
    /// day's segments, as <see cref="SegmentStore.FindDayAsync"/> gives them), else where the latest stay before the day was. Null when there
    /// is neither: the view then says <see cref="Unknown"/>.
    /// </summary>
    public static async Task<string?> FindAsync(SegmentStore segments, DateOnly date, IReadOnlyList<DaySegment> stored, CancellationToken ct)
        => stored.Count > 0 ? stored[0].StartTz : await segments.FindZoneBeforeAsync(date, ct);

    /// <summary>
    /// The stretch of raw points that the day <paramref name="date"/> holds, as UTC (the end is exclusive): from the earliest local midnight
    /// to the latest next one, across every zone the day's segments start or end in. The day view shows each segment in its own zone, so a
    /// day on which the person crosses zones is each of them; a span of only the zone it starts in would leave out the evening after a flight
    /// west (and the early hours of the day after one east) from every day. The days next to a flight overlap, and a point on the overlap
    /// is on both. A day with no segments has no zone but the one the view shows it in (<see cref="FindAsync"/>, with no segments), and
    /// when that is none, <see cref="Unknown"/>: the UTC day, and not the widest span <see cref="DaySpan.Of"/> gives a day it knows no zone
    /// for, which is for telling whether a day is still open. The shortest the span can be is the local day in one zone.
    /// </summary>
    public static async Task<(DateTime FromUtc, DateTime ToUtc)> FindPointSpanAsync(SegmentStore segments, DateOnly date, CancellationToken ct)
    {
        var zones = await segments.FindDayZonesAsync(date, ct);
        if (zones.Count == 0)
            return DaySpan.Of(date, await FindAsync(segments, date, stored: [], ct) ?? Unknown);

        var spans = zones.Select(zone => DaySpan.Of(date, zone)).ToList();
        return (spans.Min(span => span.FromUtc), spans.Max(span => span.ToUtc));
    }
}
