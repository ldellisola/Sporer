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
}
