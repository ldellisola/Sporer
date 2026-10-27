using Sporer.SyntheticData;
using Sporer.Timeline;

namespace Sporer.SyntheticData.Tests;

public class SimulatorTests
{
    // Four months: long enough for all three trips (the last, 24 nights, starts about day 88), the house move and the phone-off gaps.
    private static readonly SimulatorOptions Options =
        new(new DateOnly(2024, 6, 1), new DateOnly(2024, 9, 30), TimeSpan.FromSeconds(10), Seed: 42);

    private static readonly Lazy<List<Fix>> History = new(() => Generate(Options));

    private static List<Fix> Generate(SimulatorOptions options)
    {
        var fixes = new List<Fix>();
        Simulator.Run(options, fixes.Add);
        return fixes;
    }

    private static GeoPoint Position(Fix fix) => new(fix.Latitude, fix.Longitude);

    private static double Hours(Fix from, Fix to) => (to.TimeUtc - from.TimeUtc).TotalHours;

    [Fact]
    public void The_same_options_give_the_same_points()
    {
        var again = Generate(Options);

        Assert.Equal(History.Value.Count, again.Count);
        Assert.True(History.Value.SequenceEqual(again, FixComparer.Instance));
    }

    [Fact]
    public void Another_seed_gives_another_history()
    {
        var other = Generate(Options with { Seed = 43 });

        Assert.False(History.Value.SequenceEqual(other, FixComparer.Instance));
    }

    [Fact]
    public void Points_are_in_strictly_increasing_time_order_within_the_range()
    {
        var fixes = History.Value;

        Assert.True(fixes.Count > 10_000);
        for (var i = 1; i < fixes.Count; i++)
            Assert.True(fixes[i].TimeUtc > fixes[i - 1].TimeUtc, $"fix {i} is not after the one before it");
        Assert.True(fixes[0].TimeUtc >= new DateTime(2024, 5, 31, 22, 0, 0, DateTimeKind.Utc));
        Assert.True(fixes[^1].TimeUtc < new DateTime(2024, 9, 30, 22, 0, 0, DateTimeKind.Utc));
        Assert.All(fixes, f => Assert.Equal(DateTimeKind.Utc, f.TimeUtc.Kind));
    }

    [Fact]
    public void Accuracy_and_motion_are_filled_for_the_last_90_days_only()
    {
        var fixes = History.Value;
        var from = new DateTime(2024, 10, 1, 0, 0, 0, DateTimeKind.Utc) - TimeSpan.FromDays(90) - TimeSpan.FromHours(2); // local midnight after the last day, less 90 days (give or take the zone)

        var recent = fixes.Where(f => f.TimeUtc >= from.AddHours(4)).ToList();
        var older = fixes.Where(f => f.TimeUtc < from.AddHours(-4)).ToList();

        Assert.NotEmpty(recent);
        Assert.NotEmpty(older);
        Assert.All(recent, f => Assert.NotNull(f.Accuracy));
        Assert.All(recent, f => Assert.NotEmpty(f.Motion!));
        Assert.All(older, f => Assert.Null(f.Accuracy));
        Assert.All(older, f => Assert.Null(f.Motion));
    }

    [Fact]
    public void Stationary_logging_is_sparse()
    {
        var fixes = History.Value;

        // One point on arrival, then silence: hours go by between two fixes at the same place.
        var silences = Enumerable.Range(1, fixes.Count - 1)
            .Count(i => Hours(fixes[i - 1], fixes[i]) >= 4 && Geo.DistanceMeters(Position(fixes[i - 1]), Position(fixes[i])) < 100);
        Assert.True(silences >= 50, $"only {silences} long silences at one place");
    }

    [Fact]
    public void Flights_cross_hundreds_of_kilometres_at_jet_speed()
    {
        var fixes = History.Value;

        var hops = Enumerable.Range(1, fixes.Count - 1).Where(i =>
        {
            var metres = Geo.DistanceMeters(Position(fixes[i - 1]), Position(fixes[i]));
            return metres >= 100_000 && metres / (fixes[i].TimeUtc - fixes[i - 1].TimeUtc).TotalSeconds * 3.6 >= 200;
        }).ToList();

        // Three trips, out and back: at least one fast hop each way (more where the phone logs in the air).
        Assert.True(hops.Count >= 6, $"{hops.Count} flight hops");
    }

