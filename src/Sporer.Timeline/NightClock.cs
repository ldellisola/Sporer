namespace Sporer.Timeline;

/// <summary>
/// The instant a night is located at: 03:00 local time on the day after its evening (spec 6.6), in the zone the
/// person was in then. A night belongs to the date of its evening, so the night of 22 October is read at 03:00 on
/// 23 October.
/// </summary>
public static class NightClock
{
    /// <summary>
    /// The UTC instant and IANA zone of <paramref name="night"/>, or null when <paramref name="zoneAt"/> knows no zone
    /// for it (no data). <paramref name="zoneAt"/> gives the zone the person was in at a UTC instant, or null.
    /// </summary>
    /// <remarks>
    /// The zone depends on the instant and the instant on the zone, so this settles it in two steps at most: guess by
    /// reading 03:00 as if it were UTC, convert at the zone found there, and read the zone again at the result. If the
    /// zone is the same the answer stands; otherwise 03:00 is converted once more at the zone found there and that is
    /// final. Zones are hours apart, so the guess is close enough that this matters only around a flight.
    /// </remarks>
    public static (DateTime InstantUtc, string Zone)? InstantOf(DateOnly night, Func<DateTime, string?> zoneAt, int hour)
    {
        var day = night.AddDays(1);
        var local = day.ToDateTime(new TimeOnly(hour, 0));

        var firstZone = zoneAt(day.ToDateTime(new TimeOnly(hour, 0), DateTimeKind.Utc));
        if (firstZone is null) return null;

        var first = LocalTime.ToUtc(local, firstZone);
        var secondZone = zoneAt(first) ?? firstZone;
        if (secondZone == firstZone) return (first, firstZone);

        return (LocalTime.ToUtc(local, secondZone), secondZone);
    }
}
