using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class TrainMergerTests
{
    private static readonly DateTime Day = new(2026, 11, 26, 8, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly DetectionOptions Defaults = new();

    private static TrackPoint PointAt(int minute, double metersEast)
    {
        var at = Geo.Offset(Spots.Home, 0, metersEast);
        return new TrackPoint(Day.AddMinutes(minute), "phone", at.Latitude, at.Longitude, null, null, null);
    }

    /// <summary>A move through the points at the given minutes (each 1 km further east), from the first one's time to the last one's.</summary>
    private static MoveSegment Move(bool isFlight, params int[] minutes)
    {
        var points = minutes.Select(m => PointAt(m, m * 1_000)).ToList();
        return new MoveSegment(points[0].TimeUtc, points[^1].TimeUtc, points, isFlight);
    }

    private static ModedSegment Train(MoveSegment move) => new(move, TravelMode.Train);

    [Fact]
    public void Two_train_moves_that_touch_are_one_ride_through_their_points_once_each()
    {
        // The segmenter gives both moves the point between them (minute 2).
        var first = Move(isFlight: true, 0, 1, 2);
        var second = Move(isFlight: false, 2, 3, 4);

        var merged = Assert.Single(TrainMerger.Merge([Train(first), Train(second)], Defaults));

        var move = Assert.IsType<MoveSegment>(merged.Segment);
        Assert.Equal(TravelMode.Train, merged.Mode);
        Assert.Equal(first.StartUtc, move.StartUtc);
        Assert.Equal(second.EndUtc, move.EndUtc);
        Assert.Equal([0, 1, 2, 3, 4], move.Points.Select(p => p.TimeUtc.Minute));
        Assert.False(move.IsFlight);
    }

    [Fact]
    public void A_run_of_three_trains_is_one_ride()
    {
        var merged = TrainMerger.Merge([Train(Move(true, 0, 1)), Train(Move(false, 1, 2)), Train(Move(true, 2, 3, 4))], Defaults);

        var move = Assert.IsType<MoveSegment>(Assert.Single(merged).Segment);
        Assert.Equal([0, 1, 2, 3, 4], move.Points.Select(p => p.TimeUtc.Minute));
    }

    [Fact]
    public void Moves_that_touch_without_sharing_a_point_keep_all_their_points()
    {
        // Same instant, different place: not the same fix, so both are kept.
        var first = Move(false, 0, 1, 2);
        var second = new MoveSegment(first.EndUtc, Day.AddMinutes(4), [PointAt(2, 2_500), PointAt(3, 3_000), PointAt(4, 4_000)], false);

        var move = Assert.IsType<MoveSegment>(Assert.Single(TrainMerger.Merge([Train(first), Train(second)], Defaults)).Segment);

        Assert.Equal(6, move.Points.Count);
    }

    [Fact]
    public void Trains_with_something_between_them_are_not_merged()
    {
        var stay = new StaySegment(Day.AddMinutes(2), Day.AddMinutes(10), Spots.Home, [PointAt(2, 2_000)]);
        ModedSegment[] stayBetween = [Train(Move(false, 0, 1, 2)), new(stay, null), Train(Move(false, 10, 11))];
        // A drive of 2 km: at least Detection:TrainMinDistanceKm, so not a moment where the train slowed down (see the tests below).
        ModedSegment[] driveBetween = [Train(Move(false, 0, 1)), new(Move(false, 1, 3), TravelMode.Drive), Train(Move(false, 3, 4))];
        var gap = new GapSegment(Day.AddMinutes(1), Day.AddMinutes(40), Spots.Home, Spots.Office);
        ModedSegment[] gapBetween = [Train(Move(false, 0, 1)), new(gap, null), Train(Move(false, 40, 41))];

        Assert.Equal(stayBetween, TrainMerger.Merge(stayBetween, Defaults));
        Assert.Equal(driveBetween, TrainMerger.Merge(driveBetween, Defaults));
        Assert.Equal(gapBetween, TrainMerger.Merge(gapBetween, Defaults));
    }

    [Fact]
    public void Trains_that_do_not_touch_and_other_modes_that_do_are_not_merged()
    {
        ModedSegment[] apart = [Train(Move(false, 0, 1)), Train(Move(false, 2, 3))];
        ModedSegment[] trainAndFlight = [Train(Move(false, 0, 1)), new(Move(true, 1, 2), TravelMode.Flight)];
        ModedSegment[] twoBuses = [new(Move(false, 0, 1), TravelMode.Bus), new(Move(false, 1, 2), TravelMode.Bus)];

        Assert.Equal(apart, TrainMerger.Merge(apart, Defaults));
        Assert.Equal(trainAndFlight, TrainMerger.Merge(trainAndFlight, Defaults));
        Assert.Equal(twoBuses, TrainMerger.Merge(twoBuses, Defaults));
        Assert.Empty(TrainMerger.Merge([], Defaults));
    }

    [Fact] // a fast train that slows down in the middle: the segmenter cuts it into flight, move, flight; each is a train, and they are one ride
    public void A_fast_train_cut_where_it_slowed_down_is_one_ride_again()
    {
        var a = Geo.Offset(Spots.Home, 0, 120_000);
        var b = Geo.Offset(a, 0, 10_000);
        var c = Geo.Offset(b, 0, 120_000);
        var track = new TrackBuilder(Day, Spots.Home)
            .Stay(TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(1))
            .Travel(a, 250, Every10s)
            .Travel(b, 120, Every10s)
            .Travel(c, 250, Every10s)
            .Stay(TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(1))
            .Build();
        var map = new TransitMap().Rail(TransitMap.Along(Spots.Home, a, 10)).Rail(TransitMap.Along(a, b, 10)).Rail(TransitMap.Along(b, c, 10));
        var segments = Segmenter.Split(PointCleaner.Clean(track, Defaults), Defaults);

        var moded = segments.Select(s => new ModedSegment(s, s is MoveSegment m ? TransitClassifier.Classify(m, Defaults, map).Mode : null)).ToList();
        var merged = TrainMerger.Merge(moded, Defaults);

        Assert.Equal([true, false, true], segments.OfType<MoveSegment>().Select(m => m.IsFlight));
        Assert.Equal([TravelMode.Train, TravelMode.Train, TravelMode.Train], moded.Where(s => s.Mode is not null).Select(s => s.Mode));
        Assert.Equal(3, merged.Count); // stay, train, stay
        var ride = Assert.IsType<MoveSegment>(merged[1].Segment);
        Assert.Equal(segments.OfType<MoveSegment>().Sum(m => m.Points.Count) - 2, ride.Points.Count);
        Assert.InRange(MoveGeometry.DistanceMeters(ride, TravelMode.Train), 249_900, 250_100);
    }

    /// <summary>A move through the given points (minute, metres east of home), from the first one's time to the last one's.</summary>
    private static MoveSegment Through(bool isFlight, params (int Minute, double MetersEast)[] points)
    {
        var track = points.Select(p => PointAt(p.Minute, p.MetersEast)).ToList();
        return new MoveSegment(track[0].TimeUtc, track[^1].TimeUtc, track, isFlight);
    }

    /// <summary>120 km of fast train, a stretch of <paramref name="dipMeters"/> from minute 30 to 31, and 120 km more.</summary>
    private static (MoveSegment Before, MoveSegment Dip, MoveSegment After) FastSlowFast(double dipMeters, bool dipIsFlight = false)
        => (Through(true, (0, 0), (29, 116_000), (30, 120_000)),
            Through(dipIsFlight, (30, 120_000), (31, 120_000 + dipMeters)),
            Through(true, (31, 120_000 + dipMeters), (59, 236_000 + dipMeters), (60, 240_000 + dipMeters)));

    [Fact] // the drive rule never makes a stretch this short a train, so it came out as a bus between two trains and cut the ride in two
    public void A_short_stretch_between_two_trains_that_touch_it_is_part_of_the_ride()
    {
        var (before, dip, after) = FastSlowFast(600);

        var merged = TrainMerger.Merge([Train(before), new(dip, TravelMode.Bus), Train(after)], Defaults);

        var ride = Assert.Single(merged);
        Assert.Equal((TravelMode.Train, false), (ride.Mode, ride.Edited));
        var move = Assert.IsType<MoveSegment>(ride.Segment);
        Assert.Equal((before.StartUtc, after.EndUtc, false), (move.StartUtc, move.EndUtc, move.IsFlight));
        Assert.Equal([0, 29, 30, 31, 59, 60], move.Points.Select(p => (int)(p.TimeUtc - Day).TotalMinutes)); // each boundary point once
        Assert.InRange(MoveGeometry.DistanceMeters(move, TravelMode.Train), 240_500, 240_700);

        // Whatever mode the stretch was given (a walk, for a stop in a station logged by speed only), and however often the ride slowed.
        var again = Through(false, (60, 240_600), (61, 240_900));
        var last = Through(true, (61, 240_900), (90, 360_900));
        ModedSegment[] slowedTwice = [Train(before), new(dip, TravelMode.Walk), Train(after), new(again, TravelMode.Cycle), Train(last)];
        var whole = Assert.IsType<MoveSegment>(Assert.Single(TrainMerger.Merge(slowedTwice, Defaults)).Segment);
        Assert.Equal((before.StartUtc, last.EndUtc), (whole.StartUtc, whole.EndUtc));
        Assert.Equal([0, 29, 30, 31, 59, 60, 61, 90], whole.Points.Select(p => (int)(p.TimeUtc - Day).TotalMinutes));
    }

    [Fact]
    public void A_stretch_of_a_ride_of_its_own_or_that_does_not_sit_between_two_trains_is_not_merged()
    {
        var (before, dip, after) = FastSlowFast(600);
        var (longBefore, longDip, longAfter) = FastSlowFast(1_500);
        var (flightBefore, flightDip, flightAfter) = FastSlowFast(600, dipIsFlight: true);
        var later = Through(true, (32, 121_000), (60, 240_600));

        ModedSegment[][] apart =
        [
            [Train(longBefore), new(longDip, TravelMode.Bus), Train(longAfter)], // 1.5 km: long enough to be a ride of its own
            [Train(flightBefore), new(flightDip, TravelMode.Flight), Train(flightAfter)], // a flight is no slow stretch
            [Train(before), new(dip, TravelMode.Bus), new(after, TravelMode.Flight)], // a train on one side only
            [new(before, TravelMode.Flight), new(dip, TravelMode.Bus), Train(after)], // the other way round
            [Train(before), new(dip, TravelMode.Bus), Train(later)], // the train after it starts a minute later
            [Train(before), new(dip, TravelMode.Bus)],
        ];
        foreach (var segments in apart)
            Assert.Equal(segments, TrainMerger.Merge(segments, Defaults));

        // The shortest train ride is a setting: with 2 km, 1.5 km is a moment where the train slowed down.
        var longer = new DetectionOptions { TrainMinDistanceKm = 2 };
        Assert.Single(TrainMerger.Merge([Train(longBefore), new(longDip, TravelMode.Bus), Train(longAfter)], longer));
    }

    [Fact] // the owner's mode stands, and a ride joined from a train the owner set is the owner's too
    public void A_stretch_whose_mode_the_owner_set_is_not_taken_into_the_ride()
    {
        var (before, dip, after) = FastSlowFast(600);

        ModedSegment[] ownersBus = [Train(before), new(dip, TravelMode.Bus, Edited: true), Train(after)];
        Assert.Equal(ownersBus, TrainMerger.Merge(ownersBus, Defaults));

        var ride = Assert.Single(TrainMerger.Merge([Train(before), new(dip, TravelMode.Bus), new(after, TravelMode.Train, Edited: true)], Defaults));
        Assert.Equal((TravelMode.Train, true), (ride.Mode, ride.Edited));
        var joined = Assert.Single(TrainMerger.Merge([new(before, TravelMode.Train, Edited: true), Train(Through(false, (30, 120_000), (60, 240_000)))], Defaults));
        Assert.True(joined.Edited);
    }

    /// <summary>
    /// 120 km at 250 km/h, 600 m at 190 km/h, and 120 km more at 250 km/h, beside a railway the whole way, logged every
    /// <paramref name="everySeconds"/>: a fast train that dipped under flight speed for a moment (a single noisy fix does the same).
    /// </summary>
    [Theory]
    [InlineData(10)]
    [InlineData(1)]
    public void A_fast_train_that_slowed_down_for_a_moment_is_one_ride(int everySeconds)
    {
        var every = TimeSpan.FromSeconds(everySeconds);
        var a = Geo.Offset(Spots.Home, 0, 120_000);
        var b = Geo.Offset(a, 0, 600);
        var c = Geo.Offset(b, 0, 120_000);
        var track = new TrackBuilder(Day, Spots.Home)
            .Stay(TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(1))
            .Travel(a, 250, every)
            .Travel(b, 190, every)
            .Travel(c, 250, every)
            .Stay(TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(1))
            .Build();
        var map = new TransitMap().Rail(TransitMap.Along(Spots.Home, a, 10)).Rail(TransitMap.Along(a, b, 10)).Rail(TransitMap.Along(b, c, 10));
        var segments = Segmenter.Split(PointCleaner.Clean(track, Defaults), Defaults);

        var moded = segments.Select(s => new ModedSegment(s, s is MoveSegment m ? TransitClassifier.Classify(m, Defaults, map).Mode : null)).ToList();
        var merged = TrainMerger.Merge(moded, Defaults);

        // The segmenter's pieces: two flights and the slow stretch between them, which on its own is a bus.
        Assert.Equal([true, false, true], segments.OfType<MoveSegment>().Select(m => m.IsFlight));
        Assert.Equal([TravelMode.Train, TravelMode.Bus, TravelMode.Train], moded.Where(s => s.Mode is not null).Select(s => s.Mode));
        Assert.Equal(3, merged.Count); // stay, train, stay
        Assert.Equal(TravelMode.Train, merged[1].Mode);
        var ride = Assert.IsType<MoveSegment>(merged[1].Segment);
        Assert.Equal(segments.OfType<MoveSegment>().Sum(m => m.Points.Count) - 2, ride.Points.Count);
        var pieces = segments.OfType<MoveSegment>().Sum(m => MoveGeometry.DistanceMeters(m, TravelMode.Train));
        Assert.Equal(pieces, MoveGeometry.DistanceMeters(ride, TravelMode.Train), 3);
        Assert.InRange(pieces, 240_300, 240_700); // logged every second, the first and last 100 m or so are part of the stays
    }
}
