namespace Sporer.Timeline.Tests;

/// <summary>The home periods the owner set, put over the ones detection found: the owner's win on their dates.</summary>
public class HomeOverridesTests
{
    private const long A = 1, B = 2, C = 3;

    private static DateOnly D(int month, int day) => new(2026, month, day);

    private static HomePeriod Home(long place, DateOnly from, DateOnly? to = null) => new(place, from, to);

    [Fact]
    public void HomeOverrides_user_period_splits_a_detected_one()
    {
        // The person was at home at A all year, and says they were at B for the whole of March.
        var detected = new[] { Home(A, D(1, 1)) };
        var user = new[] { Home(B, D(3, 1), D(3, 31)) };

        var homes = HomeOverrides.Apply(detected, user);

        Assert.Equal([Home(A, D(1, 1), D(2, 28)), Home(B, D(3, 1), D(3, 31)), Home(A, D(4, 1))], homes);
    }

    [Fact]
    public void HomeOverrides_open_user_period_runs_to_the_end()
    {
        // From the 1st of March the person lives at C, whatever detection says about the months after: a period that began after the
        // start is cut, one that began before is cut short, and one that lies inside is gone.
        var detected = new[] { Home(A, D(1, 1), D(4, 30)), Home(B, D(5, 1), D(8, 31)), Home(A, D(9, 1)) };
        var user = new[] { Home(C, D(3, 1)) };

        var homes = HomeOverrides.Apply(detected, user);

        Assert.Equal([Home(A, D(1, 1), D(2, 28)), Home(C, D(3, 1))], homes);
    }

    [Fact]
    public void HomeOverrides_none_keeps_detected()
    {
        var detected = new[] { Home(A, D(1, 1), D(4, 30)), Home(B, D(5, 1)) };

        Assert.Equal(detected, HomeOverrides.Apply(detected, []));
        Assert.Empty(HomeOverrides.Apply([], []));
    }

    [Fact]
    public void HomeOverrides_with_no_detected_home_is_the_owners()
    {
        var user = new[] { Home(B, D(3, 1), D(3, 31)), Home(C, D(6, 1)) };

        Assert.Equal(user, HomeOverrides.Apply([], user));
    }

    [Fact]
    public void HomeOverrides_user_period_over_the_end_of_one_and_the_start_of_the_next_cuts_both()
    {
        var detected = new[] { Home(A, D(1, 1), D(4, 30)), Home(B, D(5, 1)) };
        var user = new[] { Home(C, D(4, 20), D(5, 10)) };

        var homes = HomeOverrides.Apply(detected, user);

        Assert.Equal([Home(A, D(1, 1), D(4, 19)), Home(C, D(4, 20), D(5, 10)), Home(B, D(5, 11))], homes);
    }

    [Fact]
    public void HomeOverrides_user_period_over_a_whole_detected_one_takes_its_place()
    {
        var detected = new[] { Home(A, D(1, 1), D(2, 28)), Home(B, D(3, 1), D(3, 31)), Home(A, D(4, 1)) };
        var user = new[] { Home(C, D(2, 15), D(4, 15)) };

        var homes = HomeOverrides.Apply(detected, user);

        Assert.Equal([Home(A, D(1, 1), D(2, 14)), Home(C, D(2, 15), D(4, 15)), Home(A, D(4, 16))], homes);
    }

    [Fact]
    public void HomeOverrides_a_user_period_of_one_night_is_kept_and_cuts_one_night()
    {
        var detected = new[] { Home(A, D(1, 1)) };
        var user = new[] { Home(B, D(3, 10), D(3, 10)) };

        var homes = HomeOverrides.Apply(detected, user);

        Assert.Equal([Home(A, D(1, 1), D(3, 9)), Home(B, D(3, 10), D(3, 10)), Home(A, D(3, 11))], homes);
    }

    [Fact]
    public void HomeOverrides_two_user_periods_each_cut_the_detected_one()
    {
        var detected = new[] { Home(A, D(1, 1)) };
        var user = new[] { Home(C, D(6, 1), D(6, 30)), Home(B, D(3, 1), D(3, 31)) }; // not in order

        var homes = HomeOverrides.Apply(detected, user);

        Assert.Equal(
            [Home(A, D(1, 1), D(2, 28)), Home(B, D(3, 1), D(3, 31)), Home(A, D(4, 1), D(5, 31)), Home(C, D(6, 1), D(6, 30)), Home(A, D(7, 1))],
            homes);
    }

    [Fact]
    public void HomeOverrides_where_user_periods_overlap_the_one_that_began_later_has_the_dates()
    {
        // The app never stores two that share a date, but the result of any input has no overlap: the rule is the one the views read by.
        var user = new[] { Home(A, D(1, 1), D(3, 31)), Home(B, D(3, 1), D(4, 30)) };

        var homes = HomeOverrides.Apply([], user);

        Assert.Equal([Home(A, D(1, 1), D(2, 28)), Home(B, D(3, 1), D(4, 30))], homes);
    }

    [Fact]
    public void HomeOverrides_a_user_period_inside_another_splits_it()
    {
        var user = new[] { Home(A, D(1, 1), D(12, 31)), Home(B, D(3, 1), D(3, 31)) };

        var homes = HomeOverrides.Apply([], user);

        Assert.Equal([Home(A, D(1, 1), D(2, 28)), Home(B, D(3, 1), D(3, 31)), Home(A, D(4, 1), D(12, 31))], homes);
    }

    [Fact]
    public void HomeOverrides_leaves_out_a_period_that_ends_before_it_begins()
    {
        var detected = new[] { Home(A, D(1, 1)) };
        var user = new[] { Home(B, D(3, 31), D(3, 1)) };

        Assert.Equal(detected, HomeOverrides.Apply(detected, user));
        Assert.Empty(HomeOverrides.Apply([Home(A, D(3, 31), D(3, 1))], []));
    }

    [Fact]
    public void HomeOverrides_result_has_no_overlap_and_is_in_date_order()
    {
        var detected = new[] { Home(A, D(1, 1), D(3, 15)), Home(B, D(3, 16), D(7, 31)), Home(C, D(8, 1)) };
        var user = new[] { Home(C, D(2, 1), D(2, 10)), Home(A, D(3, 10), D(3, 20)), Home(B, D(7, 25), D(8, 5)), Home(A, D(11, 1)) };

        var homes = HomeOverrides.Apply(detected, user);

        Assert.Equal(homes.OrderBy(h => h.From), homes);
        for (var i = 1; i < homes.Count; i++)
            Assert.True(homes[i - 1].To is { } to && to < homes[i].From, $"{homes[i - 1]} overlaps {homes[i]}");
        Assert.Null(homes[^1].To); // the open user period is the last, and open
        Assert.Equal(
            [
                Home(A, D(1, 1), D(1, 31)), Home(C, D(2, 1), D(2, 10)), Home(A, D(2, 11), D(3, 9)), Home(A, D(3, 10), D(3, 20)),
                Home(B, D(3, 21), D(7, 24)), Home(B, D(7, 25), D(8, 5)), Home(C, D(8, 6), D(10, 31)), Home(A, D(11, 1)),
            ],
            homes);
    }

    [Fact]
    public void HomeOverrides_does_not_change_its_arguments()
    {
        var detected = new[] { Home(A, D(1, 1)) };
        var user = new[] { Home(B, D(3, 1), D(3, 31)) };

        HomeOverrides.Apply(detected, user);

        Assert.Equal([Home(A, D(1, 1))], detected);
        Assert.Equal([Home(B, D(3, 1), D(3, 31))], user);
    }
}
