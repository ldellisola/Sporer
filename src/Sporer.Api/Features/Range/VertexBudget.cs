using Sporer.Timeline;

namespace Sporer.Api.Features.Range;

/// <summary>
/// Keeps what a range response draws within a number of vertices, by simplifying the lines a little more than they are stored
/// (a year of routes is far more than a map can draw while it stays interactive).
/// </summary>
public static class VertexBudget
{
    /// <summary>
    /// The most vertices a response carries, all its lines together: the spec's "under about 50k" (section 7.3), which binds over the
    /// 60 000 that the plan first wrote. A year of moves has to stay small enough to draw smoothly on a phone.
    /// </summary>
    public const int MaxVertices = 50_000;

    private const double FirstToleranceMeters = 100;

    /// <summary>
    /// A tolerance this large cuts every line to its two ends, whatever the line (the Earth is 40 000 km round), so the search
    /// for a tolerance can end here at the latest.
    /// </summary>
    private const double LastToleranceMeters = 1_000_000_000;

    /// <summary>
    /// <paramref name="lines"/> as they are while they total <paramref name="maxVertices"/> vertices or fewer. Otherwise every
    /// line is simplified (<see cref="LineSimplifier.Simplify"/>, from the line as it was given) at a tolerance that starts at
    /// 100 m and doubles until the lines fit; the result is the one of the first tolerance that does. A line always keeps its
    /// first and last vertex, and only vertices it had, in their order. When the ends alone are more than
    /// <paramref name="maxVertices"/> (more than half as many lines as vertices allowed) no tolerance can fit them: the lines
    /// come back cut to their ends, which is as short as they go.
    /// </summary>
    public static IReadOnlyList<IReadOnlyList<GeoPoint>> Fit(IReadOnlyList<IReadOnlyList<GeoPoint>> lines, int maxVertices = MaxVertices)
    {
        if (Count(lines) <= maxVertices)
            return lines;

        for (var tolerance = FirstToleranceMeters; ; tolerance *= 2)
        {
            var simplified = new IReadOnlyList<GeoPoint>[lines.Count];
            for (var k = 0; k < lines.Count; k++)
                simplified[k] = LineSimplifier.Simplify(lines[k], tolerance);

            if (Count(simplified) <= maxVertices || tolerance >= LastToleranceMeters)
                return simplified;
        }
    }

    private static long Count(IReadOnlyList<IReadOnlyList<GeoPoint>> lines)
    {
        long total = 0;
        foreach (var line in lines)
            total += line.Count;
        return total;
    }
}
