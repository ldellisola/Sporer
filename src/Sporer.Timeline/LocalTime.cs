using GeoTimeZone;

namespace Sporer.Timeline;

/// <summary>Local civil time for a place: IANA zone lookup and UTC-to-local conversion.</summary>
public static class LocalTime
{
    /// <summary>The IANA time zone id (for example <c>Europe/Oslo</c>) at a position.</summary>
    public static string TimeZoneAt(GeoPoint p) => TimeZoneLookup.GetTimeZone(p.Latitude, p.Longitude).Result;

    /// <summary>The local wall-clock time in an IANA zone for a UTC instant.</summary>
    public static DateTime ToLocal(DateTime utc, string ianaZone)
        => TimeZoneInfo.ConvertTimeFromUtc(utc, TimeZoneInfo.FindSystemTimeZoneById(ianaZone));

    /// <summary>The local calendar date in an IANA zone for a UTC instant.</summary>
    public static DateOnly LocalDate(DateTime utc, string ianaZone) => DateOnly.FromDateTime(ToLocal(utc, ianaZone));

    /// <summary>
    /// The UTC instant of a local wall-clock time in an IANA zone. Unlike <see cref="TimeZoneInfo"/> it never throws for
    /// a time the clocks skip or repeat. A time that does not exist (the clocks jumped over it) moves forward by the
    /// length of the gap; an ambiguous one (the clocks went back over it) takes its first occurrence.
    /// </summary>
    public static DateTime ToUtc(DateTime local, string ianaZone)
    {
        var zone = TimeZoneInfo.FindSystemTimeZoneById(ianaZone);
        local = DateTime.SpecifyKind(local, DateTimeKind.Unspecified);

        // The offset in force before the jump, read a day earlier (no zone changes its clocks twice in a day). Taking it
        // off the missing local time gives an instant after the jump, where the clocks read that time plus the gap.
        if (zone.IsInvalidTime(local))
            return DateTime.SpecifyKind(local - zone.GetUtcOffset(local.AddDays(-1)), DateTimeKind.Utc);

        // The first of two occurrences is the one with the larger offset, which is the earlier instant.
        if (zone.IsAmbiguousTime(local))
            return DateTime.SpecifyKind(local - zone.GetAmbiguousTimeOffsets(local).Max(), DateTimeKind.Utc);

        return TimeZoneInfo.ConvertTimeToUtc(local, zone);
    }
}
