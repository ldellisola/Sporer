namespace Sporer.Timeline;

/// <summary>Reduces a route line to the points that matter for drawing it (Douglas-Peucker).</summary>
public static class LineSimplifier
{
    private const double MetersPerDegree = Geo.EarthRadiusMeters * Math.PI / 180;

    /// <summary>
    /// Douglas-Peucker simplification on a local equirectangular projection around the line's first point. The result
    /// always has the first and last point, and every other point of <paramref name="line"/> lies within
    /// <paramref name="toleranceMeters"/> of the result. The points kept are the original ones, in their original order. A line of two points or fewer is returned as it is.
    /// </summary>
    /// <remarks>
    /// Longitudes may be wrapped to ±180 or unwrapped past it: the line is followed point by point, so one that crosses
    /// the antimeridian stays continuous. A line that ends where it started (a loop) is measured against its start point.
    /// </remarks>
    public static IReadOnlyList<GeoPoint> Simplify(IReadOnlyList<GeoPoint> line, double toleranceMeters)
    {
        ArgumentNullException.ThrowIfNull(line);
        if (!(toleranceMeters >= 0))
            throw new ArgumentOutOfRangeException(nameof(toleranceMeters), toleranceMeters, "The tolerance must be zero or more.");
        if (line.Count <= 2)
            return [.. line];

        var projected = Project(line);
        var keep = new bool[line.Count];
        keep[0] = keep[^1] = true;

        // An explicit stack rather than recursion: a long track must not be able to exhaust the call stack.
        var toleranceSquared = toleranceMeters * toleranceMeters;
        var pending = new Stack<(int First, int Last)>();
        pending.Push((0, line.Count - 1));
        while (pending.Count > 0)
        {
            var (first, last) = pending.Pop();
            var farthest = -1;
            var farthestSquared = -1.0;
            for (var k = first + 1; k < last; k++)
            {
                var squared = SquaredDistanceToSegment(projected[k], projected[first], projected[last]);
                if (squared > farthestSquared)
                {
                    farthest = k;
                    farthestSquared = squared;
                }
            }

            if (farthest < 0 || farthestSquared <= toleranceSquared)
                continue;

            keep[farthest] = true;
            pending.Push((first, farthest));
            pending.Push((farthest, last));
        }

        var result = new List<GeoPoint>();
        for (var k = 0; k < line.Count; k++)
        {
            if (keep[k])
                result.Add(line[k]);
        }
        return result;
    }

    /// <summary>Metres east and north of the first point. Longitude steps are taken between neighbours, so a crossing of ±180 is no jump.</summary>
    private static (double X, double Y)[] Project(IReadOnlyList<GeoPoint> line)
    {
        var origin = line[0];
        var eastPerDegree = MetersPerDegree * Math.Cos(origin.Latitude * Math.PI / 180);
        var projected = new (double X, double Y)[line.Count];
        var longitude = 0.0; // degrees east of the first point, unwrapped
        for (var k = 1; k < line.Count; k++)
        {
            longitude += Math.IEEERemainder(line[k].Longitude - line[k - 1].Longitude, 360);
            projected[k] = (longitude * eastPerDegree, (line[k].Latitude - origin.Latitude) * MetersPerDegree);
        }
        return projected;
    }

    /// <summary>Squared distance from <paramref name="p"/> to the segment a-b; to the point a when the segment has no length.</summary>
    private static double SquaredDistanceToSegment((double X, double Y) p, (double X, double Y) a, (double X, double Y) b)
    {
        var dx = b.X - a.X;
        var dy = b.Y - a.Y;
        var lengthSquared = dx * dx + dy * dy;
        var t = lengthSquared == 0 ? 0 : Math.Clamp(((p.X - a.X) * dx + (p.Y - a.Y) * dy) / lengthSquared, 0, 1);
        var ex = p.X - (a.X + t * dx);
        var ey = p.Y - (a.Y + t * dy);
        return ex * ex + ey * ey;
    }
}
