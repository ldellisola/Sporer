using Microsoft.Extensions.DependencyInjection;
using Sporer.Api.Features.Trips;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// Writes the nights, homes and trips of the trip endpoints' tests as a refresh writes them, and the places the answers are
/// read from, so that each test says exactly what the tables hold. The nights are all read in <c>Europe/Lisbon</c> at
/// 03:00 local time, whatever the trip's own zones say.
/// </summary>
public static class TripSeeder
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public static DateTime Utc(int month, int day, int hour = 0, int minute = 0) => new(2026, month, day, hour, minute, 0, DateTimeKind.Utc);

    public static DateOnly D(int month, int day) => new(2026, month, day);

    /// <summary>
    /// A place of the stored timeline, at the given position, with the geocoder's city and country and the names (OpenStreetMap's
    /// and the owner's) if it has any.
    /// </summary>
    public static Task<long> PlaceAsync(
        string cs, GeoPoint at, string? city = null, string? country = null, long? mergedInto = null, string? osmName = null,
        string? userName = null)
        => TimelineSeeder.InsertPlaceAsync(
            cs, userName: userName, osmName: osmName, city: city, country: country, lat: at.Latitude, lon: at.Longitude, mergedInto: mergedInto);

    private static DateTime InstantOf(DateOnly night) => new DateTime(night.Year, night.Month, night.Day, 2, 0, 0, DateTimeKind.Utc).AddDays(1);

    /// <summary>A night located by a stay at a place, at the stay's own position.</summary>
    public static (Night, string) Stay(DateOnly date, long place, GeoPoint at)
        => (new Night(date, InstantOf(date), "Europe/Lisbon", place, at), "stay");

    /// <summary>A night located by a point that matched no place.</summary>
    public static (Night, string) Point(DateOnly date, GeoPoint at)
        => (new Night(date, InstantOf(date), "Europe/Lisbon", null, at), "point");

    /// <summary>A night with no position: nothing was near enough.</summary>
    public static (Night, string) Unknown(DateOnly date)
        => (new Night(date, InstantOf(date), "Europe/Lisbon", null, null), "none");

    /// <summary>
    /// A trip from <paramref name="first"/> to <paramref name="last"/> night, which left at <paramref name="start"/> and came back
    /// at <paramref name="end"/> (null: it is ongoing). The local dates are those of the start and end in the zones, and of an
    /// ongoing trip the end is the day after its last night.
    /// </summary>
    public static DetectedTrip Trip(DateOnly first, DateOnly last, DateTime start, DateTime? end, string startZone = "Europe/Oslo", string endZone = "Europe/Oslo")
        => new(first, last, last.DayNumber - first.DayNumber + 1, start, end, startZone, endZone, LocalTime.LocalDate(start, startZone),
            end is { } over ? LocalTime.LocalDate(over, endZone) : last.AddDays(1));

    /// <summary>Writes nights, homes and trips together, as the refresh does.</summary>
    public static Task StoreAsync(
        ApiFactory api, IReadOnlyList<(Night, string)> nights, IReadOnlyList<HomePeriod> homes, params DetectedTrip[] trips)
        => api.Services.GetRequiredService<TripStore>().ReplaceAllAsync(
            nights.Count == 0 ? D(1, 1) : nights.Min(n => n.Item1.Date), nights.Count == 0 ? D(1, 1) : nights.Max(n => n.Item1.Date),
            nights, homes, trips, Ct);
}
