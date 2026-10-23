namespace Sporer.Api.Features.Day;

/// <summary>The stretch of UTC time a local calendar day covers.</summary>
internal static class DaySpan
{
    /// <summary>
    /// How far a local day can reach past the same date in UTC: zones run from UTC-12 to UTC+14, so a day anywhere starts
    /// no earlier than 14 hours before the date's UTC midnight and ends no later than 14 hours after the next one.
    /// </summary>
    private static readonly TimeSpan MaxOffset = TimeSpan.FromHours(14);

    /// <summary>
    /// Local midnight to the next local midnight of <paramref name="date"/> in <paramref name="ianaZone"/>, as UTC (the end
    /// is exclusive). A day is 23 or 25 hours long where the clocks change. Without a zone, or one the system does not
    /// know, the span is the widest any zone could give: it errs on the side of calling a day still open.
    /// </summary>
    public static (DateTime FromUtc, DateTime ToUtc) Of(DateOnly date, string? ianaZone)
    {
        var midnight = date.ToDateTime(TimeOnly.MinValue).Ticks;
        if (ianaZone is not null && TryFindZone(ianaZone) is { } zone)
        {
            try
            {
                return (LocalToUtc(midnight, zone), LocalToUtc(midnight + TimeSpan.TicksPerDay, zone));
            }
            catch (ArgumentException)
            {
                // A date at the very edge of what DateTime holds: the saturated span below is what is left to say.
            }
        }

        return (Utc(midnight - MaxOffset.Ticks), Utc(midnight + TimeSpan.TicksPerDay + MaxOffset.Ticks));
    }

    private static TimeZoneInfo? TryFindZone(string ianaZone)
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(ianaZone);
        }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            return null;
        }
    }

    /// <summary>
    /// The UTC instant of a local wall-clock time. A midnight that does not exist (the clocks jump over it) is the first
    /// hour after the jump; one that happens twice (the clocks fall back across it) is its first time.
    /// </summary>
    private static DateTime LocalToUtc(long localTicks, TimeZoneInfo zone)
    {
        var local = new DateTime(Math.Clamp(localTicks, DateTime.MinValue.Ticks, DateTime.MaxValue.Ticks), DateTimeKind.Unspecified);
        if (zone.IsInvalidTime(local))
            local = local.AddHours(1);

        var offset = zone.IsAmbiguousTime(local) ? zone.GetAmbiguousTimeOffsets(local).Max() : zone.GetUtcOffset(local);
        return Utc(local.Ticks - offset.Ticks);
    }

    /// <summary>A UTC time at <paramref name="ticks"/>, held to the range <see cref="DateTime"/> can represent.</summary>
    private static DateTime Utc(long ticks) => new(Math.Clamp(ticks, DateTime.MinValue.Ticks, DateTime.MaxValue.Ticks), DateTimeKind.Utc);
}
