using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class TransitLinesTests
{
    private static GeoPoint East(double meters) => Geo.Offset(Spots.Home, 0, meters);

    private static TransitLines LinesOf(params GeoPoint[][] lines) => new(lines);

    // ---- one tile ----------------------------------------------------------------------------------------------------

    [Fact]
    public void The_distance_to_a_line_is_to_its_nearest_point_not_its_nearest_vertex()
    {
        // A straight 2 km line with no vertex between its ends, 40 m north of a point under its middle.
        var lines = LinesOf([Geo.Offset(East(-1_000), 40, 0), Geo.Offset(East(1_000), 40, 0)]);

        Assert.Equal(40, lines.DistanceWithin(Spots.Home, 50)!.Value, 0.05);
        Assert.True(lines.IsWithin(Spots.Home, 40.1));
        Assert.False(lines.IsWithin(Spots.Home, 39.9));
        Assert.Null(lines.DistanceWithin(Spots.Home, 39.9));
    }

    [Fact]
    public void The_nearest_of_several_lines_wins()
    {
        var lines = LinesOf(
            [Geo.Offset(East(-500), 60, 0), Geo.Offset(East(500), 60, 0)],
            [Geo.Offset(East(-500), -25, 0), Geo.Offset(East(500), -25, 0)],
            [Geo.Offset(East(-500), 100, 0), Geo.Offset(East(500), 100, 0)]);

        Assert.Equal(25, lines.DistanceWithin(Spots.Home, 150)!.Value, 0.05);
    }

    [Fact]
    public void Past_the_end_of_a_line_the_distance_is_to_its_end()
    {
        var lines = LinesOf([East(-1_000), East(-30)]);

        Assert.Equal(30, lines.DistanceWithin(Spots.Home, 50)!.Value, 0.05);
    }

    [Fact]
    public void A_line_of_one_point_is_a_point_and_an_empty_line_is_nothing()
    {
        var lines = LinesOf([Geo.Offset(Spots.Home, 20, 0)], []);

        Assert.Equal(20, lines.DistanceWithin(Spots.Home, 50)!.Value, 0.05);
        Assert.False(lines.IsEmpty);
        Assert.True(LinesOf([]).IsEmpty);
        Assert.True(TransitLines.Empty.IsEmpty);
        Assert.False(TransitLines.Empty.IsWithin(Spots.Home, 1_000));
    }

    [Fact]
    public void A_vertex_off_the_globe_is_left_out_and_splits_its_line()
    {
        // Without the bad vertex the two halves would be one line passing right over Home.
        var lines = LinesOf([East(-500), East(-40), new GeoPoint(double.NaN, 10), East(40), East(500)]);

        Assert.Equal(40, lines.DistanceWithin(Spots.Home, 100)!.Value, 0.05);
        Assert.Equal(2, LinesOf([new GeoPoint(95, 0), Spots.Home]).Lines[0].Count); // the lines are kept as given
    }

    [Fact]
    public void A_position_off_the_globe_is_near_nothing()
    {
        var lines = LinesOf([East(-500), East(500)]);

        Assert.False(lines.IsWithin(new GeoPoint(double.NaN, 10.75), 1_000));
        Assert.Null(lines.DistanceWithin(new GeoPoint(Spots.Home.Latitude, double.PositiveInfinity), 1_000));
    }

    [Fact] // the grid narrows the candidates only: it gives exactly what looking at every piece of every line gives
    public void The_grid_answers_as_a_search_of_every_line_does()
    {
        var random = new Random(7);
        GeoPoint Somewhere() => Geo.Offset(Spots.Home, random.NextDouble() * 4_000 - 2_000, random.NextDouble() * 4_000 - 2_000);

        var lines = Enumerable.Range(0, 60).Select(_ =>
        {
            var start = Somewhere();
            return Enumerable.Range(0, 1 + random.Next(6)).Select(k => Geo.Offset(start, random.NextDouble() * 900 - 450, random.NextDouble() * 900 - 450)).ToArray();
        }).ToArray();
        var index = new TransitLines(lines);

        for (var q = 0; q < 2_000; q++)
        {
            var p = Somewhere();
            var radius = 20 + random.NextDouble() * 130;
            var expected = BruteForce(lines, p);
            if (Math.Abs(expected - radius) < 0.01)
                continue; // too close to call either way

            Assert.Equal(expected <= radius, index.IsWithin(p, radius));
            if (expected <= radius)
                Assert.Equal(expected, index.DistanceWithin(p, radius)!.Value, 0.01);
        }
    }

    /// <summary>The distance from p to the nearest line, looking at every straight piece, on the same local projection around p.</summary>
    private static double BruteForce(GeoPoint[][] lines, GeoPoint p)
    {
        const double metersPerDegree = 6_371_008.8 * Math.PI / 180;
        var east = metersPerDegree * Math.Cos(p.Latitude * Math.PI / 180);
        (double X, double Y) At(GeoPoint g) => ((g.Longitude - p.Longitude) * east, (g.Latitude - p.Latitude) * metersPerDegree);

        var best = double.PositiveInfinity;
        foreach (var line in lines)
        {
            for (var k = 0; k < line.Length; k++)
            {
                var a = At(line[k]);
                var b = At(line[Math.Min(k + 1, line.Length - 1)]);
                var (dx, dy) = (b.X - a.X, b.Y - a.Y);
                var length = dx * dx + dy * dy;
                var t = length == 0 ? 0 : Math.Clamp(-(a.X * dx + a.Y * dy) / length, 0, 1);
                best = Math.Min(best, Math.Sqrt(Math.Pow(a.X + t * dx, 2) + Math.Pow(a.Y + t * dy, 2)));
            }
        }
        return best;
    }

    [Fact] // a line that runs across the antimeridian is not found from the far side (not needed), but nothing breaks
    public void Lines_across_the_antimeridian_do_not_break_anything()
    {
        var lines = LinesOf([new GeoPoint(0.05, 179.99), new GeoPoint(0.05, -179.99)]);

        Assert.True(lines.IsWithin(new GeoPoint(0.05, 179.995), 10));
        _ = lines.IsWithin(new GeoPoint(0.05, -179.995), 10);
        _ = lines.DistanceWithin(new GeoPoint(0.05, 180), 1_000);
    }

    // ---- several tiles -----------------------------------------------------------------------------------------------

    [Fact]
    public void An_index_finds_the_nearest_line_in_whichever_tile_it_is()
    {
        // Home's tile is (599, 107). A line 40 m north of a point just inside the next tile east, and one 60 m south of it in Home's tile.
        var edge = new GeoPoint(Spots.Home.Latitude, 10.8);
        var p = Geo.Offset(edge, 0, -20);
        var map = new TransitMap()
            .Rail([Geo.Offset(edge, 40, 5), Geo.Offset(edge, 40, 500)])
            .Rail([Geo.Offset(edge, -60, -500), Geo.Offset(edge, -60, -30)]);

        var index = new TransitLineIndex(TransitKind.Rail, map.Tiles(TransitKind.Rail));

        Assert.Equal(2, map.Tiles(TransitKind.Rail).Count);
        Assert.Equal(Math.Sqrt(40 * 40 + 25 * 25), index.DistanceWithin(p, 150)!.Value, 0.05);
        Assert.True(index.IsWithin(p, 48));
        Assert.False(index.IsWithin(p, 46));
    }

    [Fact]
    public void A_tile_the_index_was_not_given_has_no_lines()
    {
        var index = new TransitLineIndex(TransitKind.Bus, []);

        Assert.False(index.IsWithin(Spots.Home, 1_000));
        Assert.Null(index.DistanceWithin(Spots.Home, 1_000));
    }

    [Fact]
    public void An_index_takes_tiles_of_its_own_kind_each_once()
    {
        var rail = new TransitTile(TransitKind.Rail, 599, 107);

        Assert.Throws<ArgumentException>(() => new TransitLineIndex(TransitKind.Bus, [new(rail, TransitLines.Empty)]));
        Assert.Throws<ArgumentException>(() => new TransitLineIndex(TransitKind.Rail, [new(rail, TransitLines.Empty), new(rail, TransitLines.Empty)]));
    }

    [Fact]
    public void A_cache_answers_for_the_tiles_it_holds_only()
    {
        var held = new TransitTile(TransitKind.Rail, 599, 107);
        var cache = new TransitLineCache([new(held, TransitLines.Empty)]);

        Assert.True(cache.TryGetLines(held, out var lines));
        Assert.Same(TransitLines.Empty, lines);
        Assert.False(cache.TryGetLines(held with { Kind = TransitKind.Bus }, out _));
        Assert.False(cache.TryGetLines(held with { LonIndex = 108 }, out _));
        Assert.Equal(1, cache.Count);
    }
}
