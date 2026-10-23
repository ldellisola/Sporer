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
    /// merged into one timeline. Rules, in order:
    /// <list type="number">
    /// <item>Drop exact duplicates by (<see cref="TrackPoint.Device"/>, <see cref="TrackPoint.TimeUtc"/>); the first one seen wins.</item>
    /// <item>Drop points whose accuracy is worse than <see cref="DetectionOptions.MaxAccuracyMeters"/>, or negative
    /// (iOS reports -1 for an invalid fix). Unknown (null) accuracy is kept.</item>
    /// <item>Drop out-and-back glitches: a point (never the first or last) that both the hop to it and the hop from it
    /// exceed <see cref="DetectionOptions.GlitchSpeedKmh"/>, while its neighbours are close together.</item>
    /// </list>
    /// </summary>
    public static IReadOnlyList<TrackPoint> Clean(IEnumerable<TrackPoint> points, DetectionOptions o)
    {
        ArgumentNullException.ThrowIfNull(points);
        ArgumentNullException.ThrowIfNull(o);

        var seen = new HashSet<(string Device, DateTime TimeUtc)>();
        var usable = new List<TrackPoint>();
        foreach (var p in points)
        {
            if (seen.Add((p.Device, p.TimeUtc)) && HasUsableAccuracy(p, o))
                usable.Add(p);
        }

        var sorted = usable.OrderBy(p => p.TimeUtc).ToList(); // stable: equal times keep their input order
        return DropGlitches(sorted, o);
    }

    private static bool HasUsableAccuracy(TrackPoint p, DetectionOptions o)
        => p.AccuracyMeters is not { } accuracy || accuracy >= 0 && accuracy <= o.MaxAccuracyMeters;

    private static List<TrackPoint> DropGlitches(List<TrackPoint> sorted, DetectionOptions o)
    {
        var result = new List<TrackPoint>(sorted.Count);
        for (var k = 0; k < sorted.Count; k++)
        {
            // The previous neighbour is the last point kept, so a dropped glitch is not compared against again.
            var isInterior = k > 0 && k < sorted.Count - 1;
            if (isInterior && IsGlitch(result[^1], sorted[k], sorted[k + 1], o))
                continue;
            result.Add(sorted[k]);
        }
        return result;
    }

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
