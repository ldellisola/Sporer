using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class TransitTileTests
{
    // ---- the tile of a position --------------------------------------------------------------------------------------

    [Fact]
    public void A_tile_is_a_tenth_of_a_degree_counted_from_the_equator_and_greenwich()
    {
        var tile = TransitTile.At(TransitKind.Rail, Spots.Home); // 59.92, 10.75

        Assert.Equal(new TransitTile(TransitKind.Rail, 599, 107), tile);
        Assert.Equal(59.9, tile.South);
        Assert.Equal(60.0, tile.North);
        Assert.Equal(10.7, tile.West);
        Assert.Equal(10.8, tile.East);
    }

    [Theory] // floor, not truncation: south and west of zero the index is negative
    [InlineData(-0.05, -0.05, -1, -1)]
    [InlineData(0.0, 0.0, 0, 0)]
    [InlineData(-33.87, 151.21, -339, 1512)]
    [InlineData(38.7223, -9.1393, 387, -92)]
    public void Indexes_are_the_floor_of_ten_times_the_degrees(double lat, double lon, int latIndex, int lonIndex)
    {
        var tile = TransitTile.At(TransitKind.Bus, new GeoPoint(lat, lon));

        Assert.Equal(new TransitTile(TransitKind.Bus, latIndex, lonIndex), tile);
    }

    [Theory] // longitudes are wrapped into [-180, 180); the north pole falls in the last row
    [InlineData(0, 180, 0, -1800)]
    [InlineData(0, -180, 0, -1800)]
    [InlineData(0, 179.99, 0, 1799)]
    [InlineData(0, 190.05, 0, -1700)]
    [InlineData(0, -190.05, 0, 1699)]
    [InlineData(90, 0, 899, 0)]
    [InlineData(-90, 0, -900, 0)]
    public void Longitudes_wrap_and_the_poles_stay_in_range(double lat, double lon, int latIndex, int lonIndex)
        => Assert.Equal(new TransitTile(TransitKind.Rail, latIndex, lonIndex), TransitTile.At(TransitKind.Rail, new GeoPoint(lat, lon)));

    [Fact]
    public void A_position_off_the_globe_has_no_tile()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => TransitTile.At(TransitKind.Rail, new GeoPoint(double.NaN, 0)));
        Assert.Throws<ArgumentOutOfRangeException>(() => TransitTile.At(TransitKind.Rail, new GeoPoint(91, 0)));
    }

    [Fact]
    public void Tiles_order_by_kind_then_latitude_then_longitude()
    {
        TransitTile[] tiles =
        [
            new(TransitKind.Bus, 0, 0), new(TransitKind.Rail, 1, -5), new(TransitKind.Rail, 0, 7), new(TransitKind.Rail, 0, -3),
        ];

        Assert.Equal(
            [new(TransitKind.Rail, 0, -3), new(TransitKind.Rail, 0, 7), new(TransitKind.Rail, 1, -5), new(TransitKind.Bus, 0, 0)],
            tiles.Order());
    }

    // ---- the tiles near positions ------------------------------------------------------------------------------------

    /// <summary>The middle of tile (599, 107): about 5.5 km from its southern and northern edges and 2.8 km from its western and eastern ones.</summary>
    private static readonly GeoPoint Middle = new(59.95, 10.75);

    /// <summary>The south-west corner of tile (599, 108).</summary>
    private static readonly GeoPoint Corner = new(59.9, 10.8);

    [Fact]
    public void A_point_far_from_any_edge_needs_its_own_tile_only()
    {
        Assert.Equal([new TransitTile(TransitKind.Rail, 599, 107)], TransitTile.Near(TransitKind.Rail, [Middle], 150));
    }

    [Fact]
    public void A_point_near_an_edge_needs_the_tile_across_it()
    {
        var westOfEdge = Geo.Offset(new GeoPoint(Middle.Latitude, 10.8), 0, -100); // 100 m west of the edge between 107 and 108

        Assert.Equal(
            [new TransitTile(TransitKind.Rail, 599, 107), new TransitTile(TransitKind.Rail, 599, 108)],
            TransitTile.Near(TransitKind.Rail, [westOfEdge], 150));
        Assert.Equal([new TransitTile(TransitKind.Rail, 599, 107)], TransitTile.Near(TransitKind.Rail, [westOfEdge], 99));
    }

    [Fact]
    public void A_point_near_a_corner_needs_the_diagonal_tile_only_when_the_corner_is_within_reach()
    {
        // 100 m south and 100 m west of the corner: the corner is 141 m away. Every tile meeting there is within 150 m, none within 140 m diagonally.
        var near = Geo.Offset(Corner, -100, -100);

        Assert.Equal(4, TransitTile.Near(TransitKind.Rail, [near], 150).Count);
        Assert.Equal(
            [new TransitTile(TransitKind.Rail, 598, 107), new TransitTile(TransitKind.Rail, 598, 108), new TransitTile(TransitKind.Rail, 599, 107)],
            TransitTile.Near(TransitKind.Rail, [near], 140));
    }

    [Fact]
    public void Tiles_near_many_points_are_listed_once_each_in_order()
    {
        var points = Enumerable.Range(0, 200).Select(k => Geo.Offset(Middle, 0, k * 25)).ToList(); // 5 km east, across the edge at 10.8

        var tiles = TransitTile.Near(TransitKind.Bus, points, 150);

        Assert.Equal([new TransitTile(TransitKind.Bus, 599, 107), new TransitTile(TransitKind.Bus, 599, 108)], tiles);
    }

    [Fact]
    public void Tiles_near_the_antimeridian_wrap_round()
    {
        var east = new GeoPoint(0.05, 179.9995); // about 55 m west of the antimeridian

        Assert.Equal(
            [new TransitTile(TransitKind.Rail, 0, -1800), new TransitTile(TransitKind.Rail, 0, 1799)],
            TransitTile.Near(TransitKind.Rail, [east], 150));
    }

    [Fact]
    public void Positions_off_the_globe_need_no_tile_and_no_distance_is_negative()
    {
        Assert.Empty(TransitTile.Near(TransitKind.Rail, [new GeoPoint(double.NaN, 10), new GeoPoint(95, 10)], 150));
        Assert.Throws<ArgumentOutOfRangeException>(() => TransitTile.Near(TransitKind.Rail, [Middle], -1));
    }

    [Fact] // near a pole every column is within reach; that must stay a bounded answer, not hang or throw
    public void A_point_at_the_pole_needs_every_tile_of_its_row()
    {
        var tiles = TransitTile.Near(TransitKind.Rail, [new GeoPoint(90, 0)], 150);

        Assert.Equal(3600, tiles.Count);
        Assert.All(tiles, t => Assert.Equal(899, t.LatIndex));
    }
}
