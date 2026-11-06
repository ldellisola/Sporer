namespace Sporer.Timeline;

/// <summary>
/// First detection step: turns the raw points of one person (all their devices) into a clean, time-ordered
/// track that stays and moves can be detected from (spec section 6.3).
/// </summary>
public static class PointCleaner
{
    /// <summary>A glitch's two neighbours must be closer to each other than this fraction of the shorter hop to it.</summary>
    private const double ReturnFraction = 0.25;

    /// <summary>
    /// Cleans <paramref name="points"/> and returns them sorted by <see cref="TrackPoint.TimeUtc"/>, all devices
    /// merged into one timeline: the points <see cref="Classify"/> calls <see cref="PointStatus.Used"/>, and no others.
    /// </summary>
    public static IReadOnlyList<TrackPoint> Clean(IEnumerable<TrackPoint> points, DetectionOptions o)
    {
        ArgumentNullException.ThrowIfNull(points);
        ArgumentNullException.ThrowIfNull(o);

        var input = points as IReadOnlyList<TrackPoint> ?? points.ToList();
        var status = Classify(input, o);
        var used = new List<TrackPoint>(input.Count);
        for (var i = 0; i < input.Count; i++)
        {
            if (status[i] == PointStatus.Used)
                used.Add(input[i]);
        }

        return [.. used.OrderBy(p => p.TimeUtc)]; // stable: equal times keep their input order
    }

    /// <summary>
    /// Says for each of <paramref name="points"/> (the answer is in the same order) whether the cleaning keeps it, and if not why. Rules, in order:
    /// <list type="number">
    /// <item><see cref="PointStatus.Duplicate"/>: a repeat of (<see cref="TrackPoint.Device"/>, <see cref="TrackPoint.TimeUtc"/>);
    /// the first one seen wins.</item>
    /// <item><see cref="PointStatus.PoorAccuracy"/>: accuracy worse than <see cref="DetectionOptions.MaxAccuracyMeters"/>, or negative
    /// (iOS reports -1 for an invalid fix). Unknown (null) accuracy is kept.</item>
    /// <item><see cref="PointStatus.Glitch"/>: an out-and-back jump, judged among the points that passed both rules, in time order: a point
    /// (never the first or last) that both the hop to it and the hop from it exceed <see cref="DetectionOptions.GlitchSpeedKmh"/>,
    /// while its neighbours are close together.</item>
    /// </list>
    /// </summary>
    public static IReadOnlyList<PointStatus> Classify(IReadOnlyList<TrackPoint> points, DetectionOptions o)
    {
        ArgumentNullException.ThrowIfNull(points);
        ArgumentNullException.ThrowIfNull(o);

        var status = new PointStatus[points.Count];
        var seen = new HashSet<(string Device, DateTime TimeUtc)>();
        var usable = new List<int>();
        for (var i = 0; i < points.Count; i++)
        {
            var p = points[i];
            if (!seen.Add((p.Device, p.TimeUtc)))
                status[i] = PointStatus.Duplicate;
            else if (!HasUsableAccuracy(p, o))
                status[i] = PointStatus.PoorAccuracy;
            else
                usable.Add(i);
        }

        var sorted = usable.OrderBy(i => points[i].TimeUtc).ToList(); // stable: equal times keep their input order
        var kept = new List<int>(sorted.Count);
        for (var k = 0; k < sorted.Count; k++)
        {
            // The previous neighbour is the last point kept, so a dropped glitch is not compared against again.
            var isInterior = k > 0 && k < sorted.Count - 1;
            if (isInterior && IsGlitch(points[kept[^1]], points[sorted[k]], points[sorted[k + 1]], o))
                status[sorted[k]] = PointStatus.Glitch;
            else
                kept.Add(sorted[k]);
        }

        return status;
    }

    private static bool HasUsableAccuracy(TrackPoint p, DetectionOptions o)
        => p.AccuracyMeters is not { } accuracy || accuracy >= 0 && accuracy <= o.MaxAccuracyMeters;

    private static bool IsGlitch(TrackPoint previous, TrackPoint point, TrackPoint next, DetectionOptions o)
    {
        var outbound = Geo.DistanceMeters(previous.Position, point.Position);
        var back = Geo.DistanceMeters(point.Position, next.Position);
        if (SpeedKmh(outbound, point.TimeUtc - previous.TimeUtc) <= o.GlitchSpeedKmh
            || SpeedKmh(back, next.TimeUtc - point.TimeUtc) <= o.GlitchSpeedKmh)
            return false;

        return Geo.DistanceMeters(previous.Position, next.Position) < ReturnFraction * Math.Min(outbound, back);
    }

    /// <summary>Implied speed of a hop; points with the same time but different places imply an infinite one.</summary>
    private static double SpeedKmh(double meters, TimeSpan elapsed)
        => elapsed <= TimeSpan.Zero
            ? meters > 0 ? double.PositiveInfinity : 0
            : meters / elapsed.TotalSeconds * 3.6;
}

/// <summary>What the cleaning makes of a raw point (see <see cref="PointCleaner.Classify"/>); the numbers are what the day's points carry on the wire.</summary>
public enum PointStatus
{
    Used = 0,
    PoorAccuracy = 1,
    Glitch = 2,
    Duplicate = 3,
}
