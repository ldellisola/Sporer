namespace Sporer.Timeline;

/// <summary>
/// A move's line and distance for the mode it ended up with. A <see cref="TravelMode.Flight"/> is the great-circle arc from its
/// first point to its last, and that arc's length: the route flown is not tracked closely enough to draw or add up. Every other
/// mode, a train that the segmenter took for a flight included, is the path through its points and the sum of its hops.
/// </summary>
public static class MoveGeometry
{
    /// <summary>How many points a flight's arc is drawn with.</summary>
    public const int ArcPoints = 64;

    /// <summary>
    /// The line of <paramref name="move"/> as <paramref name="mode"/>, before simplification: the arc for a flight (empty below
    /// one point), otherwise the positions of its points in order.
    /// </summary>
    public static IReadOnlyList<GeoPoint> Line(MoveSegment move, TravelMode mode)
    {
        ArgumentNullException.ThrowIfNull(move);

        var points = move.Points;
        if (mode == TravelMode.Flight)
            return points.Count == 0 ? [] : Geo.GreatCircle(points[0].Position, points[^1].Position, ArcPoints);
        return [.. points.Select(p => p.Position)];
    }

    /// <summary>
    /// The detailed and the coarse line of <paramref name="move"/> as <paramref name="mode"/>, as they are stored: a flight's arc
    /// at both levels, otherwise the path simplified to <see cref="DetectionOptions.DetailToleranceMeters"/> and
    /// <see cref="DetectionOptions.CoarseToleranceMeters"/>.
    /// </summary>
    public static (IReadOnlyList<GeoPoint> Detail, IReadOnlyList<GeoPoint> Coarse) Lines(MoveSegment move, TravelMode mode, DetectionOptions o)
    {
        ArgumentNullException.ThrowIfNull(o);

        var line = Line(move, mode);
        return mode == TravelMode.Flight
            ? (line, line)
            : (LineSimplifier.Simplify(line, o.DetailToleranceMeters), LineSimplifier.Simplify(line, o.CoarseToleranceMeters));
    }

    /// <summary>
    /// How far <paramref name="move"/> went as <paramref name="mode"/>: the great-circle distance from the first point to the last
    /// for a flight, otherwise the sum of the distances between consecutive points. Zero below two points.
    /// </summary>
    public static double DistanceMeters(MoveSegment move, TravelMode mode)
    {
        ArgumentNullException.ThrowIfNull(move);

        var points = move.Points;
        if (points.Count < 2)
            return 0;

        if (mode == TravelMode.Flight)
            return Geo.DistanceMeters(points[0].Position, points[^1].Position);

        var total = 0.0;
        for (var k = 1; k < points.Count; k++)
            total += Geo.DistanceMeters(points[k - 1].Position, points[k].Position);
        return total;
    }
}
