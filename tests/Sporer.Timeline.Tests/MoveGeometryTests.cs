using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class MoveGeometryTests
{
    private static readonly DateTime Day = new(2026, 11, 26, 8, 0, 0, DateTimeKind.Utc);
    private static readonly DetectionOptions Defaults = new();

    private static MoveSegment MoveThrough(bool isFlight, params GeoPoint[] at)
    {
        var points = at.Select((p, k) => new TrackPoint(Day + k * TimeSpan.FromMinutes(10), "phone", p.Latitude, p.Longitude, null, null, null)).ToList();
        return new MoveSegment(points[0].TimeUtc, points[^1].TimeUtc, points, isFlight);
    }

    /// <summary>300 km east, then 400 km north: 700 km of path, about 500 km between the ends.</summary>
    private static readonly GeoPoint[] Bend =
        [Spots.Home, Geo.Offset(Spots.Home, 0, 300_000), Geo.Offset(Geo.Offset(Spots.Home, 0, 300_000), 400_000, 0)];

    [Fact]
    public void A_flight_is_the_arc_between_its_ends()
    {
        var move = MoveThrough(isFlight: true, Bend);

        var line = MoveGeometry.Line(move, TravelMode.Flight);

        Assert.Equal(MoveGeometry.ArcPoints, line.Count);
        Assert.Equal(Geo.GreatCircle(Bend[0], Bend[^1]), line);
        Assert.Equal(Geo.DistanceMeters(Bend[0], Bend[^1]), MoveGeometry.DistanceMeters(move, TravelMode.Flight));
        var (detail, coarse) = MoveGeometry.Lines(move, TravelMode.Flight, Defaults);
        Assert.Equal(line, detail);
        Assert.Equal(line, coarse);
    }

    [Theory] // whatever the segmenter thought, every mode but flight goes by the path
    [InlineData(TravelMode.Train)]
    [InlineData(TravelMode.Bus)]
    [InlineData(TravelMode.Drive)]
    [InlineData(TravelMode.Walk)]
    public void Every_other_mode_is_the_path_and_the_sum_of_its_hops(TravelMode mode)
    {
        var move = MoveThrough(isFlight: true, Bend);

        Assert.Equal(Bend, MoveGeometry.Line(move, mode));
        Assert.Equal(Geo.DistanceMeters(Bend[0], Bend[1]) + Geo.DistanceMeters(Bend[1], Bend[2]), MoveGeometry.DistanceMeters(move, mode));
        var (detail, coarse) = MoveGeometry.Lines(move, mode, Defaults);
        Assert.Equal(Bend, detail); // a right angle survives any simplification
        Assert.Equal(Bend, coarse);
    }

    [Fact] // a move the owner calls a flight is drawn and measured as one, though the segmenter did not take it for one
    public void A_move_called_a_flight_is_drawn_as_one()
    {
        var move = MoveThrough(isFlight: false, Bend);

        Assert.Equal(MoveGeometry.ArcPoints, MoveGeometry.Line(move, TravelMode.Flight).Count);
        Assert.Equal(Geo.DistanceMeters(Bend[0], Bend[^1]), MoveGeometry.DistanceMeters(move, TravelMode.Flight));
    }

    [Fact]
    public void The_path_is_simplified_for_drawing()
    {
        var straight = Enumerable.Range(0, 11).Select(k => Geo.Offset(Spots.Home, 0, k * 100)).ToArray();
        var move = MoveThrough(isFlight: false, straight);

        var (detail, coarse) = MoveGeometry.Lines(move, TravelMode.Train, Defaults);

        Assert.Equal([straight[0], straight[^1]], detail);
        Assert.Equal([straight[0], straight[^1]], coarse);
        Assert.Equal(11, MoveGeometry.Line(move, TravelMode.Train).Count);
    }

    [Fact]
    public void Too_few_points_give_no_distance()
    {
        var one = MoveThrough(isFlight: true, Spots.Home);
        var none = new MoveSegment(Day, Day, [], false);

        Assert.Equal(0, MoveGeometry.DistanceMeters(one, TravelMode.Flight));
        Assert.Equal(0, MoveGeometry.DistanceMeters(one, TravelMode.Train));
        Assert.Equal(0, MoveGeometry.DistanceMeters(none, TravelMode.Flight));
        Assert.Empty(MoveGeometry.Line(none, TravelMode.Flight));
        Assert.Empty(MoveGeometry.Line(none, TravelMode.Train));
    }

    [Fact] // the old entry point still goes by IsFlight
    public void The_mode_classifier_s_distance_still_goes_by_the_segmenter_s_flag()
    {
        Assert.Equal(MoveGeometry.DistanceMeters(MoveThrough(true, Bend), TravelMode.Flight), ModeClassifier.DistanceMeters(MoveThrough(true, Bend)));
        Assert.Equal(MoveGeometry.DistanceMeters(MoveThrough(false, Bend), TravelMode.Drive), ModeClassifier.DistanceMeters(MoveThrough(false, Bend)));
    }
}
