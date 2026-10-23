using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class GeoTests
{
    // The plan's 2_755_000..2_775_000 m range is not reachable with its own coordinates and radius: haversine gives
    // 2_738_802 m (checked independently with the spherical law of cosines), and Oslo-Lisbon is ~2 740 km by road atlas.
    [Fact]
    public void Distance_oslo_to_lisbon_is_about_2739_km()
        => Assert.InRange(Geo.DistanceMeters(Spots.Home, Spots.Lisbon), 2_733_000, 2_745_000);

    [Fact]
    public void Distance_is_zero_for_same_point_and_symmetric()
    {
        Assert.Equal(0, Geo.DistanceMeters(Spots.Home, Spots.Home));
        Assert.Equal(Geo.DistanceMeters(Spots.Home, Spots.Tokyo), Geo.DistanceMeters(Spots.Tokyo, Spots.Home), 6);
    }

    [Fact]
    public void Offset_moves_requested_distance()
        => Assert.InRange(Geo.DistanceMeters(Spots.Home, Geo.Offset(Spots.Home, 300, 400)), 499, 501);

    [Theory]
    [InlineData(1_000, 0)]
    [InlineData(0, 1_000)]
    [InlineData(-2_500, 3_000)]
    public void Offset_is_accurate_at_city_scale(double north, double east)
    {
        var moved = Geo.Offset(Spots.Home, north, east);
        Assert.Equal(Math.Sqrt(north * north + east * east), Geo.DistanceMeters(Spots.Home, moved), 0);
    }

    [Fact]
    public void Offset_north_raises_latitude_and_east_raises_longitude()
    {
        var north = Geo.Offset(Spots.Home, 1_000, 0);
        var east = Geo.Offset(Spots.Home, 0, 1_000);
        Assert.True(north.Latitude > Spots.Home.Latitude);
        Assert.Equal(Spots.Home.Longitude, north.Longitude, 9);
        Assert.True(east.Longitude > Spots.Home.Longitude);
        Assert.Equal(Spots.Home.Latitude, east.Latitude, 9);
    }

    [Fact]
    public void GreatCircle_is_continuous_across_antimeridian()
    {
        var arc = Geo.GreatCircle(Spots.Tokyo, Spots.SanFrancisco);
        Assert.Equal(64, arc.Count);
        Assert.All(arc.Zip(arc.Skip(1)), p => Assert.True(Math.Abs(p.First.Longitude - p.Second.Longitude) <= 180));
    }

    [Fact]
    public void GreatCircle_starts_and_ends_at_the_given_points_and_honours_point_count()
    {
        var arc = Geo.GreatCircle(Spots.Home, Spots.Lisbon, 10);
        Assert.Equal(10, arc.Count);
        Assert.True(Geo.DistanceMeters(arc[0], Spots.Home) < 1);
        Assert.True(Geo.DistanceMeters(arc[^1], Spots.Lisbon) < 1);
    }

    [Fact]
    public void GreatCircle_points_are_evenly_spaced_along_the_route()
    {
        var arc = Geo.GreatCircle(Spots.Home, Spots.Lisbon, 11);
        var total = Geo.DistanceMeters(Spots.Home, Spots.Lisbon);
        Assert.All(arc.Zip(arc.Skip(1)), p => Assert.Equal(total / 10, Geo.DistanceMeters(p.First, p.Second), 0));
    }

    [Fact]
    public void GreatCircle_between_identical_points_stays_put()
        => Assert.All(Geo.GreatCircle(Spots.Home, Spots.Home, 5), p => Assert.Equal(Spots.Home, p));
}
