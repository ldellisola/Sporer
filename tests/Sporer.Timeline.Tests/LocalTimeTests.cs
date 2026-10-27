using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class LocalTimeTests
{
    [Fact]
    public void TimeZone_of_home_is_oslo() => Assert.Equal("Europe/Oslo", LocalTime.TimeZoneAt(Spots.Home));

    [Fact]
    public void TimeZone_of_the_other_spots()
    {
        Assert.Equal("Europe/Lisbon", LocalTime.TimeZoneAt(Spots.Lisbon));
        Assert.Equal("Asia/Tokyo", LocalTime.TimeZoneAt(Spots.Tokyo));
        Assert.Equal("America/Los_Angeles", LocalTime.TimeZoneAt(Spots.SanFrancisco));
    }

    [Fact] // 2026-10-22T22:30Z is 2026-10-23 in Oslo (UTC+2)
    public void LocalDate_uses_zone()
        => Assert.Equal(new DateOnly(2026, 10, 23),
            LocalTime.LocalDate(new DateTime(2026, 10, 22, 22, 30, 0, DateTimeKind.Utc), "Europe/Oslo"));

    [Fact] // DST ends 2026-10-25 01:00Z: 00:30Z is 02:30 CEST and 01:30Z is 02:30 CET
    public void LocalTime_handles_dst_end()
    {
        Assert.Equal(new DateTime(2026, 10, 25, 2, 30, 0),
            LocalTime.ToLocal(new DateTime(2026, 10, 25, 0, 30, 0, DateTimeKind.Utc), "Europe/Oslo"));
        Assert.Equal(new DateTime(2026, 10, 25, 2, 30, 0),
            LocalTime.ToLocal(new DateTime(2026, 10, 25, 1, 30, 0, DateTimeKind.Utc), "Europe/Oslo"));
    }

    [Fact] // Oslo is on summer time (UTC+2) in July
    public void ToUtc_converts_an_ordinary_local_time()
    {
        var utc = LocalTime.ToUtc(new DateTime(2026, 7, 1, 12, 0, 0), "Europe/Oslo");

        Assert.Equal(new DateTime(2026, 7, 1, 10, 0, 0, DateTimeKind.Utc), utc);
    }

    [Fact] // the clocks jump from 02:00 CET to 03:00 CEST at 01:00Z on 29 March, so 02:30 does not exist
    public void ToUtc_moves_a_time_in_the_spring_forward_gap_forward_by_the_whole_gap()
    {
        var utc = LocalTime.ToUtc(new DateTime(2026, 3, 29, 2, 30, 0), "Europe/Oslo");

        // 02:30 + one hour of gap is 03:30 CEST, which is 01:30Z.
        Assert.Equal(new DateTime(2026, 3, 29, 1, 30, 0, DateTimeKind.Utc), utc);
        Assert.Equal(new DateTime(2026, 3, 29, 3, 30, 0), LocalTime.ToLocal(utc, "Europe/Oslo"));
    }

    [Fact] // the clocks go back from 03:00 CEST to 02:00 CET at 01:00Z on 25 October, so 02:30 happens twice
    public void ToUtc_takes_the_first_occurrence_of_an_ambiguous_time()
    {
        var utc = LocalTime.ToUtc(new DateTime(2026, 10, 25, 2, 30, 0), "Europe/Oslo");

        // The first 02:30 is CEST (UTC+2) = 00:30Z; the second, CET (UTC+1), would be 01:30Z.
        Assert.Equal(new DateTime(2026, 10, 25, 0, 30, 0, DateTimeKind.Utc), utc);
    }
}
