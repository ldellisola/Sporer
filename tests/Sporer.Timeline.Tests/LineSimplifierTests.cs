using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class LineSimplifierTests
{
    private static GeoPoint East(double meters, GeoPoint? from = null) => Geo.Offset(from ?? Spots.Home, 0, meters);

    /// <summary><paramref name="count"/> points straight east of Home, <paramref name="stepMeters"/> apart.</summary>
    private static List<GeoPoint> StraightEast(int count, double stepMeters, GeoPoint? from = null)
        => [.. Enumerable.Range(0, count).Select(k => East(k * stepMeters, from))];

    [Fact]
    public void Simplify_straight_line_keeps_ends()
    {
        var line = StraightEast(100, 10);

        var simplified = LineSimplifier.Simplify(line, 5);

        Assert.Equal([line[0], line[^1]], simplified);
    }

    [Fact]
    public void Simplify_keeps_corner_beyond_tolerance()
    {
        // L-shape with 200 m legs: the corner is 141 m from the straight line between the ends.
        var corner = East(200);
        var end = Geo.Offset(corner, 200, 0);
        List<GeoPoint> line = [.. StraightEast(21, 10), .. Enumerable.Range(1, 20).Select(k => Geo.Offset(corner, k * 10, 0))];

        var simplified = LineSimplifier.Simplify(line, 50);

        Assert.Equal([Spots.Home, corner, end], simplified);
    }

    [Fact]
    public void Simplify_drops_the_corner_within_tolerance()
    {
        var corner = East(200);
        var end = Geo.Offset(corner, 200, 0);

        Assert.Equal([Spots.Home, end], LineSimplifier.Simplify([Spots.Home, corner, end], 150));
        Assert.Equal([Spots.Home, corner, end], LineSimplifier.Simplify([Spots.Home, corner, end], 140));
    }

    [Fact] // a point 5 m off a 2 km line is dropped at 5.1 m and kept at 4.9 m
    public void Simplify_compares_the_deviation_with_the_tolerance()
    {
        var middle = Geo.Offset(East(1_000), 5, 0);
        List<GeoPoint> line = [Spots.Home, middle, East(2_000)];

        Assert.Equal(2, LineSimplifier.Simplify(line, 5.1).Count);
        Assert.Equal(3, LineSimplifier.Simplify(line, 4.9).Count);
    }

    [Fact]
    public void Simplify_with_a_tiny_tolerance_drops_only_collinear_points()
    {
        Assert.Equal(2, LineSimplifier.Simplify(StraightEast(50, 10), 0.001).Count);

        List<GeoPoint> bent = [Spots.Home, Geo.Offset(East(1_000), 1, 0), East(2_000)]; // 1 m off the straight line
        Assert.Equal(3, LineSimplifier.Simplify(bent, 0.001).Count);
        Assert.Equal(3, LineSimplifier.Simplify(bent, 0).Count);
    }

    [Fact]
    public void Simplify_keeps_every_turn_of_a_zigzag_beyond_tolerance()
    {
        // Out 100 m east, 30 m north, back 100 m: every turn is more than 5 m off the line between its neighbours.
        List<GeoPoint> line = [];
        var at = Spots.Home;
        for (var k = 0; k < 6; k++)
        {
            line.Add(at);
            at = Geo.Offset(at, k % 2 == 0 ? 30 : -30, 100);
        }
        line.Add(at);

        Assert.Equal(line, LineSimplifier.Simplify(line, 5));
    }

    [Fact] // the line goes past the end and comes back: the far point is not on the chord's line within the segment
    public void Simplify_keeps_a_point_beyond_the_end_of_the_chord()
    {
        List<GeoPoint> line = [Spots.Home, East(1_000), East(500)];

        Assert.Equal(line, LineSimplifier.Simplify(line, 50));
    }

    [Fact] // first and last are the same place: the loop must not collapse to a point
    public void Simplify_keeps_the_far_points_of_a_closed_loop()
    {
        // A 500 m square walked back to its start: every corner is far from the (zero-length) chord or from the one after it.
        List<GeoPoint> loop = [Spots.Home, East(500), Geo.Offset(East(500), 500, 0), Geo.Offset(Spots.Home, 500, 0), Spots.Home];

        Assert.Equal(loop, LineSimplifier.Simplify(loop, 50));
        Assert.Equal([Spots.Home, Spots.Home], LineSimplifier.Simplify(loop, 1_000)); // the whole loop is within 1 km of its start
    }

    [Fact]
    public void Simplify_returns_lines_of_two_points_or_fewer_unchanged()
    {
        Assert.Empty(LineSimplifier.Simplify([], 5));
        Assert.Equal([Spots.Home], LineSimplifier.Simplify([Spots.Home], 5));
        Assert.Equal([Spots.Home, Spots.Home], LineSimplifier.Simplify([Spots.Home, Spots.Home], 5));
        Assert.Equal([Spots.Home, Spots.Cafe], LineSimplifier.Simplify([Spots.Home, Spots.Cafe], 5000));
    }

    [Fact]
    public void Simplify_does_not_change_the_input_and_returns_original_points_in_order()
    {
        var line = StraightEast(30, 10);
        line[15] = Geo.Offset(line[15], 40, 0);
        var before = line.ToList();

        var simplified = LineSimplifier.Simplify(line, 5);

        Assert.Equal(before, line);
        Assert.Equal([line[0], line[14], line[15], line[16], line[^1]], simplified); // the spike and the points either side of it
    }

    [Fact]
    public void Simplify_every_dropped_point_stays_within_the_tolerance_of_the_result()
    {
        const double tolerance = 25;
        var line = WanderingLine(400);

        var simplified = LineSimplifier.Simplify(line, tolerance);

        Assert.True(simplified.Count < line.Count / 2, "a wandering line should simplify a lot");
        Assert.Equal(line[0], simplified[0]);
        Assert.Equal(line[^1], simplified[^1]);
        var kept = simplified.Select(p => line.IndexOf(p)).ToList();
        Assert.Equal(kept.Order(), kept); // original points, in original order
        for (var s = 0; s + 1 < kept.Count; s++)
        {
            for (var k = kept[s] + 1; k < kept[s + 1]; k++)
                Assert.True(DistanceToSegment(line[k], line[kept[s]], line[kept[s + 1]]) <= tolerance * 1.05);
        }
    }

    [Fact]
    public void Simplify_a_larger_tolerance_never_keeps_more_points()
    {
        var line = WanderingLine(400);

        var counts = new[] { 0.0, 1, 5, 20, 50, 200, 1_000, 10_000 }.Select(t => LineSimplifier.Simplify(line, t).Count).ToList();

        Assert.Equal(counts.Order().Reverse(), counts);
        Assert.Equal(2, counts[^1]);
    }

    [Fact]
    public void Simplify_works_across_the_antimeridian()
    {
        // 100 collinear points along the equator from 179.95 east over the antimeridian: still a straight line.
        var start = new GeoPoint(0, 179.95);
        var line = StraightEast(100, 100, start);
        Assert.Contains(line, p => p.Longitude < 0);
        Assert.Contains(line, p => p.Longitude > 179);

        var simplified = LineSimplifier.Simplify(line, 5);

        Assert.Equal([line[0], line[^1]], simplified);
    }

    [Fact]
    public void Simplify_keeps_a_corner_on_the_far_side_of_the_antimeridian()
    {
        var start = new GeoPoint(0, 179.95);
        var corner = East(10_000, start); // about 0.09 degrees east: past the antimeridian
        var end = Geo.Offset(corner, 10_000, 0);
        List<GeoPoint> line = [.. StraightEast(101, 100, start), .. Enumerable.Range(1, 100).Select(k => Geo.Offset(corner, k * 100, 0))];
        Assert.True(corner.Longitude < 0);

        var simplified = LineSimplifier.Simplify(line, 50);

        Assert.Equal([start, corner, end], simplified);
    }

    [Fact] // Geo.GreatCircle gives longitudes beyond 180 for a crossing: the same line, just unwrapped
    public void Simplify_works_on_an_unwrapped_line()
    {
        var arc = Geo.GreatCircle(Spots.Tokyo, Spots.SanFrancisco, 200);
        Assert.True(arc[^1].Longitude > 180);

        var simplified = LineSimplifier.Simplify(arc, 5_000);

        Assert.InRange(simplified.Count, 3, arc.Count / 2); // curved in the projection, so not just the two ends
        Assert.Equal(arc[0], simplified[0]);
        Assert.Equal(arc[^1], simplified[^1]);
    }

    [Fact]
    public void Simplify_handles_a_line_of_100000_points()
    {
        // An outward spiral: nearly every point is a turn at a tiny tolerance.
        var line = Enumerable.Range(0, 100_000)
            .Select(k => Geo.Offset(Spots.Home, k * 0.5 * Math.Sin(k / 1000.0), k * 0.5 * Math.Cos(k / 1000.0)))
            .ToList();

        var simplified = LineSimplifier.Simplify(line, 0.001);

        Assert.Equal(line[0], simplified[0]);
        Assert.Equal(line[^1], simplified[^1]);
        Assert.True(simplified.Count > 1_000);
    }

    [Fact]
    public void Simplify_rejects_null_and_negative_or_NaN_tolerance()
    {
        Assert.Throws<ArgumentNullException>(() => LineSimplifier.Simplify(null!, 5));
        Assert.Throws<ArgumentOutOfRangeException>(() => LineSimplifier.Simplify([Spots.Home, Spots.Cafe], -1));
        Assert.Throws<ArgumentOutOfRangeException>(() => LineSimplifier.Simplify([Spots.Home, Spots.Cafe], double.NaN));
    }

    /// <summary>A deterministic wandering line of about 2 km a side: steps of ~10 m whose heading drifts.</summary>
    private static List<GeoPoint> WanderingLine(int count)
    {
        var line = new List<GeoPoint>(count) { Spots.Home };
        double heading = 0;
        for (var k = 1; k < count; k++)
        {
            heading += Math.Sin(k * 0.7) * 0.4 + Math.Cos(k * 0.13) * 0.1;
            line.Add(Geo.Offset(line[^1], 10 * Math.Cos(heading), 10 * Math.Sin(heading)));
        }
        return line;
    }

    /// <summary>Distance from <paramref name="p"/> to the segment a-b in a local flat projection around a (independent of the code under test).</summary>
    private static double DistanceToSegment(GeoPoint p, GeoPoint a, GeoPoint b)
    {
        (double X, double Y) Flat(GeoPoint q) => (
            Math.Sign(q.Longitude - a.Longitude) * Geo.DistanceMeters(a, new GeoPoint(a.Latitude, q.Longitude)),
            Math.Sign(q.Latitude - a.Latitude) * Geo.DistanceMeters(a, new GeoPoint(q.Latitude, a.Longitude)));

        var (px, py) = Flat(p);
        var (bx, by) = Flat(b);
        var lengthSquared = bx * bx + by * by;
        var t = lengthSquared == 0 ? 0 : Math.Clamp((px * bx + py * by) / lengthSquared, 0, 1);
        return Math.Sqrt(Math.Pow(px - t * bx, 2) + Math.Pow(py - t * by, 2));
    }
}