    [Fact]
    public void There_are_trips_across_time_zones_and_one_of_more_than_three_weeks()
    {
        var fixes = History.Value;

        var zones = fixes.Select(f => LocalTime.TimeZoneAt(Position(f))).Distinct().ToList();
        Assert.Contains("Europe/Oslo", zones);
        Assert.Contains("Europe/Lisbon", zones);
        Assert.Contains("Asia/Tokyo", zones);

        var tokyo = fixes.Where(f => LocalTime.TimeZoneAt(Position(f)) == "Asia/Tokyo").ToList();
        Assert.True((tokyo[^1].TimeUtc - tokyo[0].TimeUtc).TotalDays >= 21);
    }

    [Fact]
    public void The_person_moves_house_once()
    {
        var fixes = History.Value;

        // Home is where the long silences of the night are. Before the move and after it they are in two places.
        GeoPoint Home(IEnumerable<Fix> within)
        {
            var list = within.ToList();
            var night = Enumerable.Range(1, list.Count - 1).Where(i => Hours(list[i - 1], list[i]) >= 6).Select(i => Position(list[i])).ToList();
            return night.GroupBy(p => (Math.Round(p.Latitude, 2), Math.Round(p.Longitude, 2))).OrderByDescending(g => g.Count()).First().First();
        }

        var before = Home(fixes.Where(f => f.TimeUtc < fixes[0].TimeUtc.AddDays(30)));
        var after = Home(fixes.Where(f => f.TimeUtc > fixes[^1].TimeUtc.AddDays(-30)));
        Assert.True(Geo.DistanceMeters(before, after) > 5_000);
    }

    [Fact]
    public void Some_fixes_are_spikes()
    {
        var fixes = History.Value;

        // A spike: a fix over a kilometre from the one before and the one after, which are close to each other.
        var spikes = Enumerable.Range(1, fixes.Count - 2).Count(i =>
            Geo.DistanceMeters(Position(fixes[i - 1]), Position(fixes[i])) > 1_000
            && Geo.DistanceMeters(Position(fixes[i]), Position(fixes[i + 1])) > 1_000
            && Geo.DistanceMeters(Position(fixes[i - 1]), Position(fixes[i + 1])) < 200
            && Hours(fixes[i - 1], fixes[i + 1]) < 0.01);
        Assert.True(spikes >= 1, "no spikes");
    }

    [Fact]
    public void The_detection_finds_stays_moves_of_every_mode_flights_and_gaps_in_it()
    {
        var options = new DetectionOptions();
        var points = History.Value
            .Select(f => new TrackPoint(f.TimeUtc, "phone", f.Latitude, f.Longitude, f.Speed, f.Accuracy, f.Motion))
            .ToList();

        var segments = Segmenter.Split(PointCleaner.Clean(points, options), options);

        var moves = segments.OfType<MoveSegment>().ToList();
        var modes = moves.Select(m => ModeClassifier.Classify(m, options)).ToHashSet();
        Assert.Contains(TravelMode.Walk, modes);
        Assert.Contains(TravelMode.Cycle, modes);
        Assert.Contains(TravelMode.Drive, modes);
        Assert.Contains(TravelMode.Flight, modes);
        Assert.Equal(6, moves.Count(m => m.IsFlight)); // out and back, three times
        Assert.True(segments.OfType<StaySegment>().Count() > 300);
        Assert.NotEmpty(segments.OfType<GapSegment>()); // the phone is off while the person is on the move
    }

    // The centre of the simulated city, and the hotels of the three trips: where the simulator puts them, copied here so that the
    // test does not look at the simulator's own state.
    private static readonly GeoPoint City = new(59.9100, 10.7500);

    private static readonly Dictionary<string, (GeoPoint Hotel, string Zone)> Destinations = new()
    {
        ["north"] = (new GeoPoint(69.6496, 18.9560), "Europe/Oslo"),
        ["lisbon"] = (new GeoPoint(38.7139, -9.1394), "Europe/Lisbon"),
        ["tokyo"] = (new GeoPoint(35.6586, 139.7454), "Asia/Tokyo"),
    };

