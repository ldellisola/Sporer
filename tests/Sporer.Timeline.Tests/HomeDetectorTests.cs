using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class HomeDetectorTests
{
    private const long A = 1, B = 2, T = 3;

    private static readonly DateOnly FirstNight = new(2026, 1, 1);
    private static readonly DetectionOptions Defaults = new(); // 60 of 90 nights

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
        var homes = HomeDetector.Detect(Nights((A, 90)), Defaults);

        Assert.Equal([Home(A, 1)], homes);
    }

    [Fact]
    public void HomeDetector_finds_nothing_below_the_bar()
        => Assert.Empty(HomeDetector.Detect(Nights((A, 59)), Defaults));

    [Fact]
    public void HomeDetector_switches_home_after_60_of_90_nights_and_backdates_to_the_first_night_there()
    {
        // B is the night location from night 101 and first has 60 of the last 90 nights on night 160.
        var homes = HomeDetector.Detect(Nights((A, 100), (B, 80)), Defaults);

        Assert.Equal([Home(A, 1, 100), Home(B, 101)], homes);
    }

    [Fact]
    public void HomeDetector_backdates_a_new_home_to_its_first_night_in_the_window_even_when_that_night_is_isolated()
    {
        // B is the night location on night 101 alone, then from night 112. It first has 60 of the last 90 nights on night
        // 170 (night 101 plus the 59 nights 112-170), and night 101 is still inside that window [81, 170]. The period
        // starts there, not at night 112 where the final run of B begins.
        var homes = HomeDetector.Detect(Nights((A, 100), (B, 1), (A, 10), (B, 70)), Defaults);

        Assert.Equal([Home(A, 1, 100), Home(B, 101)], homes);
    }

    [Fact]
    public void HomeDetector_keeps_home_through_a_long_stay_below_the_bar()
    {
        // 45 nights away never reach 60 of 90, so the stay stays a trip.
        var homes = HomeDetector.Detect(Nights((A, 100), (T, 45), (A, 30)), Defaults);

        Assert.Equal([Home(A, 1)], homes);
    }

    [Fact]
    public void HomeDetector_ignores_unknown_nights_and_nights_without_a_place()
    {
        var withUnknownNights = Nights((A, 70), (null, 30), (A, 10));
        // A position that matched no place: known, but it belongs to no place any more than an unknown night does.
        var withoutAPlace = withUnknownNights.Select(n => n.PlaceId is null ? n with { Position = Spots.Cafe } : n).ToList();

        Assert.Equal([Home(A, 1)], HomeDetector.Detect(withUnknownNights, Defaults));
        Assert.Equal([Home(A, 1)], HomeDetector.Detect(withoutAPlace, Defaults));
    }

    [Fact]
    public void HomeDetector_moves_back_when_the_old_home_qualifies_again()
    {
        // B first has 60 of 90 on night 160 (backdated to 101); A is back from night 191 and has 60 of 90 on night 250.
        var homes = HomeDetector.Detect(Nights((A, 100), (B, 90), (A, 90)), Defaults);

        Assert.Equal([Home(A, 1, 100), Home(B, 101, 190), Home(A, 191)], homes);
    }

    // ---- beyond the brief: gaps in the dates, the options, no nights at all ----------------------------------------

    [Fact]
    public void HomeDetector_counts_a_missing_date_as_an_unknown_night()
    {
        // 60 nights with a place, but spread over 130 calendar nights: no 90 of them hold 60.
        var homes = HomeDetector.Detect(Nights((A, 30), (null, 70), (A, 30)).Where(n => n.PlaceId is not null).ToList(), Defaults);

        Assert.Empty(homes);
    }

    [Fact]
    public void HomeDetector_reads_the_window_and_the_bar_from_the_options()
    {
        var threeOfFour = new DetectionOptions { HomeWindowNights = 4, HomeMinNights = 3 };

        Assert.Equal([Home(A, 1)], HomeDetector.Detect(Nights((A, 3)), threeOfFour));
        Assert.Empty(HomeDetector.Detect(Nights((A, 3)), Defaults));
    }

    [Fact]
    public void HomeDetector_finds_nothing_in_no_nights()
        => Assert.Empty(HomeDetector.Detect([], Defaults));
}
