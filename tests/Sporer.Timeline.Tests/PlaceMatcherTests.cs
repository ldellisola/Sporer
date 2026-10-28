using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class PlaceMatcherTests
{
    private const double Radius = 75;

    // Synthetic Tromsø-like position: a degree of longitude is only ~38 km here, so a naive degree grid breaks.
    private static readonly GeoPoint Tromso = new(69.6500, 18.9600);

    // Next to the antimeridian: a Pacific spot and a high-latitude one.
    private static readonly GeoPoint Fiji = new(-17.0000, 179.9990);
    private static readonly GeoPoint Chukotka = new(71.0000, 179.9990);

    /// <summary>A matcher of places that each stand for themselves (none of them is merged into another).</summary>
    private static PlaceMatcher MatcherOf(params (long Id, GeoPoint Centre)[] places)
        => new(places.Select(p => (p.Id, p.Centre, SurvivorId: p.Id)), Radius);

    /// <summary>
    /// A latitude on a grid line of a grid of radius-tall cells aligned to -90 (the natural layout; if the matcher
    /// lays its grid out differently this is just an ordinary latitude and the test still holds).
    /// </summary>
    private static double LatitudeGridLine()
    {
        const double earthRadiusMeters = 6_371_008.8;
        var cellDegrees = Radius / earthRadiusMeters * 180 / Math.PI;
        return -90 + Math.Round((Spots.Home.Latitude + 90) / cellDegrees) * cellDegrees;
    }

    // ---- the brief -----------------------------------------------------------------------------------------------

    [Fact]
    public void Matches_nearest_within_radius()
    {
        // The farther place gets the lower id and is listed first, so only distance can pick the right one.
        var matcher = MatcherOf((1, Geo.Offset(Spots.Cafe, 60, 0)), (2, Geo.Offset(Spots.Cafe, 0, 40)));

        Assert.Equal(2, matcher.Match(Spots.Cafe));
    }

    [Fact]
    public void No_match_beyond_radius()
    {
        var matcher = MatcherOf((1, Geo.Offset(Spots.Cafe, 80, 0)));

        Assert.Null(matcher.Match(Spots.Cafe));
    }

    [Fact]
    public void Added_place_is_matched()
    {
        var matcher = MatcherOf((1, Spots.Home));
        Assert.Null(matcher.Match(Spots.Cafe));

        matcher.Add(9, Spots.Cafe);

        Assert.Equal(9, matcher.Match(Geo.Offset(Spots.Cafe, 10, 0)));
        Assert.Equal(1, matcher.Match(Spots.Home)); // existing places are unaffected
    }

    [Fact]
    public void Works_near_cell_borders()
    {
        // Place 10 m south and query 10 m north of a latitude grid line: 20 m apart, in different cells.
        var onLine = new GeoPoint(LatitudeGridLine(), Spots.Home.Longitude);
        var matcher = MatcherOf((4, Geo.Offset(onLine, -10, 0)));

        Assert.Equal(4, matcher.Match(Geo.Offset(onLine, 10, 0)));
    }

    // ---- merged places ---------------------------------------------------------------------------------------------

    [Fact]
    public void PlaceMatcher_matches_a_merged_place_to_its_survivor()
    {
        // Place 2 was merged into place 1, which is a kilometre away: a stay at the centre of place 2 is at place 1 now. Place 3 is
        // its own survivor, and a stay at it is at it.
        var matcher = new PlaceMatcher(
            [(1, Spots.Home, 1L), (2, Spots.Cafe, 1L), (3, Spots.Office, 3L)], Radius);

        Assert.Equal(1, matcher.Match(Spots.Cafe));
        Assert.Equal(1, matcher.Match(Geo.Offset(Spots.Cafe, 50, 0))); // within the radius of the merged place's centre
        Assert.Null(matcher.Match(Geo.Offset(Spots.Cafe, 80, 0)));     // beyond it: not near anything
        Assert.Equal(1, matcher.Match(Spots.Home));
        Assert.Equal(3, matcher.Match(Spots.Office));
    }

    [Fact]
    public void PlaceMatcher_matches_through_a_chain_of_merges_to_the_last_survivor()
    {
        // The survivor of each place is worked out by the caller (from the chain of merges): 3 was merged into 2, which was merged into 1.
        var matcher = new PlaceMatcher([(1, Spots.Home, 1L), (2, Spots.Cafe, 1L), (3, Spots.Office, 1L)], Radius);

        Assert.Equal(1, matcher.Match(Spots.Office));
        Assert.Equal(1, matcher.Match(Spots.Cafe));
    }

    [Fact]
    public void PlaceMatcher_nearest_centre_wins_across_merged_and_active()
    {
        var query = Spots.Cafe;
        var merged = (Id: 2L, Centre: Geo.Offset(query, 20, 0), SurvivorId: 9L);     // 20 m away, merged into 9
        var active = (Id: 1L, Centre: Geo.Offset(query, 0, 60), SurvivorId: 1L);     // 60 m away, its own survivor
        Assert.Equal(9, new PlaceMatcher([active, merged, (9, Spots.Home, 9L)], Radius).Match(query)); // the merged one is nearer

        var farMerged = (Id: 2L, Centre: Geo.Offset(query, 70, 0), SurvivorId: 9L);  // 70 m away
        Assert.Equal(1, new PlaceMatcher([farMerged, active, (9, Spots.Home, 9L)], Radius).Match(query)); // the active one is nearer

        // An exact tie goes to the lower id of the two places, not to the lower id of their survivors.
        var tiedMerged = (Id: 5L, Centre: Geo.Offset(query, 40, 0), SurvivorId: 1L);
        var tiedActive = (Id: 7L, Centre: Geo.Offset(query, -40, 0), SurvivorId: 7L);
        Assert.Equal(Geo.DistanceMeters(query, tiedMerged.Centre), Geo.DistanceMeters(query, tiedActive.Centre), 6);
        Assert.Equal(1, new PlaceMatcher([tiedActive, tiedMerged, (1, Spots.Home, 1L)], Radius).Match(query));
        Assert.Equal(1, new PlaceMatcher([(1, Spots.Home, 1L), tiedMerged, tiedActive], Radius).Match(query));
    }

    [Fact]
    public void An_added_place_can_stand_for_another()
    {
        var matcher = MatcherOf((1, Spots.Home));

        matcher.Add(9, Spots.Cafe, 1);

        Assert.Equal(1, matcher.Match(Spots.Cafe));
        Assert.Throws<ArgumentException>(() => matcher.Add(9, Spots.Office, 9)); // the id is the place's, not the survivor's
        matcher.Add(10, Spots.Office, 1);
        Assert.Equal(1, matcher.Match(Spots.Office));
    }

    // ---- borders, whatever the grid ------------------------------------------------------------------------------

    public static TheoryData<double, double, double> SweepStarts => new()
    {
        { Spots.Home.Latitude, Spots.Home.Longitude, 0 },
        { Spots.Home.Latitude, Spots.Home.Longitude, 90 },
        { Tromso.Latitude, Tromso.Longitude, 0 },
        { Tromso.Latitude, Tromso.Longitude, 90 },
        { 0.0, 0.0, 0 },
        { 0.0, 0.0, 90 },
    };

    [Theory]
    [MemberData(nameof(SweepStarts))]
    public void Pairs_20_m_apart_match_wherever_they_fall_relative_to_the_grid(double lat, double lon, double bearingDegrees)
    {
        // Slide a 20 m pair across 600 m (several cells) in 3 m steps: some pair is bound to straddle every grid line.
        var bearing = bearingDegrees * Math.PI / 180;
        var (north, east) = (Math.Cos(bearing), Math.Sin(bearing));
        var origin = new GeoPoint(lat, lon);

        for (var step = 0; step <= 200; step++)
        {
            var along = step * 3.0;
            var place = Geo.Offset(origin, north * along, east * along);
            var query = Geo.Offset(origin, north * (along + 20), east * (along + 20));

            Assert.Equal(1, MatcherOf((1, place)).Match(query));
        }
    }

    // ---- high latitude -------------------------------------------------------------------------------------------

    [Theory]
    [InlineData(0.0, 0.0)]
    [InlineData(59.9200, 10.7500)]
    [InlineData(69.6500, 18.9600)] // Tromsø
    [InlineData(85.0, 30.0)]
    [InlineData(-17.0, 179.9990)]  // next to the antimeridian
    [InlineData(71.0, -179.9990)]
    public void Matches_in_every_direction_within_radius_and_not_beyond(double lat, double lon)
    {
        var centre = new GeoPoint(lat, lon);
        var matcher = MatcherOf((1, centre));

        for (var bearing = 0; bearing < 360; bearing += 10)
        {
            var radians = bearing * Math.PI / 180;
            var (north, east) = (Math.Cos(radians), Math.Sin(radians));

            Assert.Equal(1, matcher.Match(Geo.Offset(centre, north * 74, east * 74)));
            Assert.Null(matcher.Match(Geo.Offset(centre, north * 76, east * 76)));
        }
    }

    [Fact]
    public void East_and_west_neighbours_match_at_high_latitude_where_a_degree_of_longitude_is_short()
    {
        // 70 m is ~0.0018 degrees of longitude at 69.65 N: more than two cells of 75 m worth of latitude.
        var matcher = MatcherOf((1, Tromso));

        Assert.Equal(1, matcher.Match(Geo.Offset(Tromso, 0, 70)));
        Assert.Equal(1, matcher.Match(Geo.Offset(Tromso, 0, -70)));
    }

    [Theory]
    [InlineData(1, 75)]
    [InlineData(-1, 75)]
    [InlineData(1, 40)]
    [InlineData(-1, 40)]
    [InlineData(1, 80)]
    [InlineData(-1, 80)]
    [InlineData(1, 120)]
    [InlineData(-1, 120)]
    public void Matches_at_every_longitude_around_the_pole(int hemisphere, double radius)
    {
        // The query sits 2 m from the pole. A place c metres from the pole, at any longitude, is within c + 2 m of it
        // (across the pole at worst), so every c up to the radius less 2 m matches whatever the longitude. Several
        // radii, because where the grid's rows fall relative to the pole depends on the radius.
        const double metersPerDegree = 6_371_008.8 * Math.PI / 180;
        var query = new GeoPoint(hemisphere * (90 - 2 / metersPerDegree), 0);

        for (var c = 1; c <= radius - 3; c++)
        {
            for (var longitude = -180; longitude < 180; longitude += 15)
            {
                var place = new GeoPoint(hemisphere * (90 - c / metersPerDegree), longitude);
                Assert.True(Geo.DistanceMeters(query, place) <= radius, "bad test data");

                Assert.Equal(5, new PlaceMatcher([(5, place, 5L)], radius).Match(query));
            }
        }
    }

    [Fact]
    public void Matches_a_place_exactly_at_the_pole_from_any_longitude()
    {
        var matcher = MatcherOf((5, new GeoPoint(90, 0)));

        Assert.Equal(5, matcher.Match(new GeoPoint(89.99999, 180)));
        Assert.Equal(5, matcher.Match(new GeoPoint(89.99999, -120)));
        Assert.Equal(5, matcher.Match(new GeoPoint(90, 77)));
    }

    // ---- antimeridian --------------------------------------------------------------------------------------------

    [Theory]
    [InlineData(0.0)]
    [InlineData(-17.0)]
    [InlineData(71.0)]
    [InlineData(85.0)]
    public void Matches_across_the_antimeridian_in_both_directions(double lat)
    {
        // 30 m either side of the line: 60 m apart.
        var line = new GeoPoint(lat, 180);
        var west = Geo.Offset(line, 0, -30);
        var east = Geo.Offset(line, 0, 30);
        Assert.True(west.Longitude > 0 && east.Longitude < 0, "the test points must straddle the antimeridian");

        Assert.Equal(3, MatcherOf((3, west)).Match(east));
        Assert.Equal(3, MatcherOf((3, east)).Match(west));
    }

    [Fact]
    public void Does_not_match_across_the_antimeridian_beyond_the_radius()
    {
        // 0.002 degrees of longitude is ~76 m at 70 N: just beyond the radius.
        var matcher = MatcherOf((3, new GeoPoint(70, 179.9990)));

        Assert.Null(matcher.Match(new GeoPoint(70, -179.9990)));
        Assert.Equal(3, matcher.Match(new GeoPoint(70, -179.9995)));
    }

    [Fact]
    public void Treats_longitudes_outside_the_normal_range_as_the_same_place()
    {
        var matcher = MatcherOf((3, new GeoPoint(0, 179.9999)));

        Assert.Equal(3, matcher.Match(new GeoPoint(0, 180.0001)));  // = -179.9999
        Assert.Equal(3, matcher.Match(new GeoPoint(0, -180.0001))); // = 179.9999
        Assert.Equal(3, matcher.Match(new GeoPoint(0, 539.9999)));       // = 179.9999 again
    }

    [Fact]
    public void Place_given_with_an_unwrapped_longitude_is_found_by_a_wrapped_query()
    {
        var matcher = MatcherOf((3, new GeoPoint(0, 180.0002)));

        Assert.Equal(3, matcher.Match(new GeoPoint(0, -179.9999)));
        Assert.Equal(3, matcher.Match(new GeoPoint(0, 179.9999)));
    }

    // ---- determinism ---------------------------------------------------------------------------------------------

    [Fact]
    public void Tie_resolves_to_the_lower_id_whatever_the_insertion_order()
    {
        var query = Geo.Offset(Spots.Cafe, 20, 0);

        Assert.Equal(3, MatcherOf((3, Spots.Cafe), (7, Spots.Cafe)).Match(query));
        Assert.Equal(3, MatcherOf((7, Spots.Cafe), (3, Spots.Cafe)).Match(query));

        var added = MatcherOf((7, Spots.Cafe));
        added.Add(3, Spots.Cafe);
        Assert.Equal(3, added.Match(query));
        added.Add(1, Spots.Cafe);
        Assert.Equal(1, added.Match(query));
    }

    [Fact]
    public void Tie_between_cells_resolves_to_the_lower_id()
    {
        // Mirror images about the equator are exactly equidistant from a point on it, and 0.001 degrees apart, so
        // they are always in different latitude cells (cells are ~0.00067 degrees tall).
        var north = new GeoPoint(0.0005, 10);
        var south = new GeoPoint(-0.0005, 10);
        var between = new GeoPoint(0, 10);
        Assert.Equal(Geo.DistanceMeters(between, north), Geo.DistanceMeters(between, south));

        Assert.Equal(1, MatcherOf((1, north), (2, south)).Match(between));
        Assert.Equal(1, MatcherOf((2, south), (1, north)).Match(between));
        Assert.Equal(1, MatcherOf((1, south), (2, north)).Match(between));
        Assert.Equal(1, MatcherOf((2, north), (1, south)).Match(between));
    }

    [Fact]
    public void Nearer_place_beats_lower_id()
    {
        var matcher = MatcherOf((1, Geo.Offset(Spots.Cafe, 50, 0)), (8, Geo.Offset(Spots.Cafe, 5, 0)));

        Assert.Equal(8, matcher.Match(Spots.Cafe));
    }

    [Fact]
    public void Matching_is_repeatable()
    {
        var matcher = MatcherOf((1, Spots.Home), (2, Spots.Cafe), (3, Spots.Gym));
        var query = Geo.Offset(Spots.Cafe, 30, 30);

        var first = matcher.Match(query);

        Assert.Equal(2, first);
        for (var i = 0; i < 5; i++) Assert.Equal(first, matcher.Match(query));
    }

    // ---- configuration and edge cases ----------------------------------------------------------------------------

    [Fact]
    public void Radius_is_configurable()
    {
        var place = Geo.Offset(Spots.Cafe, 150, 0);

        Assert.Null(new PlaceMatcher([(1, place, 1L)], 75).Match(Spots.Cafe));
        Assert.Equal(1, new PlaceMatcher([(1, place, 1L)], 200).Match(Spots.Cafe));
        Assert.Equal(1, new PlaceMatcher([(1, place, 1L)], 2_000).Match(Geo.Offset(Spots.Cafe, 1_800, 0)));
    }

    [Fact]
    public void A_place_matches_at_its_own_centre()
        => Assert.Equal(1, MatcherOf((1, Spots.Home)).Match(Spots.Home));

    [Fact]
    public void Empty_matcher_matches_nothing()
        => Assert.Null(new PlaceMatcher([], Radius).Match(Spots.Home));

    // ---- agrees with brute force ---------------------------------------------------------------------------------

    [Fact]
    public void Agrees_with_brute_force_everywhere()
    {
        var random = new Random(20261023);
        var places = new List<(long Id, GeoPoint Centre)>();
        var queries = new List<GeoPoint>();

        // Clusters 300 m across, so plenty of queries have several candidates, some inside the radius and some not.
        var anchors = new[]
        {
            Spots.Home, Tromso, Fiji, Chukotka, Spots.Tokyo, new GeoPoint(0, 0), new GeoPoint(0, 179.9998), new GeoPoint(-60, -45),
        };
        foreach (var anchor in anchors)
        {
            for (var i = 0; i < 120; i++)
            {
                places.Add((places.Count + 1, Scatter(anchor, random)));
                queries.Add(Scatter(anchor, random));
            }
        }

        AssertAgreesWithBruteForce(places, queries, random);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(-1)]
    public void Agrees_with_brute_force_around_the_poles(int hemisphere)
    {
        // A cap 130 m across the pole holds places and queries at every longitude: opposite sides of the pole are a
        // few metres apart however far apart their longitudes are.
        var random = new Random(hemisphere + 20261023);
        var places = new List<(long Id, GeoPoint Centre)>();
        var queries = new List<GeoPoint>();
        for (var i = 0; i < 600; i++)
        {
            places.Add((places.Count + 1, NearPole(hemisphere, random)));
            queries.Add(NearPole(hemisphere, random));
        }

        AssertAgreesWithBruteForce(places, queries, random);
    }

    /// <summary>
    /// Matches every query against a matcher holding <paramref name="places"/> (ids shuffled on the way in, so "lowest
    /// id" is not just "first inserted") and checks it against the obvious scan: nearest within the radius, lowest id on a tie.
    /// </summary>
    private static void AssertAgreesWithBruteForce(List<(long Id, GeoPoint Centre)> places, List<GeoPoint> queries, Random random)
    {
        var matcher = new PlaceMatcher(places.OrderBy(_ => random.Next()).Select(p => (p.Id, p.Centre, SurvivorId: p.Id)), Radius);
        var matched = 0;

        foreach (var query in queries)
        {
            long? expected = null;
            var best = double.MaxValue;
            foreach (var (id, centre) in places)
            {
                var distance = Geo.DistanceMeters(query, centre);
                if (distance > Radius) continue;
                if (distance < best || (distance == best && id < expected))
                {
                    best = distance;
                    expected = id;
                }
            }

            Assert.Equal(expected, matcher.Match(query));
            if (expected is not null) matched++;
        }

        Assert.True(matched > queries.Count / 10, $"only {matched} of {queries.Count} queries matched; the test would prove little");
    }

    private static GeoPoint Scatter(GeoPoint anchor, Random random)
        => Geo.Offset(anchor, (random.NextDouble() - 0.5) * 300, (random.NextDouble() - 0.5) * 300);

    /// <summary>A point within ~130 m of a pole, uniform over the cap, at any longitude.</summary>
    private static GeoPoint NearPole(int hemisphere, Random random)
    {
        const double capRadiusDegrees = 130 / 6_371_008.8 * 180 / Math.PI;
        var distanceFromPole = Math.Sqrt(random.NextDouble()) * capRadiusDegrees;
        return new GeoPoint(hemisphere * (90 - distanceFromPole), random.NextDouble() * 360 - 180);
    }

    // ---- guards --------------------------------------------------------------------------------------------------

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    public void Rejects_a_radius_that_is_not_positive_and_finite(double radius)
        => Assert.Throws<ArgumentOutOfRangeException>(() => new PlaceMatcher([], radius));

    [Fact]
    public void Rejects_a_duplicate_id()
    {
        var matcher = MatcherOf((1, Spots.Home));

        Assert.Throws<ArgumentException>(() => matcher.Add(1, Spots.Cafe));
        Assert.Throws<ArgumentException>(() => MatcherOf((2, Spots.Home), (2, Spots.Cafe)));
        Assert.Null(matcher.Match(Spots.Cafe)); // the rejected Add changed nothing
    }

    [Theory]
    [InlineData(double.NaN, 0)]
    [InlineData(0, double.NaN)]
    [InlineData(91, 0)]
    [InlineData(-91, 0)]
    [InlineData(double.PositiveInfinity, 0)]
    [InlineData(0, double.NegativeInfinity)]
    public void Rejects_a_place_that_is_not_on_the_globe(double lat, double lon)
        => Assert.Throws<ArgumentOutOfRangeException>(() => MatcherOf((1, Spots.Home)).Add(2, new GeoPoint(lat, lon)));

    [Fact]
    public void A_query_that_is_not_a_position_matches_nothing()
    {
        var matcher = MatcherOf((1, Spots.Home));

        Assert.Null(matcher.Match(new GeoPoint(double.NaN, 10)));
        Assert.Null(matcher.Match(new GeoPoint(59.92, double.NaN)));
        Assert.Null(matcher.Match(new GeoPoint(59.92, double.PositiveInfinity)));
    }
}
