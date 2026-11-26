using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class TransitClassifierTests
{
    private static readonly DateTime Day = new(2026, 11, 26, 8, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly DetectionOptions Defaults = new();

    /// <summary>The point <paramref name="meters"/> east of Home.</summary>
    private static GeoPoint East(double meters) => Geo.Offset(Spots.Home, 0, meters);

    private static GeoPoint North(GeoPoint p, double meters) => Geo.Offset(p, meters, 0);

    private static MoveSegment MoveOf(IReadOnlyList<TrackPoint> points, bool isFlight = false)
        => new(points[0].TimeUtc, points[^1].TimeUtc, points, isFlight);

    /// <summary>A drive (Overland says driving) from Home straight east, logged every 10 s.</summary>
    private static MoveSegment DriveEast(double meters, double kmh = 60, double? accuracy = null)
        => MoveOf(new TrackBuilder(Day, Spots.Home).WithAccuracy(accuracy).WithMotion("driving").Travel(East(meters), kmh, Every10s).Build());

    /// <summary>A railway (or bus route) beside the drive east of Home, <paramref name="north"/> metres to its north.</summary>
    private static GeoPoint[] BesideEast(double meters, double north = 10) => TransitMap.Along(Spots.Home, East(meters), north);

    /// <summary>
    /// A "flight" of <paramref name="hops"/> equal hops of <paramref name="hopMeters"/> along the great circle east of Home, hop k
    /// at <paramref name="kmh"/>(k).
    /// </summary>
    private static MoveSegment FlightEast(int hops, double hopMeters, Func<int, double> kmh)
    {
        var end = East(hops * hopMeters);
        var points = new List<TrackPoint>(hops + 1);
        var time = Day;
        for (var k = 0; k <= hops; k++)
        {
            if (k > 0)
                time += TimeSpan.FromSeconds(hopMeters / (kmh(k - 1) / 3.6));
            var at = Geo.Interpolate(Spots.Home, end, k / (double)hops);
            points.Add(new TrackPoint(time, "phone", at.Latitude, at.Longitude, null, null, null));
        }
        return MoveOf(points, isFlight: true);
    }

    private static TransitTile Rail(int lat, int lon) => new(TransitKind.Rail, lat, lon);

    private static TransitTile Bus(int lat, int lon) => new(TransitKind.Bus, lat, lon);

    // ---- a drive that follows a railway ----------------------------------------------------------------------------

    [Fact]
    public void A_drive_along_a_railway_is_a_train()
    {
        var map = new TransitMap().Rail(BesideEast(5_000));

        var result = TransitClassifier.Classify(DriveEast(5_000), Defaults, map);

        Assert.Equal(TravelMode.Train, result.Mode);
        Assert.Equal(TravelMode.Drive, result.BaseMode);
        Assert.Empty(result.Missing);
        Assert.True(result.RailShare > 0.99, $"rail share {result.RailShare}");
        Assert.Null(result.BusShare);
        Assert.DoesNotContain(map.Asked, t => t.Kind == TransitKind.Bus); // a train needs no bus routes
    }

    [Theory] // the railway runs beside the first 7.9 or 8 km of a 10 km drive; a point up to 28 m past its end is still within 30 m
    [InlineData(7_900, TravelMode.Bus, 0.79, 0.80)]
    [InlineData(8_000, TravelMode.Train, 0.80, 0.81)]
    public void A_drive_is_a_train_from_80_percent_of_its_path_on_a_railway(double railMeters, TravelMode expected, double shareFrom, double shareTo)
    {
        var map = new TransitMap().Rail(BesideEast(10_000).Take((int)(railMeters / 100) + 1).ToArray());

        var result = TransitClassifier.Classify(DriveEast(10_000), Defaults, map);

        Assert.InRange(result.RailShare!.Value, shareFrom, shareTo);
        Assert.Equal(expected, result.Mode);
    }

    [Fact]
    public void The_share_limit_is_inclusive_and_comes_from_the_options()
    {
        var map = new TransitMap().Rail(BesideEast(10_000).Take(81).ToArray());
        var move = DriveEast(10_000);
        var share = TransitClassifier.Classify(move, Defaults, map).RailShare!.Value;

        Assert.Equal(TravelMode.Train, TransitClassifier.Classify(move, new DetectionOptions { TransitMinShare = share }, map).Mode);
        Assert.Equal(TravelMode.Bus, TransitClassifier.Classify(move, new DetectionOptions { TransitMinShare = share + 1e-9 }, map).Mode);
        Assert.Equal(TravelMode.Train, TransitClassifier.Classify(move, new DetectionOptions { TransitMinShare = 0.5 }, new TransitMap().Rail(BesideEast(10_000).Take(61).ToArray())).Mode);
    }

    [Fact]
    public void A_train_ride_covers_at_least_1_km_of_railway()
    {
        // 1.15 km, with a railway beside its first 940 m: more than 80 % of it, but less than a kilometre.
        var move = DriveEast(1_150);
        var partly = new TransitMap().Rail(TransitMap.Along(Spots.Home, East(1_150), 10, stepMeters: 10).Take(95).ToArray());
        var wholly = new TransitMap().Rail(TransitMap.Along(Spots.Home, East(1_150), 10, stepMeters: 10));

        var short1 = TransitClassifier.Classify(move, Defaults, partly);
        Assert.True(short1.RailShare >= 0.8, $"rail share {short1.RailShare}");
        Assert.Equal(TravelMode.Bus, short1.Mode);
        Assert.Equal(TravelMode.Train, TransitClassifier.Classify(move, Defaults, wholly).Mode);
        Assert.Equal(TravelMode.Bus, TransitClassifier.Classify(move, new DetectionOptions { TrainMinDistanceKm = 1.2 }, wholly).Mode);
    }

    [Theory]
    [InlineData(990, TravelMode.Bus)]
    [InlineData(1_010, TravelMode.Train)]
    public void A_drive_shorter_than_1_km_is_never_a_train_and_asks_for_no_railway(double meters, TravelMode expected)
    {
        var map = new TransitMap().Rail(BesideEast(meters));

        var result = TransitClassifier.Classify(DriveEast(meters), Defaults, map);

        Assert.Equal(expected, result.Mode);
        if (expected == TravelMode.Bus)
            Assert.Empty(map.Asked);
    }

    // ---- a car beside a railway, and what "near" means -------------------------------------------------------------

    [Fact]
    public void A_car_on_a_road_60_m_from_a_railway_stays_a_drive_or_a_bus()
    {
        var nearby = new TransitMap().Rail(BesideEast(25_000, north: 60));

        var shortDrive = TransitClassifier.Classify(DriveEast(5_000), Defaults, nearby);
        var longDrive = TransitClassifier.Classify(DriveEast(25_000), Defaults, nearby);

        Assert.Equal(TravelMode.Bus, shortDrive.Mode); // shorter than 20 km: a bus by default
        Assert.Equal(0, shortDrive.RailShare);
        Assert.Equal(TravelMode.Drive, longDrive.Mode); // longer, and no bus route: a drive
        Assert.Equal(0, longDrive.RailShare);
        Assert.Equal(0, longDrive.BusShare);
        Assert.Empty(longDrive.Missing);
    }

    [Theory] // near is max(30 m, min(accuracy, 75 m)), the accuracy being the worse of a hop's two points
    [InlineData(60, null, TravelMode.Bus)] // no accuracy reported: 30 m
    [InlineData(40, 10.0, TravelMode.Bus)] // a good accuracy never narrows it below 30 m
    [InlineData(60, 65.0, TravelMode.Train)] // widened to 65 m
    [InlineData(70, 90.0, TravelMode.Train)] // widened to 75 m...
    [InlineData(80, 90.0, TravelMode.Bus)] // ...and no further
    public void A_poor_accuracy_widens_near_up_to_75_m(double railNorth, double? accuracy, TravelMode expected)
    {
        var map = new TransitMap().Rail(BesideEast(5_000, railNorth));

        Assert.Equal(expected, TransitClassifier.Classify(DriveEast(5_000, accuracy: accuracy), Defaults, map).Mode);
    }

    [Fact]
    public void The_worse_accuracy_of_a_hop_s_two_points_counts()
    {
        var map = new TransitMap().Rail(BesideEast(5_000, north: 60));
        var points = DriveEast(5_000).Points.Select((p, k) => p with { AccuracyMeters = k % 2 == 0 ? null : 65 }).ToList();

        Assert.Equal(TravelMode.Train, TransitClassifier.Classify(MoveOf(points), Defaults, map).Mode);
    }

    [Fact]
    public void The_near_distance_comes_from_the_options()
    {
        var map = new TransitMap().Rail(BesideEast(5_000, north: 45));

        Assert.Equal(TravelMode.Bus, TransitClassifier.Classify(DriveEast(5_000), Defaults, map).Mode);
        Assert.Equal(TravelMode.Train, TransitClassifier.Classify(DriveEast(5_000), new DetectionOptions { TransitNearMeters = 50 }, map).Mode);
    }

    // ---- buses -------------------------------------------------------------------------------------------------------

    [Fact]
    public void A_short_drive_that_is_not_a_train_is_a_bus()
    {
        var result = TransitClassifier.Classify(DriveEast(5_000), Defaults, new TransitMap());

        Assert.Equal(TravelMode.Bus, result.Mode);
        Assert.Empty(result.Missing);
        Assert.Null(result.BusShare); // no bus route is needed for that
    }

    [Theory]
    [InlineData(19_900, TravelMode.Bus)]
    [InlineData(20_100, TravelMode.Drive)]
    public void A_drive_of_20_km_or_more_is_a_bus_only_on_a_bus_route(double meters, TravelMode expected)
    {
        var result = TransitClassifier.Classify(DriveEast(meters), Defaults, new TransitMap());

        Assert.Equal(expected, result.Mode);
        Assert.Empty(result.Missing);
    }

    [Fact]
    public void A_long_drive_along_a_bus_route_is_a_bus()
    {
        var map = new TransitMap().Bus(BesideEast(30_000));

        var result = TransitClassifier.Classify(DriveEast(30_000), Defaults, map);

        Assert.Equal(TravelMode.Bus, result.Mode);
        Assert.Equal(0, result.RailShare);
        Assert.True(result.BusShare > 0.99, $"bus share {result.BusShare}");
    }

    [Fact]
    public void A_long_drive_partly_on_a_bus_route_stays_a_drive()
    {
        var map = new TransitMap().Bus(BesideEast(30_000).Take(151).ToArray()); // the first 15 km

        var result = TransitClassifier.Classify(DriveEast(30_000), Defaults, map);

        Assert.Equal(TravelMode.Drive, result.Mode);
        Assert.InRange(result.BusShare!.Value, 0.49, 0.52);
    }

    [Fact] // a 7 km hop with no fix between: on a railway a tunnel, which counts in full; a bus route has no tunnels
    public void A_tunnel_counts_for_a_railway_but_not_for_a_bus_route()
    {
        var points = new TrackBuilder(Day, Spots.Home).WithMotion("driving")
            .Travel(East(9_000), 60, Every10s)
            .Teleport(East(16_000), TimeSpan.FromMinutes(7))
            .Travel(East(25_000), 60, Every10s)
            .Build();
        GeoPoint[] line =
        [
            .. TransitMap.Along(Spots.Home, East(9_000), 10), North(East(9_000), 300), North(East(16_000), 300),
            .. TransitMap.Along(East(16_000), East(25_000), 10),
        ];

        var asRailway = TransitClassifier.Classify(MoveOf(points), Defaults, new TransitMap().Rail(line));
        var asBusRoute = TransitClassifier.Classify(MoveOf(points), Defaults, new TransitMap().Bus(line));

        Assert.Equal(TravelMode.Train, asRailway.Mode);
        Assert.True(asRailway.RailShare > 0.99, $"rail share {asRailway.RailShare}");
        Assert.Equal(TravelMode.Drive, asBusRoute.Mode);
        Assert.InRange(asBusRoute.BusShare!.Value, 0.70, 0.75);
    }

    // ---- tiles that are not cached -----------------------------------------------------------------------------------

    [Fact]
    public void Rail_tiles_not_cached_leave_a_drive_to_the_bus_rules_and_are_listed()
    {
        var map = new TransitMap().Rail(BesideEast(5_000)).NotCached(TransitKind.Rail);

        var result = TransitClassifier.Classify(DriveEast(5_000), Defaults, map);

        Assert.Equal(TravelMode.Bus, result.Mode);
        Assert.Equal([Rail(599, 107), Rail(599, 108)], result.Missing); // 10.75 to 10.84 east, 2 km from the nearest tile edge north or south
        Assert.Null(result.RailShare);
    }

    [Fact]
    public void One_tile_not_cached_holds_a_kind_back_and_only_that_tile_is_listed()
    {
        var map = new TransitMap().Rail(BesideEast(5_000)).NotCached(Rail(599, 108));

        var result = TransitClassifier.Classify(DriveEast(5_000), Defaults, map);

        Assert.Equal(TravelMode.Bus, result.Mode);
        Assert.Equal([Rail(599, 108)], result.Missing);
    }

    [Fact]
    public void A_cached_tile_with_no_lines_is_not_missing()
    {
        var cache = new TransitLineCache([new(Rail(599, 107), TransitLines.Empty), new(Rail(599, 108), TransitLines.Empty)]);

        var result = TransitClassifier.Classify(DriveEast(5_000), Defaults, cache);

        Assert.Equal(TravelMode.Bus, result.Mode);
        Assert.Empty(result.Missing);
        Assert.Equal(0, result.RailShare);
    }

    [Fact]
    public void A_long_drive_whose_rail_tiles_are_missing_stays_a_drive_and_asks_for_rail_tiles_only()
    {
        var map = new TransitMap().NotCached(TransitKind.Rail).NotCached(TransitKind.Bus);

        var result = TransitClassifier.Classify(DriveEast(25_000), Defaults, map);

        Assert.Equal(TravelMode.Drive, result.Mode);
        // 10.75 to 11.1986 east: the end is 77 m from the edge of tile 112, which is within 150 m of it.
        Assert.Equal([Rail(599, 107), Rail(599, 108), Rail(599, 109), Rail(599, 110), Rail(599, 111), Rail(599, 112)], result.Missing);
    }

    [Fact]
    public void A_long_drive_whose_rail_tiles_are_missing_still_uses_bus_tiles_that_are_cached()
    {
        var map = new TransitMap().Bus(BesideEast(25_000)).NotCached(TransitKind.Rail);

        var result = TransitClassifier.Classify(DriveEast(25_000), Defaults, map);

        Assert.Equal(TravelMode.Bus, result.Mode);
        Assert.All(result.Missing, t => Assert.Equal(TransitKind.Rail, t.Kind));
        Assert.Equal(6, result.Missing.Count);
    }

    [Fact]
    public void Bus_tiles_are_asked_for_once_the_railways_are_known_not_to_make_a_train()
    {
        var map = new TransitMap().NotCached(TransitKind.Bus);

        var result = TransitClassifier.Classify(DriveEast(25_000), Defaults, map);

        Assert.Equal(TravelMode.Drive, result.Mode);
        Assert.Equal(0, result.RailShare);
        Assert.Equal([Bus(599, 107), Bus(599, 108), Bus(599, 109), Bus(599, 110), Bus(599, 111), Bus(599, 112)], result.Missing);
    }

    [Fact]
    public void A_short_drive_asks_for_no_bus_tiles()
    {
        var map = new TransitMap().NotCached(TransitKind.Bus);

        var result = TransitClassifier.Classify(DriveEast(5_000), Defaults, map);

        Assert.Equal(TravelMode.Bus, result.Mode);
        Assert.Empty(result.Missing);
        Assert.DoesNotContain(map.Asked, t => t.Kind == TransitKind.Bus);
    }

    [Theory] // a drive along a parallel 100 m or 200 m south of the edge between tile rows 599 and 600
    [InlineData(100, true)]
    [InlineData(200, false)]
    public void Tiles_are_needed_within_150_m_of_the_path(double southOfEdge, bool needsNextRow)
    {
        var start = Geo.Offset(new GeoPoint(60.0, 10.75), -southOfEdge, 0);
        var points = new TrackBuilder(Day, start).WithMotion("driving").Travel(Geo.Offset(start, 0, 2_000), 60, Every10s).Build();

        var result = TransitClassifier.Classify(MoveOf(points), Defaults, new TransitMap().NotCached(TransitKind.Rail));

        Assert.Equal(needsNextRow, result.Missing.Contains(Rail(600, 107)));
        Assert.Contains(Rail(599, 107), result.Missing);
    }

    [Fact]
    public void The_tiles_near_a_move_are_every_tile_classifying_it_could_ask_for()
    {
        var move = DriveEast(25_000);
        var map = new TransitMap();

        TransitClassifier.Classify(move, Defaults, map);
        var rail = TransitClassifier.TilesNear(move, TransitKind.Rail, Defaults);
        var bus = TransitClassifier.TilesNear(move, TransitKind.Bus, Defaults);

        Assert.Equal([Rail(599, 107), Rail(599, 108), Rail(599, 109), Rail(599, 110), Rail(599, 111), Rail(599, 112)], rail);
        Assert.Equal(rail.Select(t => t with { Kind = TransitKind.Bus }), bus);
        Assert.Equal(rail.Concat(bus), map.Asked); // a long drive that is no train asks for both kinds, each tile once
    }

    // ---- a "flight" that is a fast train -----------------------------------------------------------------------------

    [Fact]
    public void A_fast_train_that_the_segmenter_takes_for_a_flight_is_a_train_drawn_and_measured_along_its_path()
    {
        // 100 km east then 50 km north at 250 km/h, logged every 10 s, between two stays: fast and long enough to be a "flight".
        var corner = East(100_000);
        var end = North(corner, 50_000);
        var track = new TrackBuilder(Day, Spots.Home)
            .Stay(TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(1))
            .Travel(corner, 250, Every10s)
            .Travel(end, 250, Every10s)
            .Stay(TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(1))
            .Build();
        var move = Assert.Single(Segmenter.Split(PointCleaner.Clean(track, Defaults), Defaults).OfType<MoveSegment>());
        var map = new TransitMap()
            .Rail(TransitMap.Along(Spots.Home, corner, northMeters: 10))
            .Rail(TransitMap.Along(corner, end, eastMeters: 10));

        var result = TransitClassifier.Classify(move, Defaults, map);

        Assert.True(move.IsFlight);
        Assert.Equal(TravelMode.Train, result.Mode);
        Assert.Equal(TravelMode.Flight, result.BaseMode);
        Assert.Empty(result.Missing);

        // Its line goes through its points and its distance adds up its hops (150 km), where a flight's is the arc (112 km).
        Assert.Equal(move.Points.Select(p => p.Position), MoveGeometry.Line(move, result.Mode));
        Assert.InRange(MoveGeometry.DistanceMeters(move, result.Mode), 149_900, 150_100);
        Assert.InRange(MoveGeometry.DistanceMeters(move, TravelMode.Flight), 111_000, 112_500);
        var (detail, coarse) = MoveGeometry.Lines(move, result.Mode, Defaults);
        Assert.Contains(detail, p => Geo.DistanceMeters(p, corner) < 1); // the turn is kept, which no arc would have
        Assert.Contains(coarse, p => Geo.DistanceMeters(p, corner) < 1);
    }

    [Fact]
    public void A_flight_logged_sparsely_stays_a_flight_and_asks_for_nothing()
    {
        var track = new TrackBuilder(Day, Spots.Home).Travel(Spots.Lisbon, 800, TimeSpan.FromMinutes(10)).Build();
        var move = Assert.IsType<MoveSegment>(Assert.Single(Segmenter.Split(PointCleaner.Clean(track, Defaults), Defaults)));
        var map = new TransitMap();

        var result = TransitClassifier.Classify(move, Defaults, map);

        Assert.Equal(TravelMode.Flight, result.Mode);
        Assert.Empty(result.Missing);
        Assert.Empty(map.Asked);
    }

    [Theory] // hops of 1 km along a railway: the 90th percentile of their speeds must be no faster than 350 km/h
    [InlineData(349, TravelMode.Train)]
    [InlineData(351, TravelMode.Flight)]
    public void A_flight_faster_than_a_train_stays_a_flight_even_along_a_railway(double kmh, TravelMode expected)
    {
        var map = new TransitMap().Rail(BesideEast(120_000));

        var result = TransitClassifier.Classify(FlightEast(120, 1_000, _ => kmh), Defaults, map);

        Assert.Equal(expected, result.Mode);
        if (expected == TravelMode.Flight)
            Assert.Empty(map.Asked);
    }

    [Theory] // 100 hops: 90 at 300 km/h and 10 at 400 put the 90th percentile at 300; one more fast hop puts it at 400
    [InlineData(90, TravelMode.Train)]
    [InlineData(89, TravelMode.Flight)]
    public void The_90th_percentile_of_the_hop_speeds_decides(int slowHops, TravelMode expected)
    {
        var map = new TransitMap().Rail(BesideEast(100_000));

        var result = TransitClassifier.Classify(FlightEast(100, 1_000, k => k < slowHops ? 300 : 400), Defaults, map);

        Assert.Equal(expected, result.Mode);
    }

    [Theory] // 50 hops, 51 points: ground travel up to 102 km of path
    [InlineData(2_020, TravelMode.Train)]
    [InlineData(2_060, TravelMode.Flight)]
    public void A_flight_with_less_than_one_point_per_2_km_is_not_ground_travel(double hopMeters, TravelMode expected)
    {
        var map = new TransitMap().Rail(BesideEast(50 * hopMeters));

        var result = TransitClassifier.Classify(FlightEast(50, hopMeters, _ => 300), Defaults, map);

        Assert.Equal(expected, result.Mode);
        if (expected == TravelMode.Flight)
            Assert.Empty(map.Asked);
    }

    [Fact]
    public void A_flight_like_ground_travel_but_off_any_railway_stays_a_flight()
    {
        var move = FlightEast(120, 1_000, _ => 300);

        var noRailway = TransitClassifier.Classify(move, Defaults, new TransitMap());
        var notCached = TransitClassifier.Classify(move, Defaults, new TransitMap().NotCached(TransitKind.Rail));

        Assert.Equal(TravelMode.Flight, noRailway.Mode);
        Assert.Equal(0, noRailway.RailShare);
        Assert.Empty(noRailway.Missing);
        Assert.Equal(TravelMode.Flight, notCached.Mode);
        Assert.NotEmpty(notCached.Missing);
        Assert.All(notCached.Missing, t => Assert.Equal(TransitKind.Rail, t.Kind));
    }

    // ---- a walk or a ride through a tunnel ---------------------------------------------------------------------------

    /// <summary>
    /// A walk of 200 m to a station, 3 km underground in 4 minutes (no fix), and a walk of 200 m from the other station; the
    /// metro line runs from 20 m north of one station to 20 m north of the other by way of a bend 400 m north.
    /// </summary>
    private static (MoveSegment Move, TransitMap Map) Metro(string motion = "walking")
    {
        var (s1, s2) = (East(200), East(3_200));
        var points = new TrackBuilder(Day, Spots.Home).WithMotion(motion)
            .Travel(s1, 5, Every10s)
            .Teleport(s2, TimeSpan.FromMinutes(4))
            .Travel(East(3_400), 5, Every10s)
            .Build();
        var map = new TransitMap().Rail([North(s1, 20), North(s1, 400), North(s2, 400), North(s2, 20)]);
        return (MoveOf(points), map);
    }

    [Theory]
    [InlineData("walking", TravelMode.Walk)]
    [InlineData("cycling", TravelMode.Cycle)]
    public void A_walk_or_a_ride_with_a_metro_ride_underground_is_a_train(string motion, TravelMode baseMode)
    {
        var (move, map) = Metro(motion);

        var result = TransitClassifier.Classify(move, Defaults, map);

        Assert.Equal(TravelMode.Train, result.Mode);
        Assert.Equal(baseMode, result.BaseMode);
        Assert.Empty(result.Missing);
        Assert.InRange(result.RailShare!.Value, 0.88, 0.92);
    }

    [Fact]
    public void A_walk_whose_tunnel_tiles_are_missing_stays_a_walk_and_lists_them()
    {
        var (move, map) = Metro();

        var result = TransitClassifier.Classify(move, Defaults, map.NotCached(TransitKind.Rail));

        Assert.Equal(TravelMode.Walk, result.Mode);
        Assert.Equal([Rail(599, 107), Rail(599, 108)], result.Missing);
    }

    [Fact]
    public void A_walk_beside_a_railway_with_no_tunnel_is_a_walk_and_asks_for_nothing()
    {
        var map = new TransitMap().Rail(BesideEast(2_000));
        var points = new TrackBuilder(Day, Spots.Home).WithMotion("walking").Travel(East(2_000), 5, Every10s).Build();

        var result = TransitClassifier.Classify(MoveOf(points), Defaults, map);

        Assert.Equal(TravelMode.Walk, result.Mode);
        Assert.Empty(map.Asked);
    }

    /// <summary>
    /// A walk of 100 m beside a railway to a station, a hop of <paramref name="tunnelMeters"/> in <paramref name="tunnelTime"/>
    /// to the next, and (unless <paramref name="walkAfter"/> is false) a walk of 100 m beside it again. Between the stations the
    /// railway bends 300 m north, so the straight line of the hop is nowhere near it; it comes back to
    /// <paramref name="secondEndNorth"/> metres north of the second station.
    /// </summary>
    private static (MoveSegment Move, TransitMap Map) Tunnel(double tunnelMeters, TimeSpan tunnelTime, double secondEndNorth = 10, bool walkAfter = true)
    {
        var (s1, s2, end) = (East(100), East(100 + tunnelMeters), East(200 + tunnelMeters));
        var builder = new TrackBuilder(Day, Spots.Home).WithMotion("walking").Travel(s1, 5, Every10s).Teleport(s2, tunnelTime);
        if (walkAfter)
            builder.Travel(end, 5, Every10s);
        GeoPoint[] line = [North(Spots.Home, 10), North(s1, 10), North(s1, 300), North(s2, 300), North(s2, secondEndNorth)];
        return (MoveOf(builder.Build()), new TransitMap().Rail(walkAfter ? [.. line, North(end, 10)] : line));
    }

    [Theory]
    [InlineData(499, TravelMode.Walk)]
    [InlineData(501, TravelMode.Train)]
    public void A_tunnel_hop_is_at_least_500_m(double meters, TravelMode expected)
    {
        var (move, map) = Tunnel(meters, TimeSpan.FromMinutes(1));

        var result = TransitClassifier.Classify(move, Defaults, map);

        Assert.Equal(expected, result.Mode);
        if (expected == TravelMode.Walk)
            Assert.Empty(map.Asked); // no hop could be a tunnel: the railways cannot change anything
        else
            Assert.True(result.RailShare > 0.99, $"rail share {result.RailShare}"); // the hop counts in full, though nowhere near the bend
    }

    [Theory] // the move ends at the second station, which is 149 m or 151 m from the railway
    [InlineData(149, TravelMode.Train)]
    [InlineData(151, TravelMode.Walk)]
    public void Both_ends_of_a_tunnel_hop_are_within_150_m_of_a_railway(double secondEndNorth, TravelMode expected)
    {
        var (move, map) = Tunnel(600, TimeSpan.FromMinutes(1), secondEndNorth, walkAfter: false);

        var result = TransitClassifier.Classify(move, Defaults, map);

        Assert.Equal(expected, result.Mode);
        Assert.Empty(result.Missing);
        if (expected == TravelMode.Walk)
            Assert.True(result.RailShare < 0.3, $"rail share {result.RailShare}");
    }

    [Theory] // 600 m: in 140 s that is 15.4 km/h, in 150 s 14.4 km/h, slower than any train
    [InlineData(140, TravelMode.Train)]
    [InlineData(150, TravelMode.Walk)]
    public void A_tunnel_hop_is_at_least_15_km_h(double seconds, TravelMode expected)
    {
        var (move, map) = Tunnel(600, TimeSpan.FromSeconds(seconds));

        Assert.Equal(expected, TransitClassifier.Classify(move, Defaults, map).Mode);
        Assert.Equal(expected == TravelMode.Walk, map.Asked.Count == 0);
    }

    [Theory]
    [InlineData(160, TravelMode.Walk)]
    [InlineData(140, TravelMode.Train)]
    public void Tunnel_hops_must_make_half_of_the_path(double secondRailwayStopsShort, TravelMode expected)
    {
        // 100 m on foot beside a railway, a 1 km tunnel (A), then a 2 km hop (B) beside another railway that stops short of B's
        // end. When it stops 160 m short, B is no tunnel: the 1 km of A is less than half of the 3.1 km path, though over 80 %
        // of the path is near a railway.
        var (s1, s2, end) = (East(100), East(1_100), East(3_100));
        var points = new TrackBuilder(Day, Spots.Home).WithMotion("walking")
            .Travel(s1, 5, Every10s)
            .Teleport(s2, TimeSpan.FromMinutes(2))
            .Teleport(end, TimeSpan.FromMinutes(4))
            .Build();
        var map = new TransitMap()
            .Rail([North(Spots.Home, 10), North(s1, 10), North(s1, 300), North(s2, 300), North(s2, 10)])
            .Rail([North(East(1_100 + secondRailwayStopsShort), 10), North(East(3_100 - secondRailwayStopsShort), 10)]);

        var result = TransitClassifier.Classify(MoveOf(points), Defaults, map);

        Assert.Equal(expected, result.Mode);
        Assert.True(result.RailShare >= 0.8, $"rail share {result.RailShare}");
    }

    // ---- other modes, and the options --------------------------------------------------------------------------------

    [Fact]
    public void The_search_reaches_as_far_as_the_widest_rule()
    {
        Assert.Equal(150, TransitClassifier.SearchMeters(Defaults));
        Assert.Equal(100, TransitClassifier.SearchMeters(new DetectionOptions { TunnelEndMeters = 100 }));
        Assert.Equal(75, TransitClassifier.SearchMeters(new DetectionOptions { TunnelEndMeters = 10 }));
        Assert.Equal(200, TransitClassifier.SearchMeters(new DetectionOptions { TransitNearMeters = 200 }));
    }

    [Fact]
    public void The_bus_and_train_thresholds_come_from_the_options()
    {
        var map = new TransitMap().Rail(BesideEast(5_000));

        Assert.Equal(TravelMode.Bus, TransitClassifier.Classify(DriveEast(5_000), new DetectionOptions { TrainMinDistanceKm = 6 }, map).Mode);
        Assert.Equal(TravelMode.Drive, TransitClassifier.Classify(DriveEast(5_000), new DetectionOptions { TrainMinDistanceKm = 6, BusMaxKm = 4 }, map).Mode);
        Assert.Equal(TravelMode.Flight, TransitClassifier.Classify(FlightEast(120, 1_000, _ => 300), new DetectionOptions { TrainMaxKmh = 250 }, new TransitMap().Rail(BesideEast(120_000))).Mode);
    }

    // ---- determinism ---------------------------------------------------------------------------------------------------

    [Fact]
    public void The_same_points_and_lines_give_the_same_answer_whatever_order_the_lines_come_in()
    {
        var move = DriveEast(25_000, accuracy: 20);
        GeoPoint[][] lines =
        [
            BesideEast(25_000, north: 25).Take(150).ToArray(),
            BesideEast(25_000, north: -40).Skip(120).ToArray(),
            [North(East(3_000), 500), North(East(9_000), -500)],
        ];
        var forwards = new TransitMap();
        foreach (var line in lines)
            forwards.Rail(line).Bus(line);
        var backwards = new TransitMap();
        foreach (var line in Enumerable.Reverse(lines))
            backwards.Bus([.. Enumerable.Reverse(line)]).Rail([.. Enumerable.Reverse(line)]);

        var first = TransitClassifier.Classify(move, Defaults, forwards);
        var again = TransitClassifier.Classify(move, Defaults, forwards);
        var reordered = TransitClassifier.Classify(move, Defaults, backwards);

        foreach (var other in new[] { again, reordered })
        {
            Assert.Equal(first.Mode, other.Mode);
            Assert.Equal(first.Missing, other.Missing);
            Assert.Equal(first.RailShare, other.RailShare);
            Assert.Equal(first.BusShare, other.BusShare);
        }
    }

    // ---- speed ---------------------------------------------------------------------------------------------------------

    [Fact] // a coarse guard, not a benchmark
    public void A_100_km_move_against_a_dense_network_is_classified_in_milliseconds()
    {
        // 100 km at 100 km/h logged every 5 s (720 hops, about 4,700 samples), beside a railway with 19 more running parallel to
        // it 100 m to 1 km away: 20 lines of 1,000 straight pieces each, in 19 tiles.
        var every5s = TimeSpan.FromSeconds(5);
        var end = East(100_000);
        var map = new TransitMap().Rail(TransitMap.Along(Spots.Home, end, 10));
        for (var k = 1; k <= 19; k++)
            map.Rail(TransitMap.Along(Spots.Home, end, k == 19 ? 1_000 : (k % 2 == 0 ? 1 : -1) * 100 * ((k + 1) / 2)));
        var build = System.Diagnostics.Stopwatch.StartNew();
        var tiles = map.Tiles(TransitKind.Rail); // the cache would hold these built
        build.Stop();

        var along = MoveOf(new TrackBuilder(Day, Spots.Home).WithMotion("driving").Travel(end, 100, every5s).Build());
        var beside = MoveOf(new TrackBuilder(Day, North(Spots.Home, 55)).WithMotion("driving").Travel(North(end, 55), 100, every5s).Build());

        var watch = System.Diagnostics.Stopwatch.StartNew();
        var train = TransitClassifier.Classify(along, Defaults, map);
        var first = watch.Elapsed;
        var drive = TransitClassifier.Classify(beside, Defaults, map);
        var second = watch.Elapsed - first;

        Assert.Equal(19, tiles.Count);
        Assert.Equal(TravelMode.Train, train.Mode);
        Assert.Equal(TravelMode.Drive, drive.Mode); // 45 m from the nearest line all the way, and no bus route
        TestContext.Current.TestOutputHelper?.WriteLine(
            $"Built 19 tiles in {build.Elapsed.TotalMilliseconds:F1} ms; classified a train in {first.TotalMilliseconds:F1} ms (cold) and a drive beside it in {second.TotalMilliseconds:F1} ms.");
        Assert.True(first < TimeSpan.FromMilliseconds(500), $"the train took {first.TotalMilliseconds:F0} ms");
        Assert.True(second < TimeSpan.FromMilliseconds(500), $"the drive took {second.TotalMilliseconds:F0} ms");
    }
}
