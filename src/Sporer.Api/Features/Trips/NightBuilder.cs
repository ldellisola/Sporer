using Sporer.Api.Features.Timeline;
using Sporer.Timeline;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// Works out where the person slept on each night of a time window (spec 6.6), from the timeline that is stored and the raw
/// points. It only reads: it never creates a place and never writes a night (<see cref="NightStore"/> does that).
/// </summary>
public sealed class NightBuilder(PointStore points, SegmentStore segments, PlaceStore places, DetectionOptions options)
{
    private const string StaySource = "stay";
    private const string PointSource = "point";
    private const string NoneSource = "none";

    /// <summary>
    /// The nights of the UTC dates from the day before <paramref name="fromUtc"/> to the day after <paramref name="toUtc"/>,
    /// with the dates they cover. The extra day on each side is for a night that straddles the window: it is read at 03:00 on
    /// the day after its date, in a zone that may be many hours from UTC, so a change near either end of the window can move
    /// the night of the day before it or after it. Each night comes with how it was located.
    /// </summary>
    /// <remarks>
    /// A night is read at <see cref="DetectionOptions.NightHour"/> local time on the day after its date. Where it is located:
    /// the stay that covers that instant (its place and its centre), else the nearest raw point within
    /// <see cref="DetectionOptions.NightPointWindow"/> (the nearest active place within
    /// <see cref="DetectionOptions.PlaceRadiusMeters"/>, or none), else the night is unknown and has no position. The place of
    /// a stay is the one the stay has, merged into another or not; a night's place is resolved to its survivor when they are read.
    /// <para>
    /// A night is left out when it cannot be built: when it has not happened yet (its instant is after the end of the last
    /// stored segment, so nothing is known about it), and when no segment is near enough to say which zone the person was in,
    /// so there is no instant to read it at. A date with no night counts as an unknown night to the detectors.
    /// </para>
    /// <para>
    /// The segments are loaded once, and the active places once; only a night that no stay covers asks for a point.
    /// </para>
    /// </remarks>
    public async Task<(DateOnly From, DateOnly To, IReadOnlyList<(Night Night, string Source)> Nights)> BuildAsync(
        DateTime fromUtc, DateTime toUtc, CancellationToken ct = default)
    {
        var from = AsUtc(fromUtc);
        var to = AsUtc(toUtc);
        if (to < from)
            throw new ArgumentOutOfRangeException(nameof(toUtc), toUtc, "The window must not end before it starts.");

        var firstDate = DateOnly.FromDateTime(from).AddDays(-1);
        var lastDate = DateOnly.FromDateTime(to).AddDays(1);

        // Nothing stored means nothing has happened: no night can be built, and the dates are still the ones to clear.
        if (await segments.FindLastEndAsync(ct) is not { } happenedUntil)
            return (firstDate, lastDate, []);

        // Whatever the zone and the hour, a night is read between its own date and the end of the second day after it, so
        // this holds every instant that is read. The segments are then widened by the margin the zone rules look within.
        var covering = await segments.FindCoveringAsync(
            firstDate.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc),
            lastDate.AddDays(3).ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc), ct);
        var matcher = new PlaceMatcher(await places.LoadActiveAsync(ct), options.PlaceRadiusMeters);

        var nights = new List<(Night Night, string Source)>();
        for (var date = firstDate; date <= lastDate; date = date.AddDays(1))
        {
            if (NightClock.InstantOf(date, at => ZoneAt(covering, at), options.NightHour) is not { } read)
                continue;
            var (instant, zone) = read;
            if (instant > happenedUntil)
                continue;

            nights.Add(await LocateAsync(date, instant, zone, covering, matcher, ct));
        }

        return (firstDate, lastDate, nights);
    }

    private async Task<(Night Night, string Source)> LocateAsync(
        DateOnly date, DateTime instant, string zone, IReadOnlyList<StoredSegment> covering, PlaceMatcher matcher, CancellationToken ct)
    {
        if (SegmentAt(covering, instant) is { Kind: "stay", Latitude: { } latitude, Longitude: { } longitude } stay)
            return (new Night(date, instant, zone, stay.PlaceId, new GeoPoint(latitude, longitude)), StaySource);

        // A point that is not on the globe (ingest stores whatever a client sends) locates nothing: the night is unknown
        // rather than placed somewhere that makes no sense.
        if (await points.NearestAsync(instant, options.NightPointWindow, ct) is { } point && IsPosition(point.Position))
            return (new Night(date, instant, zone, matcher.Match(point.Position), point.Position), PointSource);

        return (new Night(date, instant, zone, null, null), NoneSource);
    }

    /// <summary>
    /// The IANA zone the person was in at <paramref name="instant"/>, or null when the segments say nothing about it. In
    /// order: the segment covering it (a stay has one zone; a move or a gap has its start zone before its midpoint and its end
    /// zone after); else the end zone of the latest segment that ended before it, if that was within
    /// <see cref="SegmentStore.CoveringMargin"/>; else the start zone of the next segment, if it begins within the margin.
    /// </summary>
    private static string? ZoneAt(IReadOnlyList<StoredSegment> segments, DateTime instant)
    {
        var index = LastStartedAtOrBefore(segments, instant);

        if (index >= 0 && instant < segments[index].EndUtc)
        {
            var segment = segments[index];
            var midpoint = segment.StartUtc + (segment.EndUtc - segment.StartUtc) / 2;
            return segment.Kind == "stay" || instant < midpoint ? segment.StartTz : segment.EndTz;
        }

        // Segments do not overlap, so with none covering the instant the one before it is the latest to have ended.
        if (index >= 0 && instant - segments[index].EndUtc <= SegmentStore.CoveringMargin)
            return segments[index].EndTz;

        if (index + 1 < segments.Count && segments[index + 1].StartUtc - instant <= SegmentStore.CoveringMargin)
            return segments[index + 1].StartTz;

        return null;
    }

    /// <summary>The segment that covers <paramref name="instant"/>: it starts at or before it and ends after it.</summary>
    private static StoredSegment? SegmentAt(IReadOnlyList<StoredSegment> segments, DateTime instant)
    {
        var index = LastStartedAtOrBefore(segments, instant);
        return index >= 0 && instant < segments[index].EndUtc ? segments[index] : null;
    }

    /// <summary>The index of the last segment that starts at or before <paramref name="instant"/>, or -1, by bisection.</summary>
    private static int LastStartedAtOrBefore(IReadOnlyList<StoredSegment> segments, DateTime instant)
    {
        int low = 0, high = segments.Count;
        while (low < high)
        {
            var middle = low + (high - low) / 2;
            if (segments[middle].StartUtc <= instant) low = middle + 1;
            else high = middle;
        }
        return low - 1;
    }

    private static bool IsPosition(GeoPoint p)
        => double.IsFinite(p.Latitude) && double.IsFinite(p.Longitude) && p.Latitude is >= -90 and <= 90;

    /// <summary>Npgsql writes only UTC values to timestamptz. Everything in the timeline is UTC; unspecified means UTC too.</summary>
    private static DateTime AsUtc(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
    };
}
