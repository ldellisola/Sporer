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
    /// The fields of <paramref name="trip"/> as a list item and the trip's page both have them, with its cities made from its known
    /// <paramref name="nights"/> and its name the owner's (<paramref name="name"/>) or, where it has none, made from them too (see
    /// <see cref="DisplayName"/>). <paramref name="edited"/> is whether the trip has an edit.
    /// </summary>
    public static TripSummary Summary(DetectedTrip trip, IReadOnlyList<TripNight> nights, string? name, bool edited) => new(
        Text(trip.FirstNight),
        DisplayName(name, nights),
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
        [.. TripNaming.Cities(nights).Select(c => new TripCityDto(c.Name, c.Country, c.Nights, c.Latitude, c.Longitude))],
        edited);

    /// <summary>
    /// What a trip is called: the owner's <paramref name="name"/> for it, or, where it has none, the one made from its known
    /// <paramref name="nights"/> (see <see cref="TripNaming.Name"/>). It is what the list and the trip's page show, and what a deleted trip
    /// is remembered by.
    /// </summary>
    public static string DisplayName(string? name, IReadOnlyList<TripNight> nights)
        => name ?? TripNaming.Name([.. nights.Select(n => (n.Date, n.City, n.Country))]);

    /// <summary>
    /// Two dates as one span, the way the web writes a trip's dates: "12 – 16 Sep 2026", "28 Sep – 3 Oct 2026" over a month end, "28 Dec 2026
    /// – 3 Jan 2027" over a year end (an en dash with a space on each side), and "12 Sep 2026" for one date. English month names, whatever
    /// the culture of the server is.
    /// </summary>
    public static string DateRange(DateOnly from, DateOnly to)
    {
        var culture = CultureInfo.InvariantCulture;
        if (from == to)
            return to.ToString("d MMM yyyy", culture);
        if (from.Year != to.Year)
            return $"{from.ToString("d MMM yyyy", culture)} – {to.ToString("d MMM yyyy", culture)}";
        if (from.Month == to.Month)
            return $"{from.Day.ToString(culture)} – {to.ToString("d MMM yyyy", culture)}";
        return $"{from.ToString("d MMM", culture)} – {to.ToString("d MMM yyyy", culture)}";
    }

    /// <summary>A date as the API writes it, <c>yyyy-MM-dd</c>.</summary>
    public static string Text(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>A line as <c>[[lon,lat],...]</c>, the order the stored lines and GeoJSON have.</summary>
    public static double[][] LonLat(IReadOnlyList<GeoPoint> line) => [.. line.Select(p => new[] { p.Longitude, p.Latitude })];
}
