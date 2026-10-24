namespace Sporer.Timeline;

/// <summary>
/// Third detection step: how a move was travelled (walk, cycle, drive or flight) and how far (spec section 6.5).
/// Thresholds come from <see cref="DetectionOptions"/>.
/// </summary>
public static class ModeClassifier
{
    /// <summary>A move's motion values are used only when at least this share of its points carry some.</summary>
    private const double MinMotionShare = 0.5;

    private const double KmhPerMps = 3.6;

    /// <summary>The activities Overland reports that say how someone travels. Any other value (stationary, ...) says nothing.</summary>
    private static readonly Dictionary<string, TravelMode> MotionModes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["walking"] = TravelMode.Walk,
        ["running"] = TravelMode.Walk,
        ["cycling"] = TravelMode.Cycle,
        ["driving"] = TravelMode.Drive,
        ["automotive"] = TravelMode.Drive,
    };

    /// <summary>
    /// A flight is a <see cref="TravelMode.Flight"/>. Otherwise, when at least half of the move's points carry motion
    /// values, the most frequent mapped value decides (walking and running are Walk, cycling is Cycle, driving and
    /// automotive are Drive; other values are ignored). With no such motion, no mapped values or a tied vote, the median
    /// speed decides: below <see cref="DetectionOptions.WalkMaxKmh"/> Walk, below <see cref="DetectionOptions.CycleMaxKmh"/>
    /// Cycle, otherwise Drive.
    /// </summary>
    public static TravelMode Classify(MoveSegment m, DetectionOptions o)
    {
        ArgumentNullException.ThrowIfNull(m);
        ArgumentNullException.ThrowIfNull(o);

        if (m.IsFlight)
            return TravelMode.Flight;

        if (ModeFromMotion(m.Points) is { } fromMotion)
            return fromMotion;

        var kmh = MedianSpeedKmh(m.Points);
        return kmh < o.WalkMaxKmh ? TravelMode.Walk : kmh < o.CycleMaxKmh ? TravelMode.Cycle : TravelMode.Drive;
    }

    /// <summary>
    /// Great-circle distance from the first to the last point for a flight (the route flown is not tracked closely
    /// enough to add up), otherwise the sum of the distances between consecutive points. Zero below two points.
    /// </summary>
    public static double DistanceMeters(MoveSegment m)
    {
        ArgumentNullException.ThrowIfNull(m);

        var points = m.Points;
        if (points.Count < 2)
            return 0;

        if (m.IsFlight)
            return Geo.DistanceMeters(points[0].Position, points[^1].Position);

        var total = 0.0;
        for (var k = 1; k < points.Count; k++)
            total += Geo.DistanceMeters(points[k - 1].Position, points[k].Position);
        return total;
    }

    /// <summary>
    /// The mode most motion values vote for, or null when too few points carry motion (an empty array carries none),
    /// when no value maps to a mode, or when the top modes are tied. Every mapped value is one vote.
    /// </summary>
    private static TravelMode? ModeFromMotion(IReadOnlyList<TrackPoint> points)
    {
        var carrying = points.Count(p => p.Motion is { Length: > 0 });
        if (carrying == 0 || carrying < MinMotionShare * points.Count)
            return null;

        var votes = new Dictionary<TravelMode, int>();
        foreach (var point in points)
        {
            foreach (var value in point.Motion ?? [])
            {
                if (value is not null && MotionModes.TryGetValue(value, out var mode))
                    votes[mode] = votes.GetValueOrDefault(mode) + 1;
            }
        }
        if (votes.Count == 0)
            return null;

        var top = votes.Values.Max();
        var leaders = votes.Where(v => v.Value == top).Select(v => v.Key).ToList();
        return leaders.Count == 1 ? leaders[0] : null;
    }

    /// <summary>
    /// Median of the points' speeds in km/h: the reported speed where it is known and not negative (iOS reports -1 for
    /// unknown), otherwise the speed implied by the hop from the previous point. A point with neither (the first, or one
    /// with the same time as its predecessor) gives no sample; with no samples at all the speed is 0.
    /// </summary>
    private static double MedianSpeedKmh(IReadOnlyList<TrackPoint> points)
    {
        var speeds = new List<double>(points.Count);
        for (var k = 0; k < points.Count; k++)
        {
            if (points[k].SpeedMps is { } reported && double.IsFinite(reported) && reported >= 0)
            {
                speeds.Add(reported * KmhPerMps);
            }
            else if (k > 0)
            {
                var seconds = (points[k].TimeUtc - points[k - 1].TimeUtc).TotalSeconds;
                if (seconds > 0)
                    speeds.Add(Geo.DistanceMeters(points[k - 1].Position, points[k].Position) / seconds * KmhPerMps);
            }
        }
        if (speeds.Count == 0)
            return 0;

        speeds.Sort();
        var middle = speeds.Count / 2;
        return speeds.Count % 2 == 1 ? speeds[middle] : (speeds[middle - 1] + speeds[middle]) / 2;
    }
}
