using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class ModeClassifierTests
{
    private static readonly DateTime Day = new(2026, 10, 23, 8, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly DetectionOptions Defaults = new();

    private static MoveSegment MoveOf(IReadOnlyList<TrackPoint> points, bool isFlight = false)
        => new(points[0].TimeUtc, points[^1].TimeUtc, points, isFlight);

    /// <summary>A move straight east at a constant <paramref name="kmh"/>, logged every 10 s, with no motion and no speed.</summary>
    private static MoveSegment EastAt(double kmh, int count = 31)
        => MoveOf(Line(kmh, count));

    /// <summary><paramref name="count"/> points straight east of Home at a constant speed, 10 s apart.</summary>
    private static List<TrackPoint> Line(double kmh, int count, Func<int, string[]?>? motion = null)
    {
        var metersPerStep = kmh / 3.6 * Every10s.TotalSeconds;
        var points = new List<TrackPoint>(count);
        for (var k = 0; k < count; k++)
        {
            var at = Geo.Offset(Spots.Home, 0, k * metersPerStep);
            points.Add(new TrackPoint(Day + k * Every10s, "phone", at.Latitude, at.Longitude, null, null, motion?.Invoke(k)));
        }
        return points;
    }

    private static MoveSegment WithMotion(IReadOnlyList<TrackPoint> points, Func<int, string[]?> motion)
        => MoveOf([.. points.Select((p, k) => p with { Motion = motion(k) })]);

    // ---- speed ---------------------------------------------------------------------------------------------------

    [Theory]
    [InlineData(5, TravelMode.Walk)]
    [InlineData(15, TravelMode.Cycle)]
    [InlineData(50, TravelMode.Drive)]
    public void Speed_decides_mode_without_motion(double kmh, TravelMode expected)
    {
        var track = new TrackBuilder(Day, Spots.Home).Travel(Spots.Office, kmh, Every10s).Build();

        Assert.Equal(expected, ModeClassifier.Classify(MoveOf(track), Defaults));
    }

    [Fact] // 2 m/s = 7.2 km/h, 7 m/s = 25.2 km/h: the limits sit exactly on the speed, so a limit belongs to the faster mode
    public void Walk_and_cycle_limits_belong_to_the_faster_mode()
    {
        var o = new DetectionOptions { WalkMaxKmh = 2.0 * 3.6, CycleMaxKmh = 7.0 * 3.6 };

        Assert.Equal(TravelMode.Walk, ModeClassifier.Classify(WithSpeed(1.99), o));
        Assert.Equal(TravelMode.Cycle, ModeClassifier.Classify(WithSpeed(2.0), o));
        Assert.Equal(TravelMode.Cycle, ModeClassifier.Classify(WithSpeed(6.99), o));
        Assert.Equal(TravelMode.Drive, ModeClassifier.Classify(WithSpeed(7.0), o));
    }

    [Fact]
    public void Thresholds_come_from_the_options()
    {
        var move = EastAt(15);

        Assert.Equal(TravelMode.Cycle, ModeClassifier.Classify(move, Defaults));
        Assert.Equal(TravelMode.Walk, ModeClassifier.Classify(move, new DetectionOptions { WalkMaxKmh = 20 }));
        Assert.Equal(TravelMode.Drive, ModeClassifier.Classify(move, new DetectionOptions { CycleMaxKmh = 10 }));
    }

    private static MoveSegment WithSpeed(double mps)
        => MoveOf([.. Line(50, 5).Select(p => p with { SpeedMps = mps })]);

    [Fact]
    public void Reported_speed_is_used_in_preference_to_the_implied_one()
    {
        // The positions imply 5 km/h but every fix reports 15 km/h.
        var move = MoveOf([.. Line(5, 31).Select(p => p with { SpeedMps = 15 / 3.6 })]);

        Assert.Equal(TravelMode.Cycle, ModeClassifier.Classify(move, Defaults));
    }

    [Fact]
    public void Negative_speed_uses_implied_speed()
    {
        var move = MoveOf([.. Line(15, 31).Select(p => p with { SpeedMps = -1 })]);

        Assert.Equal(TravelMode.Cycle, ModeClassifier.Classify(move, Defaults));
    }

    [Fact]
    public void Missing_speed_on_some_points_uses_implied_speed_for_those()
    {
        // Positions imply 15 km/h. A reported speed of 0 is a valid sample, but the median stays with the 15 km/h majority.
        var move = MoveOf([.. Line(15, 31).Select((p, k) => k % 3 == 0 ? p with { SpeedMps = 0 } : p with { SpeedMps = k % 3 == 1 ? -1 : null })]);

        Assert.Equal(TravelMode.Cycle, ModeClassifier.Classify(move, Defaults));
    }

    [Fact] // a red light or a bus stop must not turn a drive into a walk
    public void Median_speed_ignores_a_few_slow_points()
    {
        var points = new TrackBuilder(Day, Spots.Home)
            .Travel(Geo.Offset(Spots.Home, 0, 4_000), 50, Every10s)
            .Stay(TimeSpan.FromMinutes(2), Every10s)
            .Travel(Geo.Offset(Spots.Home, 0, 8_000), 50, Every10s)
            .Build();

        Assert.Equal(TravelMode.Drive, ModeClassifier.Classify(MoveOf(points), Defaults));
    }

    [Fact] // no previous point, no reported speed: there is nothing to measure, and nothing says the person was fast
    public void A_move_without_any_usable_speed_is_a_walk()
    {
        Assert.Equal(TravelMode.Walk, ModeClassifier.Classify(MoveOf([Line(50, 1)[0]]), Defaults));
        Assert.Equal(TravelMode.Walk, ModeClassifier.Classify(new MoveSegment(Day, Day, [], false), Defaults));
    }

    [Fact] // two fixes with the same time imply no speed (not an infinite one)
    public void Fixes_with_equal_times_imply_no_speed()
    {
        var same = Line(50, 3).Select(p => p with { TimeUtc = Day }).ToList();

        Assert.Equal(TravelMode.Walk, ModeClassifier.Classify(MoveOf(same), Defaults));
    }

    // ---- motion --------------------------------------------------------------------------------------------------

    [Fact]
    public void Motion_beats_speed()
    {
        var track = new TrackBuilder(Day, Spots.Home).WithMotion("driving").Travel(Spots.Office, 15, Every10s).Build();

        Assert.Equal(TravelMode.Drive, ModeClassifier.Classify(MoveOf(track), Defaults));
    }

    [Fact]
    public void Unknown_motion_falls_back_to_speed()
    {
        var track = new TrackBuilder(Day, Spots.Home).WithMotion("stationary").Travel(Spots.Cafe, 5, Every10s).Build();

        Assert.Equal(TravelMode.Walk, ModeClassifier.Classify(MoveOf(track), Defaults));
    }

    [Theory] // each value maps regardless of the speed
    [InlineData("walking", 50, TravelMode.Walk)]
    [InlineData("running", 50, TravelMode.Walk)]
    [InlineData("cycling", 5, TravelMode.Cycle)]
    [InlineData("driving", 5, TravelMode.Drive)]
    [InlineData("automotive", 5, TravelMode.Drive)]
    [InlineData("AUTOMOTIVE", 5, TravelMode.Drive)]
    public void Motion_values_map_to_modes(string motion, double kmh, TravelMode expected)
        => Assert.Equal(expected, ModeClassifier.Classify(WithMotion(Line(kmh, 20), _ => [motion]), Defaults));

    [Fact]
    public void Motion_is_a_majority_vote_among_the_mapped_values()
    {
        // 15 km/h; 3 cycling vs 2 walking among the 5 points that carry motion, plus "stationary" noise on every point.
        string[]?[] motion = [["cycling", "stationary"], ["walking"], ["cycling"], ["stationary", "walking"], ["cycling"]];

        Assert.Equal(TravelMode.Cycle, ModeClassifier.Classify(WithMotion(Line(5, 5), k => motion[k]), Defaults));
    }

    [Fact]
    public void Several_mapped_values_on_one_point_each_vote()
    {
        // Walking and running are two votes for Walk against one for driving. A vote per point would tie, and 50 km/h would say Drive.
        string[]?[] motion = [["walking", "running"], ["driving"], ["stationary"]];

        Assert.Equal(TravelMode.Walk, ModeClassifier.Classify(WithMotion(Line(50, 3), k => motion[k]), Defaults));
    }

    [Theory] // a tie is no majority: the speed rule decides
    [InlineData(5, TravelMode.Walk)]
    [InlineData(15, TravelMode.Cycle)]
    [InlineData(50, TravelMode.Drive)]
    public void A_tied_motion_vote_falls_back_to_speed(double kmh, TravelMode expected)
    {
        var move = WithMotion(Line(kmh, 4), k => k % 2 == 0 ? ["walking"] : ["driving"]);

        Assert.Equal(expected, ModeClassifier.Classify(move, Defaults));
    }

    [Fact]
    public void Motion_needs_to_be_on_at_least_half_of_the_points()
    {
        // 10 points at 5 km/h. 5 of 10 carry "driving": exactly half is enough. 4 of 10 are not.
        Assert.Equal(TravelMode.Drive, ModeClassifier.Classify(MoveOf(Line(5, 10, k => k < 5 ? ["driving"] : null)), Defaults));
        Assert.Equal(TravelMode.Walk, ModeClassifier.Classify(MoveOf(Line(5, 10, k => k < 4 ? ["driving"] : null)), Defaults));
    }

    [Fact] // the first point of a TrackBuilder track never carries motion; that must not matter for a long move
    public void Motion_on_every_point_but_the_first_is_enough()
    {
        var track = new TrackBuilder(Day, Spots.Home).WithMotion("cycling").Travel(Spots.Office, 50, Every10s).Build();

        Assert.Null(track[0].Motion);
        Assert.Equal(TravelMode.Cycle, ModeClassifier.Classify(MoveOf(track), Defaults));
    }

    [Fact] // an empty array carries no motion information
    public void Empty_motion_arrays_do_not_count_as_carrying_motion()
    {
        Assert.Equal(TravelMode.Walk, ModeClassifier.Classify(MoveOf(Line(5, 10, _ => [])), Defaults));
        Assert.Equal(TravelMode.Walk, ModeClassifier.Classify(MoveOf(Line(5, 10, k => k < 4 ? ["driving"] : [])), Defaults));
        Assert.Equal(TravelMode.Drive, ModeClassifier.Classify(MoveOf(Line(5, 10, k => k < 5 ? ["driving"] : [])), Defaults));
    }

    // ---- flights and composition ---------------------------------------------------------------------------------

    [Fact]
    public void A_flight_is_a_flight_whatever_the_motion_and_speed()
    {
        var move = MoveOf(Line(5, 20, _ => ["walking"]), isFlight: true);

        Assert.Equal(TravelMode.Flight, ModeClassifier.Classify(move, Defaults));
    }

    [Fact]
    public void Segmented_commute_is_a_walk_then_a_ride()
    {
        // Same day as SegmenterTests: stay, walk at 5 km/h, stay, cycle at 18 km/h, stay.
        var track = new TrackBuilder(Day, Spots.Home)
            .Stay(TimeSpan.FromHours(1), TimeSpan.FromMinutes(2))
            .Travel(Spots.Cafe, 5, Every10s)
            .Stay(TimeSpan.FromMinutes(25), TimeSpan.FromMinutes(2))
            .Travel(Spots.Office, 18, Every10s)
            .Stay(TimeSpan.FromHours(8), TimeSpan.FromMinutes(2))
            .Build();

        var moves = Segmenter.Split(PointCleaner.Clean(track, Defaults), Defaults).OfType<MoveSegment>().ToList();

        Assert.Equal([TravelMode.Walk, TravelMode.Cycle], moves.Select(m => ModeClassifier.Classify(m, Defaults)));
    }

    // ---- distance ------------------------------------------------------------------------------------------------

    [Fact]
    public void Flight_distance_is_great_circle()
    {
        var track = new TrackBuilder(Day, Spots.Home).Travel(Spots.Lisbon, 800, TimeSpan.FromMinutes(10)).Build();
        var move = Assert.IsType<MoveSegment>(Assert.Single(Segmenter.Split(PointCleaner.Clean(track, Defaults), Defaults)));

        Assert.True(move.IsFlight);
        Assert.Equal(TravelMode.Flight, ModeClassifier.Classify(move, Defaults));
        Assert.InRange(ModeClassifier.DistanceMeters(move), 2_729_000, 2_749_000); // 2 738.8 km, plus or minus 10 km
    }

    [Fact]
    public void Flight_distance_ignores_the_route_flown()
    {
        // Home - Tokyo - Lisbon flown as one flight: the distance is Home - Lisbon, not the two long legs.
        var move = MoveOf(PointsAt(Spots.Home, Spots.Tokyo, Spots.Lisbon), isFlight: true);

        Assert.Equal(Geo.DistanceMeters(Spots.Home, Spots.Lisbon), ModeClassifier.DistanceMeters(move), 3);
    }

    [Fact]
    public void Route_distance_is_the_sum_of_the_consecutive_hops()
    {
        // 3 km east, then 4 km north: the route is 7 km, not the 5 km between the ends.
        var east = Geo.Offset(Spots.Home, 0, 3_000);
        var north = Geo.Offset(east, 4_000, 0);
        var move = MoveOf(PointsAt(Spots.Home, Geo.Offset(Spots.Home, 0, 1_000), east, north));

        Assert.Equal(7_000, ModeClassifier.DistanceMeters(move), 0);
    }

    [Fact]
    public void Route_distance_counts_going_back_and_forth()
    {
        var out1 = Geo.Offset(Spots.Home, 0, 1_000);
        var move = MoveOf(PointsAt(Spots.Home, out1, Spots.Home));

        Assert.Equal(2_000, ModeClassifier.DistanceMeters(move), 0);
    }

    [Fact]
    public void Distance_is_zero_without_two_points()
    {
        Assert.Equal(0, ModeClassifier.DistanceMeters(MoveOf(PointsAt(Spots.Home))));
        Assert.Equal(0, ModeClassifier.DistanceMeters(MoveOf(PointsAt(Spots.Home), isFlight: true)));
        Assert.Equal(0, ModeClassifier.DistanceMeters(new MoveSegment(Day, Day, [], false)));
        Assert.Equal(0, ModeClassifier.DistanceMeters(new MoveSegment(Day, Day, [], true)));
    }

    [Fact]
    public void Flight_across_the_antimeridian_is_the_short_way()
    {
        var east = new GeoPoint(0, 179.5);
        var west = new GeoPoint(0, -179.5);
        var move = MoveOf(PointsAt(east, west), isFlight: true);

        Assert.InRange(ModeClassifier.DistanceMeters(move), 110_000, 112_500); // about 1 degree of longitude at the equator
    }

    private static List<TrackPoint> PointsAt(params GeoPoint[] at)
        => [.. at.Select((p, k) => new TrackPoint(Day + k * TimeSpan.FromHours(1), "phone", p.Latitude, p.Longitude, null, null, null))];
}
