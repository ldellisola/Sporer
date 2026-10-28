using Sporer.Api.Features.Trips;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>The line a trip is drawn with in the list: home, the places slept at, home again.</summary>
public class TripThumbnailTests
{
    private static readonly GeoPoint Home = Spots.Home;
    private static readonly GeoPoint Lisbon = Spots.Lisbon;

    /// <summary>A point <paramref name="meters"/> east of <paramref name="from"/>.</summary>
    private static GeoPoint East(GeoPoint from, double meters) => Geo.Offset(from, 0, meters);

    [Fact]
    public void The_line_runs_from_home_through_the_nights_and_back_home()
    {
        var line = TripThumbnail.Line(Home, [Lisbon, Spots.Tokyo], Home);

        Assert.Equal([Home, Lisbon, Spots.Tokyo, Home], line);
    }

    [Fact]
    public void Consecutive_nights_within_a_kilometre_are_one_point()
    {
        // Three nights in Lisbon (the second 400 m from the first, the third 900 m), then Tokyo.
        var line = TripThumbnail.Line(Home, [Lisbon, East(Lisbon, 400), East(Lisbon, 900), Spots.Tokyo], Home);

        Assert.Equal([Home, Lisbon, Spots.Tokyo, Home], line);
    }

    [Fact]
    public void A_night_is_compared_with_the_last_point_kept_so_a_slow_drift_is_not_swallowed()
    {
        // Each night is 700 m from the one before, but the third is 1.4 km from the first point: it is a new point.
        var line = TripThumbnail.Line(null, [Lisbon, East(Lisbon, 700), East(Lisbon, 1400)], null);

        Assert.Equal([Lisbon, East(Lisbon, 1400)], line);
    }

    [Fact]
    public void Nights_more_than_a_kilometre_apart_are_kept_and_a_return_to_a_place_is_not_a_repeat()
    {
        var line = TripThumbnail.Line(null, [Lisbon, East(Lisbon, 1500), Lisbon], null);

        Assert.Equal([Lisbon, East(Lisbon, 1500), Lisbon], line);
    }

    [Fact]
    public void An_end_without_a_home_is_left_out()
    {
        Assert.Equal([Lisbon, Home], TripThumbnail.Line(null, [Lisbon], Home));
        Assert.Equal([Home, Lisbon], TripThumbnail.Line(Home, [Lisbon], null));
        Assert.Equal([Lisbon], TripThumbnail.Line(null, [Lisbon], null));
    }

    [Fact]
    public void The_homes_are_not_collapsed_into_the_nights()
    {
        // A trip whose first night is 500 m from home (a short threshold): both points stay.
        var line = TripThumbnail.Line(Home, [East(Home, 500)], Home);

        Assert.Equal([Home, East(Home, 500), Home], line);
    }

    [Fact]
    public void A_trip_with_no_known_night_has_only_its_homes()
    {
        Assert.Equal([Home, Home], TripThumbnail.Line(Home, [], Home));
        Assert.Empty(TripThumbnail.Line(null, [], null));
    }
}
