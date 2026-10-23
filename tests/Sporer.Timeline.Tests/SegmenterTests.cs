using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class SegmenterTests
{
    private static readonly DateTime Day = new(2026, 10, 23, 0, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Every2min = TimeSpan.FromMinutes(2);

    private static DateTime T(int hour, int minute, int day = 0) => Day.AddDays(day).AddHours(hour).AddMinutes(minute);

    private static IReadOnlyList<Segment> Split(IReadOnlyList<TrackPoint> track, DetectionOptions? o = null)
    {
        o ??= new();
        return Segmenter.Split(PointCleaner.Clean(track, o), o);
    }

    private static string[] Kinds(IEnumerable<Segment> segs) => [.. segs.Select(s => s switch
    {
        StaySegment => "stay",
        MoveSegment { IsFlight: true } => "flight",
        MoveSegment => "move",
        GapSegment => "gap",
        _ => throw new InvalidOperationException($"Unexpected segment {s}"),
    })];

    private static void AssertContiguous(IReadOnlyList<Segment> segs)
    {
        for (var k = 0; k + 1 < segs.Count; k++)
            Assert.Equal(segs[k].EndUtc, segs[k + 1].StartUtc);
    }

    // Home 1 h (every 2 min) -> walk to the cafe at 5 km/h -> cafe 25 min -> cycle to the office at 18 km/h -> office 8 h
    private static List<TrackPoint> CommuteDay() => new TrackBuilder(T(7, 0), Spots.Home)
        .Stay(TimeSpan.FromHours(1), Every2min)
        .Travel(Spots.Cafe, 5, Every10s)
        .Stay(TimeSpan.FromMinutes(25), Every2min)
        .Travel(Spots.Office, 18, Every10s)
        .Stay(TimeSpan.FromHours(8), Every2min)
        .Build();

    [Fact]
    public void Commute_day_gives_stays_and_moves()
    {
        var segs = Split(CommuteDay());

        Assert.Equal(["stay", "move", "stay", "move", "stay"], Kinds(segs));
        Assert.True(Geo.DistanceMeters(((StaySegment)segs[2]).Centre, Spots.Cafe) < 30);
        Assert.True(Geo.DistanceMeters(((StaySegment)segs[0]).Centre, Spots.Home) < 30);
        Assert.True(Geo.DistanceMeters(((StaySegment)segs[4]).Centre, Spots.Office) < 30);
    }

    [Fact]
    public void Commute_day_stays_run_from_the_first_to_the_last_point_in_range()
    {
        var track = CommuteDay();

        var segs = Split(track);

        Assert.Equal(T(7, 0), segs[0].StartUtc);
        Assert.Equal(track[^1].TimeUtc, segs[4].EndUtc);
        Assert.All(segs.OfType<MoveSegment>(), m => Assert.False(m.IsFlight));
    }

    [Fact]
    public void Segments_are_contiguous()
    {
        var segs = Split(CommuteDay());

        Assert.Equal(5, segs.Count);
        AssertContiguous(segs);
        Assert.All(segs, s => Assert.True(s.EndUtc > s.StartUtc));
    }

    [Fact] // 3 min pause at a light
    public void Short_stop_under_five_minutes_is_not_a_stay()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Travel(Geo.Offset(Spots.Home, 0, 2_000), 36, Every10s)
            .Stay(TimeSpan.FromMinutes(3), Every10s)
            .Travel(Geo.Offset(Spots.Home, 0, 4_000), 36, Every10s)
            .Build();

        var segs = Split(track);

        Assert.Equal(["move"], Kinds(segs));
        Assert.Equal(track.Count, ((MoveSegment)segs[0]).Points.Count);
    }

    [Fact] // the threshold is inclusive: exactly Tmin is a stay
    public void Stay_of_exactly_five_minutes_counts()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5))
            .Travel(Geo.Offset(Spots.Home, 0, 2_000), 72, Every10s)
            .Build();

        var segs = Split(track);

        Assert.Equal(["stay", "move"], Kinds(segs));
        Assert.Equal(T(8, 0), segs[0].StartUtc);
        Assert.Equal(T(8, 5), segs[0].EndUtc);
    }

    [Fact]
    public void Stay_of_a_second_under_five_minutes_does_not_count()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromSeconds(299), TimeSpan.FromSeconds(299))
            .Travel(Geo.Offset(Spots.Home, 0, 2_000), 72, Every10s)
            .Build();

        Assert.Equal(["move"], Kinds(Split(track)));
    }

    [Fact]
    public void Honours_a_configured_stay_duration()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromMinutes(3), TimeSpan.FromSeconds(30))
            .Travel(Geo.Offset(Spots.Home, 0, 2_000), 72, Every10s)
            .Build();

        Assert.Equal(["move"], Kinds(Split(track)));
        Assert.Equal(["stay", "move"], Kinds(Split(track, new() { StayMinDuration = TimeSpan.FromMinutes(3) })));
    }

    [Fact] // home point 22:00, silence 9 h, next point 07:05 at 300 m away, then walking
    public void Silent_night_at_home_is_one_stay()
    {
        var track = new TrackBuilder(T(22, 0), Spots.Home)
            .Silence(TimeSpan.FromHours(9))
            .Teleport(Geo.Offset(Spots.Home, 300, 0), TimeSpan.FromMinutes(5))
            .Travel(Geo.Offset(Spots.Home, 1_000, 0), 5, Every10s)
            .Build();

        var segs = Split(track);

        var s = (StaySegment)segs[0];
        Assert.Equal(T(22, 0), s.StartUtc);
        Assert.Equal(T(7, 5, day: 1) - TimeSpan.FromSeconds(300 / 1.4), s.EndUtc, TimeSpan.FromSeconds(5));
        Assert.Single(s.Points);
    }

    [Fact] // the 9 h are the stay; only the walk after it is left over, and that is a move, not a "gap"
    public void Silent_night_at_home_leaves_the_walk_as_a_move()
    {
        var track = new TrackBuilder(T(22, 0), Spots.Home)
            .Silence(TimeSpan.FromHours(9))
            .Teleport(Geo.Offset(Spots.Home, 300, 0), TimeSpan.FromMinutes(5))
            .Travel(Geo.Offset(Spots.Home, 1_000, 0), 5, Every10s)
            .Build();

        var segs = Split(track);

        Assert.Equal(["stay", "move"], Kinds(segs));
        AssertContiguous(segs);
        Assert.Equal(track[^1].TimeUtc, segs[1].EndUtc);
    }

    [Fact] // 2 min at 130 m then back, inside a 2 h stay
    public void Gps_drift_out_and_back_keeps_one_stay()
    {
        var drift = Geo.Offset(Spots.Home, 0, 130);
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromHours(1), TimeSpan.FromMinutes(1))
            .Teleport(drift, Every10s)
            .Stay(TimeSpan.FromMinutes(2), Every10s)
            .Teleport(Spots.Home, Every10s)
            .Stay(TimeSpan.FromHours(1), TimeSpan.FromMinutes(1))
            .Build();

        var segs = Split(track);

        Assert.Equal(["stay"], Kinds(segs));
        var stay = (StaySegment)segs[0];
        Assert.Equal(T(8, 0), stay.StartUtc);
        Assert.Equal(track[^1].TimeUtc, stay.EndUtc);
        // the drift points are discarded, so the centre is the real place
        Assert.Equal(track.Count - 13, stay.Points.Count); // 1 teleport + 12 logged points
        Assert.All(stay.Points, p => Assert.True(Geo.DistanceMeters(p.Position, Spots.Home) < 1));
        Assert.True(Geo.DistanceMeters(stay.Centre, Spots.Home) < 1);
    }

    [Fact]
    public void Return_trip_longer_than_five_minutes_is_not_merged_into_one_stay()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromHours(1), TimeSpan.FromMinutes(1))
            .Travel(Geo.Offset(Spots.Home, 0, 500), 5, Every10s)
            .Travel(Spots.Home, 5, Every10s)
            .Stay(TimeSpan.FromHours(1), TimeSpan.FromMinutes(1))
            .Build();

        var segs = Split(track);

        Assert.Equal(["stay", "move", "stay"], Kinds(segs));
        AssertContiguous(segs);
    }

    [Fact]
    public void Stays_further_apart_than_the_radius_are_not_merged()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromHours(1), TimeSpan.FromMinutes(1))
            .Teleport(Geo.Offset(Spots.Home, 0, 300), TimeSpan.FromMinutes(2))
            .Stay(TimeSpan.FromHours(1), TimeSpan.FromMinutes(1))
            .Build();

        var segs = Split(track);

        Assert.Equal(["stay", "move", "stay"], Kinds(segs));
        AssertContiguous(segs);
        Assert.Equal(2, ((MoveSegment)segs[1]).Points.Count);
    }

    [Fact] // move, Teleport 40 km after 2 h, move
    public void Phone_off_while_travelling_is_a_gap()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Travel(Geo.Offset(Spots.Home, 0, 5_000), 50, Every10s)
            .Teleport(Geo.Offset(Spots.Home, 0, 45_000), TimeSpan.FromHours(2))
            .Travel(Geo.Offset(Spots.Home, 0, 50_000), 50, Every10s)
            .Build();

        var segs = Split(track);

        Assert.Equal(["move", "gap", "move"], Kinds(segs));
        AssertContiguous(segs);
        var gap = (GapSegment)segs[1];
        Assert.Equal(TimeSpan.FromHours(2), gap.EndUtc - gap.StartUtc);
        Assert.True(Geo.DistanceMeters(gap.From, Geo.Offset(Spots.Home, 0, 5_000)) < 1);
        Assert.True(Geo.DistanceMeters(gap.To, Geo.Offset(Spots.Home, 0, 45_000)) < 1);
        Assert.Equal(T(8, 0), segs[0].StartUtc);
        Assert.Equal(track[^1].TimeUtc, segs[2].EndUtc);
    }

    [Fact] // the pause ends at the next stay: the gap runs up to the stay's first point
    public void Gap_before_a_stay_ends_where_the_stay_starts()
    {
        var far = Geo.Offset(Spots.Home, 0, 42_000); // 40 km from where the phone went quiet, so not a silent stay
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromHours(1), TimeSpan.FromMinutes(2))
            .Travel(Geo.Offset(Spots.Home, 0, 2_000), 50, Every10s)
            .Teleport(far, TimeSpan.FromHours(2))
            .Stay(TimeSpan.FromHours(1), TimeSpan.FromMinutes(2))
            .Build();

        var segs = Split(track);

        Assert.Equal(["stay", "move", "gap", "stay"], Kinds(segs));
        AssertContiguous(segs);
        var arrival = track.First(p => Geo.DistanceMeters(p.Position, far) < 1).TimeUtc;
        Assert.Equal(arrival, segs[2].EndUtc);
        Assert.Equal(arrival, segs[3].StartUtc);
    }

    [Fact] // Home stay, Teleport to Lisbon after 4 h (about 685 km/h), Lisbon stay
    public void Flight_between_stays()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromHours(1), Every2min)
            .Teleport(Spots.Lisbon, TimeSpan.FromHours(4))
            .Stay(TimeSpan.FromHours(1), Every2min)
            .Build();

        var segs = Split(track);

        Assert.Equal(["stay", "flight", "stay"], Kinds(segs));
        AssertContiguous(segs);
        var flight = (MoveSegment)segs[1];
        Assert.Equal(T(9, 0), flight.StartUtc);
        Assert.Equal(T(13, 0), flight.EndUtc);
        Assert.Equal(2, flight.Points.Count);
    }

    [Fact] // 20 km at 250 km/h inside a drive
    public void High_speed_train_burst_is_not_a_flight()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromMinutes(10), Every2min)
            .Travel(Geo.Offset(Spots.Home, 0, 5_000), 50, Every10s)
            .Travel(Geo.Offset(Spots.Home, 0, 25_000), 250, Every10s)
            .Travel(Geo.Offset(Spots.Home, 0, 30_000), 50, Every10s)
            .Stay(TimeSpan.FromMinutes(10), Every2min)
            .Build();

        var segs = Split(track);

        Assert.Equal(["stay", "move", "stay"], Kinds(segs));
        Assert.DoesNotContain(segs.OfType<MoveSegment>(), m => m.IsFlight);
    }

    [Fact]
    public void Honours_a_configured_flight_distance()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromMinutes(10), Every2min)
            .Travel(Geo.Offset(Spots.Home, 0, 25_000), 250, Every10s)
            .Stay(TimeSpan.FromMinutes(10), Every2min)
            .Build();

        Assert.Equal(["stay", "move", "stay"], Kinds(Split(track)));
        Assert.Equal(["stay", "flight", "stay"], Kinds(Split(track, new() { FlightMinDistanceKm = 20 })));
    }

    [Fact] // a flight with logged points on the way is still one flight, and the walk to and from it stays moves
    public void Flight_with_points_along_the_way_is_one_flight()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromHours(1), Every2min)
            .Travel(Geo.Offset(Spots.Home, 0, 3_000), 5, Every10s)
            .Travel(Spots.Lisbon, 800, TimeSpan.FromMinutes(10))
            .Stay(TimeSpan.FromHours(1), Every2min)
            .Build();

        var segs = Split(track);

        Assert.Equal(["stay", "move", "flight", "stay"], Kinds(segs));
        AssertContiguous(segs);
        Assert.True(((MoveSegment)segs[2]).Points.Count > 10);
    }

    [Fact] // two stays with nothing logged between them still get a move, so no two stays touch
    public void Adjacent_stays_get_a_move_between_them()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Stay(TimeSpan.FromHours(1), Every2min)
            .Teleport(Geo.Offset(Spots.Home, 0, 1_000), TimeSpan.FromMinutes(3))
            .Stay(TimeSpan.FromHours(1), Every2min)
            .Build();

        var segs = Split(track);

        Assert.Equal(["stay", "move", "stay"], Kinds(segs));
        AssertContiguous(segs);
    }

    [Fact]
    public void Leading_and_trailing_moves_run_to_the_ends_of_the_track()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Travel(Geo.Offset(Spots.Home, 0, 3_000), 36, Every10s)
            .Stay(TimeSpan.FromMinutes(20), Every2min)
            .Travel(Geo.Offset(Spots.Home, 0, 6_000), 36, Every10s)
            .Build();

        var segs = Split(track);

        Assert.Equal(["move", "stay", "move"], Kinds(segs));
        AssertContiguous(segs);
        Assert.Equal(track[0].TimeUtc, segs[0].StartUtc);
        Assert.Equal(track[^1].TimeUtc, segs[2].EndUtc);
        Assert.Equal(track[0], ((MoveSegment)segs[0]).Points[0]);
        Assert.Equal(track[^1], ((MoveSegment)segs[2]).Points[^1]);
    }

    [Fact]
    public void A_track_that_is_all_stay_is_one_stay()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home).Stay(TimeSpan.FromHours(3), Every2min).Build();

        var segs = Split(track);

        var stay = Assert.IsType<StaySegment>(Assert.Single(segs));
        Assert.Equal(T(8, 0), stay.StartUtc);
        Assert.Equal(T(11, 0), stay.EndUtc);
        Assert.Equal(track.Count, stay.Points.Count);
        Assert.True(Geo.DistanceMeters(stay.Centre, Spots.Home) < 1);
    }

    [Fact]
    public void A_track_that_is_all_move_is_one_move()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Travel(Geo.Offset(Spots.Home, 0, 10_000), 36, Every10s)
            .Build();

        var segs = Split(track);

        var move = Assert.IsType<MoveSegment>(Assert.Single(segs));
        Assert.False(move.IsFlight);
        Assert.Equal(track.Count, move.Points.Count);
        Assert.Equal(track[0].TimeUtc, move.StartUtc);
        Assert.Equal(track[^1].TimeUtc, move.EndUtc);
    }

    [Fact]
    public void Empty_and_single_point_tracks_have_no_segments()
    {
        Assert.Empty(Segmenter.Split([], new()));
        Assert.Empty(Split(new TrackBuilder(T(8, 0), Spots.Home).Build()));
    }

    [Fact]
    public void Two_points_far_apart_make_one_move()
    {
        var track = new TrackBuilder(T(8, 0), Spots.Home)
            .Teleport(Geo.Offset(Spots.Home, 0, 1_000), TimeSpan.FromMinutes(2))
            .Build();

        var segs = Split(track);

        var move = Assert.IsType<MoveSegment>(Assert.Single(segs));
        Assert.Equal(2, move.Points.Count);
    }

    [Fact] // the mean of longitudes just either side of +/-180 is not 0
    public void Stay_centre_is_right_across_the_antimeridian()
    {
        var east = new GeoPoint(0, 179.9999);
        var west = new GeoPoint(0, -179.9999);
        var track = Enumerable.Range(0, 31)
            .Select(k => (k, at: k % 2 == 0 ? east : west))
            .Select(x => new TrackPoint(T(8, 0).AddMinutes(2 * x.k), "phone", x.at.Latitude, x.at.Longitude, null, null, null))
            .ToList();

        var segs = Split(track);

        var stay = Assert.IsType<StaySegment>(Assert.Single(segs));
        Assert.Equal(31, stay.Points.Count);
        Assert.True(Geo.DistanceMeters(stay.Centre, new GeoPoint(0, 180)) < 15);
    }
}
