using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class TripDetectorTests
{
    private const long OsloHome = 1, TownHome = 2, LisbonHome = 3, TokyoHome = 4;

    private static readonly GeoPoint Oslo = Spots.Home;
    private static readonly GeoPoint Cafe = Spots.Cafe;                         // about 1 km from home
    private static readonly GeoPoint Layover = Geo.Offset(Oslo, 100_000, 0);    // 100 km from home, same zone
    private static readonly GeoPoint Town = Geo.Offset(Oslo, 60_000, 0);        // 60 km from home, same zone
    private static readonly GeoPoint Lisbon = Spots.Lisbon;
    private static readonly GeoPoint Tokyo = Spots.Tokyo;
    private static readonly GeoPoint? Unknown = null;

    private static readonly DateOnly FirstNight = new(2026, 6, 1);
    private static readonly DetectionOptions Defaults = new(); // 50 km

    private static readonly IReadOnlyDictionary<long, GeoPoint> Places = new Dictionary<long, GeoPoint>
    {
        [OsloHome] = Oslo,
        [TownHome] = Town,
        [LisbonHome] = Lisbon,
        [TokyoHome] = Tokyo,
    };

    private static readonly IReadOnlyList<HomePeriod> OsloIsHome = [new HomePeriod(OsloHome, FirstNight, null)];

    /// <summary>The date of night number <paramref name="n"/>, counting from 1.</summary>
    private static DateOnly On(int n) => FirstNight.AddDays(n - 1);

    private static DateTime Utc(int month, int day, int hour, int minute = 0)
        => new(2026, month, day, hour, minute, 0, DateTimeKind.Utc);

    /// <summary>
    /// One night at <paramref name="where"/>, read at 03:00 local time in the zone of that position. Trip detection goes
    /// by position, never by place, so the nights belong to no place; a null position is an unknown night.
    /// </summary>
    private static Night NightAt(DateOnly date, GeoPoint? where)
    {
        var zone = where is { } point ? LocalTime.TimeZoneAt(point) : "Europe/Oslo";
        var (instant, _) = NightClock.InstantOf(date, _ => zone, 3)!.Value;
        return new Night(date, instant, zone, null, where);
    }

    /// <summary>Consecutive nights from runs of (position, count), starting on <see cref="FirstNight"/>.</summary>
    private static List<Night> Nights(params (GeoPoint? Where, int Count)[] runs)
    {
        var nights = new List<Night>();
        foreach (var (where, count) in runs)
            for (var i = 0; i < count; i++)
                nights.Add(NightAt(FirstNight.AddDays(nights.Count), where));
        return nights;
    }

    private static StayPosition Stay(DateTime start, DateTime end, GeoPoint where) => new(start, end, where);

    private static IReadOnlyList<DetectedTrip> Detect(
        IReadOnlyList<Night> nights,
        IReadOnlyList<StayPosition>? stays = null,
        IReadOnlyList<HomePeriod>? homes = null,
        DetectionOptions? options = null)
        => TripDetector.Detect(nights, homes ?? OsloIsHome, Places, stays ?? [], options ?? Defaults);

    // ---- the brief -----------------------------------------------------------------------------------------------

    // Night 1 (1 June) is read at 01:00Z on the 2nd in Oslo (UTC+2), night 2 at 02:00Z on the 3rd in Lisbon (UTC+1) and
    // night 3 at 01:00Z on the 4th in Oslo.
    [Fact]
    public void TripDetector_one_night_away_is_a_one_night_trip()
    {
        var stays = new[]
        {
            Stay(Utc(6, 1, 16), Utc(6, 2, 5), Oslo),
            Stay(Utc(6, 2, 5, 30), Utc(6, 2, 7), Cafe),             // the last stay near home before leaving
            Stay(Utc(6, 2, 8), Utc(6, 2, 9), Layover),              // ends after it, but is nowhere near home
            Stay(Utc(6, 2, 12), Utc(6, 3, 20), Lisbon),
            Stay(Utc(6, 3, 21), Utc(6, 3, 21, 30), Layover),        // starts after the away night, nowhere near home
            Stay(Utc(6, 3, 22, 30), Utc(6, 4, 0, 30), Cafe),        // the first stay near home on the way back
            Stay(Utc(6, 4, 0, 45), Utc(6, 4, 7), Oslo),
        };

        var trips = Detect(Nights((Oslo, 1), (Lisbon, 1), (Oslo, 1)), stays);

        Assert.Equal(
            [new DetectedTrip(On(2), On(2), 1, Utc(6, 2, 7), Utc(6, 3, 22, 30), "Europe/Oslo", "Europe/Oslo",
                new DateOnly(2026, 6, 2), new DateOnly(2026, 6, 4))],
            trips);
    }

    [Fact]
    public void TripDetector_counts_consecutive_away_nights_as_one_trip()
    {
        var trip = Assert.Single(Detect(Nights((Oslo, 1), (Lisbon, 6), (Oslo, 1))));

        Assert.Equal((On(2), On(7), 6), (trip.FirstNight, trip.LastNight, trip.Nights));
    }

    [Fact]
    public void TripDetector_bridges_unknown_nights_inside_a_trip_but_never_starts_one()
    {
        var inside = Assert.Single(Detect(Nights((Oslo, 1), (Lisbon, 1), (Unknown, 2), (Lisbon, 1), (Oslo, 1))));
        var before = Assert.Single(Detect(Nights((Oslo, 1), (Unknown, 1), (Lisbon, 1), (Oslo, 1))));

        Assert.Equal((On(2), On(5), 4), (inside.FirstNight, inside.LastNight, inside.Nights));
        Assert.Equal((On(3), On(3), 1), (before.FirstNight, before.LastNight, before.Nights));
    }

    [Fact]
    public void TripDetector_threshold_is_inclusive_at_50_km()
    {
        var justUnder = Geo.Offset(Oslo, 49_900, 0);
        var justOver = Geo.Offset(Oslo, 50_100, 0);

        Assert.Empty(Detect(Nights((Oslo, 1), (justUnder, 1), (Oslo, 1))));
        Assert.Single(Detect(Nights((Oslo, 1), (justOver, 1), (Oslo, 1))));

        // Exactly at the threshold is away: set the bar to the very distance of the night, and a hair above it.
        var measuredKm = Geo.DistanceMeters(Oslo, justOver) / 1000;
        var nights = Nights((Oslo, 1), (justOver, 1), (Oslo, 1));
        Assert.Single(Detect(nights, options: new DetectionOptions { TripMinDistanceKm = measuredKm }));
        Assert.Empty(Detect(nights, options: new DetectionOptions { TripMinDistanceKm = Math.BitIncrement(measuredKm) }));
    }

    [Fact] // Lisbon is home until night 3 and Tokyo from night 4, so the Tokyo nights 2 and 3 are a trip and night 4 is not
    public void TripDetector_trip_across_zones_has_local_dates_in_its_own_zones()
    {
        // The trip leaves Lisbon at 15:30Z on 2 June, which is 16:30 there but already 00:30 on the 3rd in Tokyo; it ends
        // at night 4, read at 18:00Z on the 4th, which is 19:00 there but 03:00 on the 5th in Tokyo.
        var homes = new[]
        {
            new HomePeriod(LisbonHome, On(1), On(3)),
            new HomePeriod(TokyoHome, On(4), null),
        };
        var stays = new[]
        {
            Stay(Utc(6, 1, 20), Utc(6, 2, 15, 30), Lisbon),
            Stay(Utc(6, 2, 20), Utc(6, 5, 0), Tokyo),
        };

        var trips = Detect(Nights((Lisbon, 1), (Tokyo, 3)), stays, homes);

        Assert.Equal(
            [new DetectedTrip(On(2), On(3), 2, Utc(6, 2, 15, 30), Utc(6, 4, 18), "Europe/Lisbon", "Asia/Tokyo",
                new DateOnly(2026, 6, 2), new DateOnly(2026, 6, 5))],
            trips);
    }

    [Fact]
    public void TripDetector_trip_reaching_the_last_night_is_ongoing()
    {
        var nights = Nights((Oslo, 1), (Lisbon, 2));

        var trip = Assert.Single(Detect(nights));

        Assert.Null(trip.EndUtc);
        Assert.Equal(On(3).AddDays(1), trip.LocalEndDate);
        Assert.Equal("Europe/Lisbon", trip.EndZone);
        Assert.Equal(nights[0].InstantUtc, trip.StartUtc); // no stay near home to leave from
    }

    [Fact]
    public void TripDetector_uses_the_home_in_effect_each_night()
    {
        // The home moves 60 km to Town after night 6. The visit to Town on nights 3 and 4 was a trip then; the nights
        // there from night 7 are home, and the night in Oslo that follows is away from the new home.
        var homes = new[]
        {
            new HomePeriod(OsloHome, On(1), On(6)),
            new HomePeriod(TownHome, On(7), null),
        };
        var nights = Nights((Oslo, 2), (Town, 2), (Oslo, 2), (Town, 3), (Oslo, 1));

        var trips = Detect(nights, homes: homes);

        Assert.Equal([(On(3), On(4), 2), (On(10), On(10), 1)], trips.Select(t => (t.FirstNight, t.LastNight, t.Nights)));
        Assert.Null(trips[1].EndUtc);
    }

    [Fact]
    public void TripDetector_finds_nothing_without_a_home()
        => Assert.Empty(Detect(Nights((Oslo, 1), (Lisbon, 3), (Oslo, 1)), homes: []));

    [Fact]
    public void TripDetector_falls_back_to_the_night_instants_without_home_area_stays()
    {
        var nights = Nights((Oslo, 1), (Lisbon, 1), (Oslo, 1));
        var stays = new[]
        {
            Stay(Utc(6, 1, 16), Utc(6, 1, 22), Oslo),   // ended before the home night was read
            Stay(Utc(6, 2, 12), Utc(6, 3, 20), Lisbon),
            Stay(Utc(6, 4, 6), Utc(6, 4, 9), Oslo),     // began after the home night was read
        };

        var trip = Assert.Single(Detect(nights, stays));

        Assert.Equal(
            new DetectedTrip(On(2), On(2), 1, Utc(6, 2, 1), Utc(6, 4, 1), "Europe/Oslo", "Europe/Oslo",
                new DateOnly(2026, 6, 2), new DateOnly(2026, 6, 4)),
            trip);
    }

    // ---- beyond the brief: the edges of a run, of the stay search, and of the data -----------------------------------

    [Fact]
    public void TripDetector_ends_a_trip_on_its_last_away_night_not_on_the_unknown_nights_after_it()
    {
        var nights = Nights((Oslo, 1), (Lisbon, 2), (Unknown, 2), (Oslo, 1));

        var trip = Assert.Single(Detect(nights));

        Assert.Equal((On(2), On(3), 2), (trip.FirstNight, trip.LastNight, trip.Nights));
        Assert.Equal(nights[5].InstantUtc, trip.EndUtc); // the home night after the unknown ones
    }

    [Fact]
    public void TripDetector_leaves_a_trip_ongoing_when_only_unknown_nights_follow()
    {
        var trip = Assert.Single(Detect(Nights((Oslo, 1), (Lisbon, 1), (Unknown, 2))));

        Assert.Null(trip.EndUtc);
        Assert.Equal(On(2).AddDays(1), trip.LocalEndDate);
        Assert.Equal("Europe/Lisbon", trip.EndZone);
    }

    [Fact]
    public void TripDetector_starts_at_the_first_away_night_when_no_home_night_precedes_it()
    {
        var nights = Nights((Unknown, 1), (Lisbon, 2), (Oslo, 1));
        // Without a home night to bracket the search there is no leaving stay to look for, however near home one was.
        var stays = new[] { Stay(Utc(5, 30, 8), Utc(5, 30, 9), Oslo) };

        var trip = Assert.Single(Detect(nights, stays));

        Assert.Equal(nights[1].InstantUtc, trip.StartUtc);
        Assert.Equal("Europe/Lisbon", trip.StartZone);
        Assert.Equal(On(3), trip.LocalStartDate); // 03:00 Lisbon time on the day after the night
    }

    [Fact]
    public void TripDetector_counts_a_missing_date_as_an_unknown_night()
    {
        var nights = Nights((Oslo, 1), (Lisbon, 4), (Oslo, 1)).Where(n => n.Date != On(3) && n.Date != On(4)).ToList();

        var trip = Assert.Single(Detect(nights));

        Assert.Equal((On(2), On(5), 4), (trip.FirstNight, trip.LastNight, trip.Nights));
    }

    [Fact]
    public void TripDetector_never_calls_a_night_away_from_a_home_with_no_known_position()
    {
        var homes = new[] { new HomePeriod(99, FirstNight, null) }; // 99 is in no place list

        Assert.Empty(Detect(Nights((Oslo, 1), (Lisbon, 3), (Oslo, 1)), homes: homes));
    }

    [Fact]
    public void TripDetector_counts_stays_at_the_instants_of_the_first_and_last_away_night()
    {
        var nights = Nights((Oslo, 1), (Lisbon, 1), (Oslo, 1));
        var stays = new[]
        {
            Stay(nights[1].InstantUtc.AddHours(-3), nights[1].InstantUtc, Oslo),   // ends as the away night is read
            Stay(nights[1].InstantUtc, nights[1].InstantUtc.AddHours(3), Oslo),    // begins as the away night is read
        };

        var trip = Assert.Single(Detect(nights, stays));

        Assert.Equal(nights[1].InstantUtc, trip.StartUtc);
        Assert.Equal(nights[1].InstantUtc, trip.EndUtc);
    }

    [Fact]
    public void TripDetector_gives_each_trip_its_own_leaving_and_returning_stay()
    {
        var nights = Nights((Oslo, 1), (Lisbon, 1), (Oslo, 2), (Lisbon, 2), (Oslo, 1));
        var (n2, n5, n6) = (nights[1].InstantUtc, nights[4].InstantUtc, nights[5].InstantUtc);
        var stays = new[]
        {
            Stay(n2.AddHours(-10), n2.AddHours(-6), Oslo),
            Stay(n2.AddHours(6), n2.AddHours(8), Oslo),
            Stay(n2.AddHours(10), n5.AddHours(-24), Cafe),   // at home between the two trips, ends well before the second
            Stay(n5.AddHours(-10), n5.AddHours(-5), Oslo),
            Stay(n6.AddHours(5), n6.AddHours(9), Oslo),
        };

        var trips = Detect(nights, stays);

        Assert.Equal(
            [(n2.AddHours(-6), n2.AddHours(6)), (n5.AddHours(-5), n6.AddHours(5))],
            trips.Select(t => (t.StartUtc, t.EndUtc!.Value)));
    }

    [Fact]
    public void TripDetector_leaves_from_the_home_at_the_first_away_night_and_returns_to_the_home_at_the_last()
    {
        // The home moves from Oslo to Town after night 3, in the middle of a stay in Lisbon (nights 2 to 5). The person
        // left Oslo and came back to Town, so the stays near the other home are not the leaving and returning ones.
        var homes = new[]
        {
            new HomePeriod(OsloHome, On(1), On(3)),
            new HomePeriod(TownHome, On(4), null),
        };
        var nights = Nights((Oslo, 1), (Lisbon, 4), (Town, 1));
        var (n2, n5) = (nights[1].InstantUtc, nights[4].InstantUtc);
        var stays = new[]
        {
            Stay(n2.AddHours(-8), n2.AddHours(-6), Oslo),    // the leaving stay
            Stay(n2.AddHours(-5), n2.AddHours(-4), Town),    // later, but near the home of the last night only
            Stay(n2.AddHours(1), n5.AddHours(-1), Lisbon),
            Stay(n5.AddHours(2), n5.AddHours(3), Oslo),      // near the home of the first night only
            Stay(n5.AddHours(5), n5.AddHours(8), Town),      // the returning stay
        };

        var trip = Assert.Single(Detect(nights, stays, homes));

        Assert.Equal((n2.AddHours(-6), n5.AddHours(5)), (trip.StartUtc, trip.EndUtc));
    }

    [Fact]
    public void TripDetector_finds_the_stays_of_a_hundred_trips_among_twenty_thousand()
    {
        // 100 cycles of ten nights, seven at home and then three in Lisbon, and twenty stays a day in the place where the
        // person slept the night before. So the last stay of the day before a trip's first night is the leaving stay
        // (it ends at 23:10Z), and the first stay of the day after its last away night is the returning one (00:00Z).
        const int cycles = 100;
        var runs = new List<(GeoPoint? Where, int Count)>();
        for (var i = 0; i < cycles; i++) runs.AddRange([(Oslo, 7), (Lisbon, 3)]);
        var nights = Nights(runs.ToArray());

        DateTime Midnight(int day) => FirstNight.AddDays(day).ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        var stays = new List<StayPosition>();
        for (var day = 0; day < nights.Count; day++)
        {
            var where = day == 0 ? Oslo : nights[day - 1].Position!.Value;
            for (var i = 0; i < 20; i++)
                stays.Add(Stay(Midnight(day).AddMinutes(70 * i), Midnight(day).AddMinutes(70 * i + 60), where));
        }

        var trips = Detect(nights, stays);

        Assert.Equal(cycles, trips.Count);
        for (var t = 0; t < cycles; t++)
        {
            var first = 10 * t + 7; // zero-based index of the trip's first away night
            Assert.Equal(On(first + 1), trips[t].FirstNight);
            Assert.Equal(3, trips[t].Nights);
            Assert.Equal(Midnight(first).AddMinutes(70 * 19 + 60), trips[t].StartUtc);
            if (t < cycles - 1) Assert.Equal(Midnight(first + 4), trips[t].EndUtc);
            else Assert.Null(trips[t].EndUtc); // the history ends in Lisbon
        }
    }
}
