using System.Globalization;
using Sporer.Timeline;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// What the trips list and a trip's own page share when they put a trip into words and numbers: the fields every trip has
/// (<see cref="Summary"/>), the way a date is written and the way a line is. The two endpoints make them here, once, so that
/// the page cannot say of a trip anything the list does not.
/// </summary>
internal static class TripMapping
{
    /// <summary>
    /// The fields of <paramref name="trip"/> as a list item and the trip's page both have them, with its name and cities made
    /// from its known <paramref name="nights"/> (see <see cref="TripNaming"/>).
    /// </summary>
    public static TripSummary Summary(DetectedTrip trip, IReadOnlyList<TripNight> nights) => new(
        Text(trip.FirstNight),
        TripNaming.Name([.. nights.Select(n => (n.Date, n.City, n.Country))]),
        Text(trip.FirstNight),
        Text(trip.LastNight),
        trip.Nights,
        trip.StartUtc,
        trip.EndUtc,
        trip.StartZone,
        trip.EndZone,
        Text(trip.LocalStartDate),
        Text(trip.LocalEndDate),
        trip.EndUtc is null,
        [.. TripNaming.Cities(nights).Select(c => new TripCityDto(c.Name, c.Country, c.Nights, c.Latitude, c.Longitude))]);

    /// <summary>A date as the API writes it, <c>yyyy-MM-dd</c>.</summary>
    public static string Text(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>A line as <c>[[lon,lat],...]</c>, the order the stored lines and GeoJSON have.</summary>
    public static double[][] LonLat(IReadOnlyList<GeoPoint> line) => [.. line.Select(p => new[] { p.Longitude, p.Latitude })];
}
