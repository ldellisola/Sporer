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
}
