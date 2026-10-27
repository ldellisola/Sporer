using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class HomeDetectorTests
{
    private const long A = 1, B = 2, T = 3;

    // Fragments of a home: places that GPS drift made of one home (A1, A2), and of a new home (F1 to F4).
    private const long A1 = 4, A2 = 5, C = 6, F1 = 11, F2 = 12, F3 = 13, F4 = 14;

    private static readonly DateOnly FirstNight = new(2026, 1, 1);
    private static readonly DetectionOptions Defaults = new(); // 60 of 90 nights, places within 250 m are one home

    /// <summary>A, B and T are kilometres from each other, so that no place is near another: grouping changes nothing for them.</summary>
    private static readonly IReadOnlyDictionary<long, GeoPoint> Apart = new Dictionary<long, GeoPoint>
    {
        [A] = Spots.Home,
        [B] = Geo.Offset(Spots.Home, 0, 20_000),
        [T] = Geo.Offset(Spots.Home, 0, 60_000),
    };

    private static readonly IReadOnlyDictionary<long, GeoPoint> NoPositions = new Dictionary<long, GeoPoint>();

    /// <summary>The place that is <paramref name="east"/> metres east and <paramref name="north"/> metres north of the home.</summary>
    private static GeoPoint Near(double north, double east) => Geo.Offset(Spots.Home, north, east);

    /// <summary>The date of night number <paramref name="n"/>, counting from 1.</summary>
    private static DateOnly On(int n) => FirstNight.AddDays(n - 1);

    /// <summary>
    /// Consecutive nights from runs of (place, count). A null place is an unknown night: no place and no position.
    /// </summary>
    private static List<Night> Nights(params (long? Place, int Count)[] runs)
    {
        var nights = new List<Night>();
        foreach (var (place, count) in runs)
        {
            for (var i = 0; i < count; i++)
            {
                var date = FirstNight.AddDays(nights.Count);
                var instant = date.AddDays(1).ToDateTime(new TimeOnly(1, 0), DateTimeKind.Utc);
                nights.Add(new Night(date, instant, "Europe/Oslo", place, place is null ? null : Spots.Home));
            }
        }
        return nights;
    }

    private static HomePeriod Home(long place, int fromNight, int? toNight = null)
        => new(place, On(fromNight), toNight is { } to ? On(to) : null);

    // ---- the brief -----------------------------------------------------------------------------------------------

    [Fact]
    public void HomeDetector_names_the_first_home_from_the_first_night()
    {
        var homes = HomeDetector.Detect(Nights((A, 90)), Apart, Defaults);

        Assert.Equal([Home(A, 1)], homes);
    }

    [Fact]
    public void HomeDetector_finds_nothing_below_the_bar()
        => Assert.Empty(HomeDetector.Detect(Nights((A, 59)), Apart, Defaults));

    [Fact]
    public void HomeDetector_switches_home_after_60_of_90_nights_and_backdates_to_the_first_night_there()
    {
        // B is the night location from night 101 and first has 60 of the last 90 nights on night 160.
        var homes = HomeDetector.Detect(Nights((A, 100), (B, 80)), Apart, Defaults);

        Assert.Equal([Home(A, 1, 100), Home(B, 101)], homes);
    }

    [Fact]
    public void HomeDetector_backdates_a_new_home_to_its_first_night_in_the_window_even_when_that_night_is_isolated()
    {
        // B is the night location on night 101 alone, then from night 112. It first has 60 of the last 90 nights on night
        // 170 (night 101 plus the 59 nights 112-170), and night 101 is still inside that window [81, 170]. The period
        // starts there, not at night 112 where the final run of B begins.
        var homes = HomeDetector.Detect(Nights((A, 100), (B, 1), (A, 10), (B, 70)), Apart, Defaults);

        Assert.Equal([Home(A, 1, 100), Home(B, 101)], homes);
    }

    [Fact]
    public void HomeDetector_keeps_home_through_a_long_stay_below_the_bar()
    {
        // 45 nights away never reach 60 of 90, so the stay stays a trip.
        var homes = HomeDetector.Detect(Nights((A, 100), (T, 45), (A, 30)), Apart, Defaults);

        Assert.Equal([Home(A, 1)], homes);
    }

    [Fact]
    public void HomeDetector_ignores_unknown_nights_and_nights_without_a_place()
    {
        var withUnknownNights = Nights((A, 70), (null, 30), (A, 10));
        // A position that matched no place: known, but it belongs to no place any more than an unknown night does.
        var withoutAPlace = withUnknownNights.Select(n => n.PlaceId is null ? n with { Position = Spots.Cafe } : n).ToList();

        Assert.Equal([Home(A, 1)], HomeDetector.Detect(withUnknownNights, Apart, Defaults));
        Assert.Equal([Home(A, 1)], HomeDetector.Detect(withoutAPlace, Apart, Defaults));
    }

    [Fact]
    public void HomeDetector_moves_back_when_the_old_home_qualifies_again()
    {
        // B first has 60 of 90 on night 160 (backdated to 101); A is back from night 191 and has 60 of 90 on night 250.
        var homes = HomeDetector.Detect(Nights((A, 100), (B, 90), (A, 90)), Apart, Defaults);

        Assert.Equal([Home(A, 1, 100), Home(B, 101, 190), Home(A, 191)], homes);
    }

    // ---- beyond the brief: gaps in the dates, the options, no nights at all ----------------------------------------

    [Fact]
    public void HomeDetector_counts_a_missing_date_as_an_unknown_night()
    {
        // 60 nights with a place, but spread over 130 calendar nights: no 90 of them hold 60.
        var homes = HomeDetector.Detect(Nights((A, 30), (null, 70), (A, 30)).Where(n => n.PlaceId is not null).ToList(), Apart, Defaults);

        Assert.Empty(homes);
    }

    [Fact]
    public void HomeDetector_reads_the_window_and_the_bar_from_the_options()
    {
        var threeOfFour = new DetectionOptions { HomeWindowNights = 4, HomeMinNights = 3 };

        Assert.Equal([Home(A, 1)], HomeDetector.Detect(Nights((A, 3)), Apart, threeOfFour));
        Assert.Empty(HomeDetector.Detect(Nights((A, 3)), Apart, Defaults));
    }

    [Fact]
    public void HomeDetector_finds_nothing_in_no_nights()
        => Assert.Empty(HomeDetector.Detect([], Apart, Defaults));

    // ---- places near each other are one home (HomeRadiusMeters) -----------------------------------------------------

    [Fact]
    public void HomeDetector_counts_a_home_split_over_nearby_places_as_one_home()
    {
        // A, A1 and A2 are about 100 m from each other: GPS drift, not three homes. They take turns, 30 nights each in 90, and none
        // has 60 alone. All three count 60 together by night 60, and the one with the most nights of its own then is A1.
        var positions = new Dictionary<long, GeoPoint> { [A] = Near(0, 0), [A1] = Near(0, 100), [A2] = Near(100, 50) };
        var nights = Nights((A1, 12), (A, 10), (A2, 8), (A1, 12), (A, 10), (A2, 8), (A1, 12), (A, 10), (A2, 8));

        Assert.Equal([Home(A1, 1)], HomeDetector.Detect(nights, positions, Defaults));
        // Counted by place alone, as before, no place reaches the bar.
        Assert.Empty(HomeDetector.Detect(nights, NoPositions, Defaults));
    }

    [Fact]
    public void HomeDetector_picks_the_place_most_of_the_others_are_near_before_the_one_with_most_nights_of_its_own()
    {
        // A, B and C are in a line 200 m apart: B is near both, A and C are not near each other. C has the most nights of its own, but
        // B counts all of them and is home from the first night.
        var positions = new Dictionary<long, GeoPoint> { [A] = Near(0, 0), [B] = Near(0, 200), [C] = Near(0, 400) };
        var nights = Nights((C, 20), (A, 15), (B, 10), (C, 20), (A, 15), (B, 10));

        Assert.Equal([Home(B, 1)], HomeDetector.Detect(nights, positions, Defaults));
    }

    [Fact]
    public void HomeDetector_does_not_flip_between_fragments_of_the_same_home()
    {
        // Home A is established. Later 80 nights are at A1, 120 m away, which has 60 of 90 on its own: a fragment of A, not a move.
        var positions = new Dictionary<long, GeoPoint> { [A] = Near(0, 0), [A1] = Near(0, 120) };

        Assert.Equal([Home(A, 1)], HomeDetector.Detect(Nights((A, 100), (A1, 80)), positions, Defaults));
        // The same nights are a move when the two places are not known to be near each other.
        Assert.Equal([Home(A, 1, 100), Home(A1, 101)], HomeDetector.Detect(Nights((A, 100), (A1, 80)), NoPositions, Defaults));
    }

    [Fact]
    public void HomeDetector_finds_a_move_beyond_the_radius_and_backdates_it_as_before()
    {
        // B is 400 m from A: far enough to be another home. It has 60 of 90 on night 160, and the period is backdated to night 101.
        var positions = new Dictionary<long, GeoPoint> { [A] = Near(0, 0), [B] = Near(0, 400) };

        Assert.Equal([Home(A, 1, 100), Home(B, 101)], HomeDetector.Detect(Nights((A, 100), (B, 80)), positions, Defaults));
    }

    [Fact]
    public void HomeDetector_finds_a_move_to_a_home_split_over_four_places()
    {
        // The synthetic history in small: a move 17 km away, the new home split over four places 75 to 130 m apart. Each has 20 nights
        // of 80, so none gets near 60 alone; together they have 60 of 90 on night 160. The two with most nights of their own are
        // F1 and F2, and the lower id of them is the home, from the first night at the new home.
        var far = Geo.Offset(Spots.Home, 0, 17_000);
        var positions = new Dictionary<long, GeoPoint>
        {
            [A] = Spots.Home,
            [F1] = far,
            [F2] = Geo.Offset(far, 0, 75),
            [F3] = Geo.Offset(far, 130, 0),
            [F4] = Geo.Offset(far, -60, -60),
        };
        var nights = Nights((A, 100), (F1, 10), (F2, 10), (F3, 10), (F4, 10), (F1, 10), (F2, 10), (F3, 10), (F4, 10));

        Assert.Equal([Home(A, 1, 100), Home(F1, 101)], HomeDetector.Detect(nights, positions, Defaults));
        // Counted by place alone, the move is never found.
        Assert.Equal([Home(A, 1)], HomeDetector.Detect(nights, NoPositions, Defaults));
    }

    [Fact]
    public void HomeDetector_counts_a_place_with_no_known_position_only_for_itself()
    {
        // A and A1 are 100 m apart and have 30 nights each: together 60, alone 30.
        var nights = Nights((A, 30), (A1, 30));
        var both = new Dictionary<long, GeoPoint> { [A] = Near(0, 0), [A1] = Near(0, 100) };
        var onlyA = new Dictionary<long, GeoPoint> { [A] = Near(0, 0) };
        var onlyA1 = new Dictionary<long, GeoPoint> { [A1] = Near(0, 100) };

        Assert.Equal([Home(A, 1)], HomeDetector.Detect(nights, both, Defaults));
        Assert.Empty(HomeDetector.Detect(nights, onlyA, Defaults)); // A1 has no position: it counts for itself, and not for A
        Assert.Empty(HomeDetector.Detect(nights, onlyA1, Defaults)); // A has none: it counts for itself, and A1 does not count it
        Assert.Empty(HomeDetector.Detect(nights, NoPositions, Defaults));
    }

    [Fact]
    public void HomeDetector_reads_the_radius_from_the_options()
    {
        var nights = Nights((A, 30), (A1, 30));
        var positions = new Dictionary<long, GeoPoint> { [A] = Near(0, 0), [A1] = Near(0, 100) };

        Assert.Equal([Home(A, 1)], HomeDetector.Detect(nights, positions, new DetectionOptions { HomeRadiusMeters = 100.5 }));
        Assert.Empty(HomeDetector.Detect(nights, positions, new DetectionOptions { HomeRadiusMeters = 99 }));
    }
}
