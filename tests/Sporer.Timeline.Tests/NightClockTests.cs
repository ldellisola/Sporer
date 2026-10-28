namespace Sporer.Timeline.Tests;

public class NightClockTests
{
    private const int NightHour = 3;

    private static DateTime Utc(int year, int month, int day, int hour = 0)
        => new(year, month, day, hour, 0, 0, DateTimeKind.Utc);

    /// <summary>A person who stays in one zone for the whole history.</summary>
    private static Func<DateTime, string?> Always(string zone) => _ => zone;

    // ---- the brief -----------------------------------------------------------------------------------------------

    [Fact] // Oslo is on summer time (UTC+2) on the evening of 22 October, so 03:00 on the 23rd is 01:00Z
    public void NightClock_is_03_00_local_on_the_next_day()
    {
        var instant = NightClock.InstantOf(new DateOnly(2026, 10, 22), Always("Europe/Oslo"), NightHour);

        Assert.Equal((Utc(2026, 10, 23, 1), "Europe/Oslo"), instant);
    }

    [Fact] // the clocks go back at 01:00Z on 25 October (03:00 CEST becomes 02:00 CET), so 03:00 happens once, in CET
    public void NightClock_on_the_night_the_clocks_go_back()
    {
        var instant = NightClock.InstantOf(new DateOnly(2026, 10, 24), Always("Europe/Oslo"), NightHour);

        Assert.Equal((Utc(2026, 10, 25, 2), "Europe/Oslo"), instant);
    }

    [Fact] // the clocks go forward at 01:00Z on 29 March (02:00 CET becomes 03:00 CEST), so 03:00 is CEST = 01:00Z
    public void NightClock_on_the_night_the_clocks_go_forward()
    {
        var instant = NightClock.InstantOf(new DateOnly(2026, 3, 28), Always("Europe/Oslo"), NightHour);

        Assert.Equal((Utc(2026, 3, 29, 1), "Europe/Oslo"), instant);
    }

    [Fact] // landed in Tokyo at midday UTC on the 10th: 03:00 on the 11th is Tokyo's, and is 18:00Z on the 10th
    public void NightClock_follows_a_flight_into_another_zone()
    {
        var landing = Utc(2026, 5, 10, 12);
        Func<DateTime, string?> zoneAt = t => t < landing ? "Europe/Lisbon" : "Asia/Tokyo";

        var instant = NightClock.InstantOf(new DateOnly(2026, 5, 10), zoneAt, NightHour);

        Assert.Equal((Utc(2026, 5, 10, 18), "Asia/Tokyo"), instant);
    }

    [Fact]
    public void NightClock_is_null_without_data()
        => Assert.Null(NightClock.InstantOf(new DateOnly(2026, 10, 22), _ => null, NightHour));

    // ---- the rules the brief states for local times that are not one instant ---------------------------------------

    [Fact] // Helsinki skips 03:00-04:00 on 29 March (01:00Z), so 03:00 does not exist and 04:00 EEST (+3) = 01:00Z stands in
    public void NightClock_moves_a_time_that_does_not_exist_forward()
    {
        var instant = NightClock.InstantOf(new DateOnly(2026, 3, 28), Always("Europe/Helsinki"), NightHour);

        Assert.Equal((Utc(2026, 3, 29, 1), "Europe/Helsinki"), instant);
    }

    [Fact] // Troll Station skips two hours (01:00-03:00) on 29 March, so 02:00 is missing and moves on by both: 04:00 (+2) = 02:00Z
    public void NightClock_moves_a_missing_time_forward_by_the_whole_gap()
    {
        var instant = NightClock.InstantOf(new DateOnly(2026, 3, 28), Always("Antarctica/Troll"), hour: 2);

        Assert.Equal((Utc(2026, 3, 29, 2), "Antarctica/Troll"), instant);
    }

    [Fact] // Helsinki repeats 03:00-04:00 on 25 October (01:00Z); the first 03:00 is EEST (+3) = 00:00Z, the second EET (+2) = 01:00Z
    public void NightClock_takes_the_first_occurrence_of_an_ambiguous_time()
    {
        var instant = NightClock.InstantOf(new DateOnly(2026, 10, 24), Always("Europe/Helsinki"), NightHour);

        Assert.Equal((Utc(2026, 10, 25, 0), "Europe/Helsinki"), instant);
    }

    // ---- the second step ------------------------------------------------------------------------------------------

    [Fact] // the first guess (03:00Z on the 11th) is read in Tokyo, but Tokyo's 03:00 (18:00Z on the 10th) was still Lisbon
    public void NightClock_reads_the_zone_again_when_the_first_guess_lands_elsewhere()
    {
        var landing = Utc(2026, 5, 10, 22);
        Func<DateTime, string?> zoneAt = t => t < landing ? "Europe/Lisbon" : "Asia/Tokyo";

        var instant = NightClock.InstantOf(new DateOnly(2026, 5, 10), zoneAt, NightHour);

        Assert.Equal((Utc(2026, 5, 11, 2), "Europe/Lisbon"), instant); // 03:00 WEST (+1)
    }
}