    private static DateOnly LocalDate(DateTime utc, string zone)
        => DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(utc, TimeZoneInfo.FindSystemTimeZoneById(zone)));

    /// <summary>How many times the track goes from within 300 km of the city to further away than that: once for each trip.</summary>
    private static int Departures(IReadOnlyList<Fix> fixes)
        => Enumerable.Range(1, fixes.Count - 1).Count(i =>
            Geo.DistanceMeters(Position(fixes[i - 1]), City) <= 300_000 && Geo.DistanceMeters(Position(fixes[i]), City) > 300_000);

    [Fact]
    public void Simulator_describe_matches_what_run_emits()
    {
        var plan = Simulator.Describe(Options);
        var fixes = History.Value;

        Assert.Equal(["north", "lisbon", "tokyo"], plan.Trips.Select(t => t.Name));
        Assert.Equal([2, 6, 24], plan.Trips.Select(t => t.Nights));
        Assert.Equal(plan.Trips.Count, Departures(fixes));

        foreach (var (name, start, nights) in plan.Trips)
        {
            var (hotel, zone) = Destinations[name];

            // The person is at the destination from the first fix near the hotel to the last, for the nights the plan says...
            var there = fixes.Where(f => Geo.DistanceMeters(Position(f), hotel) < 60_000).ToList();
            Assert.Equal(nights, LocalDate(there[^1].TimeUtc, zone).DayNumber - LocalDate(there[0].TimeUtc, zone).DayNumber);

            // ...and set out from home on the day it says: the last fix in the city before the first one there is on that local date.
            var left = fixes.TakeWhile(f => f.TimeUtc < there[0].TimeUtc).Last(f => Geo.DistanceMeters(Position(f), City) < 100_000);
            Assert.Equal(start, LocalDate(left.TimeUtc, "Europe/Oslo"));
        }
    }

    [Fact]
    public void Simulator_describe_puts_the_house_move_on_the_day_the_track_changes_homes()
    {
        var moveDay = Simulator.Describe(Options).MoveDay;

        // The last fix of a local day is where the person went to bed.
        GeoPoint Bed(DateOnly day) => Position(History.Value.Last(f => LocalDate(f.TimeUtc, "Europe/Oslo") == day));

        Assert.Equal(DayOfWeek.Saturday, moveDay.DayOfWeek);
        Assert.True(Geo.DistanceMeters(Bed(moveDay.AddDays(-2)), Bed(moveDay.AddDays(-1))) < 500, "home changed before the move day");
        Assert.True(Geo.DistanceMeters(Bed(moveDay.AddDays(-1)), Bed(moveDay)) > 5_000, "home did not change on the move day");
        Assert.True(Geo.DistanceMeters(Bed(moveDay), Bed(moveDay.AddDays(1))) < 500, "home changed after the move day");
    }

    [Fact]
    public void Simulator_describe_leaves_out_a_trip_that_does_not_fit_in_the_history()
    {
        var short20Days = Options with { To = new DateOnly(2024, 6, 20) }; // only the trip to the north fits (two nights and a day to spare)

        var plan = Simulator.Describe(short20Days);

        var north = Assert.Single(plan.Trips);
        Assert.Equal(("north", new DateOnly(2024, 6, 6), 2), north);
        Assert.Equal(1, Departures(Generate(short20Days)));
    }

    /// <summary>Compares fixes field by field (a fix holds an array, which a record compares by reference).</summary>
    private sealed class FixComparer : IEqualityComparer<Fix>
    {
        public static readonly FixComparer Instance = new();

        public bool Equals(Fix a, Fix b)
            => a.TimeUtc == b.TimeUtc && a.Latitude == b.Latitude && a.Longitude == b.Longitude && a.Speed == b.Speed
               && a.Altitude == b.Altitude && a.Accuracy == b.Accuracy
               && (a.Motion is null ? b.Motion is null : b.Motion is not null && a.Motion.SequenceEqual(b.Motion));

        public int GetHashCode(Fix fix) => HashCode.Combine(fix.TimeUtc, fix.Latitude, fix.Longitude);
    }
}
