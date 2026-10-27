using Sporer.Timeline;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// A night of a trip whose position is known, with the city and country of the place it was spent at: those of the place that
/// survives any merge, null for what the geocoder has not given it yet, and both null for a night that matched no place.
/// </summary>
public sealed record TripNight(DateOnly Date, string? City, string? Country, GeoPoint Position);

/// <summary>
/// A city a trip stayed in, as it is drawn: <paramref name="Name"/> is the city, or the country for nights whose place has no
/// city; <paramref name="Nights"/> counts the known nights spent there, and the position is the mean of theirs.
/// </summary>
public sealed record TripCity(string Name, string? Country, int Nights, double Latitude, double Longitude);

/// <summary>
/// The words of a trip: its name, the label of its length, and the cities it is made of. All of it is worked out from the
/// nights each time it is asked for, never stored, so that a place the geocoder names later, or a merge, changes what a trip
/// is called without anything being reprocessed.
/// </summary>
public static class TripNaming
{
    /// <summary>
    /// What a trip with nothing to name it by (no night has a city or a country, which is how every trip starts until its
    /// places are geocoded) is called.
    /// </summary>
    private const string Unnamed = "Trip";

    /// <summary>
    /// The name of a trip from <paramref name="nights"/>, one entry per night whose position is known, in any order. The nights
    /// are grouped by city and country, the city with the most nights first and, between equals, the one that was slept in
    /// first. One city names the trip ("Lisbon") and so do two ("Lisbon &amp; Porto"). Three or more cities are too many to
    /// list, so the countries, grouped and ordered the same way, name it: "Portugal", "Portugal &amp; Spain", "Portugal, Spain &amp;
    /// France", and from four on "Portugal, Spain &amp; 2 more". A trip with no city at all (nothing geocoded, or only places
    /// outside any town) is named by its countries in the same way, and one with neither is just "Trip". A night whose place
    /// has a country and no city counts for the country, not for a city.
    /// </summary>
    public static string Name(IReadOnlyList<(DateOnly Night, string? City, string? Country)> nights)
    {
        var known = nights.Select(n => (n.Night, City: Clean(n.City), Country: Clean(n.Country))).ToList();

        var cities = Rank(known.Where(n => n.City is not null), n => (n.City, n.Country), n => n.Night);
        if (cities.Count is 1 or 2)
            return string.Join(" & ", cities.Select(c => c.Key.City));

        var countries = Rank(known.Where(n => n.Country is not null), n => n.Country!, n => n.Night);
        return countries.Count switch
        {
            0 => Unnamed,
            1 => countries[0].Key,
            2 => $"{countries[0].Key} & {countries[1].Key}",
            3 => $"{countries[0].Key}, {countries[1].Key} & {countries[2].Key}",
            _ => $"{countries[0].Key}, {countries[1].Key} & {countries.Count - 2} more",
        };
    }

    /// <summary>The length of a trip as the app words it everywhere: "1 night", "4 nights".</summary>
    public static string NightsLabel(int nights) => nights == 1 ? "1 night" : $"{nights} nights";

    /// <summary>
    /// The cities of a trip: its known <paramref name="nights"/> grouped by city and country, in the order a name is built in
    /// (most nights first, then the earlier first night). A night whose place has no city is grouped under its country, and one
    /// with neither is left out: there is nothing to put on the map for it.
    /// </summary>
    public static IReadOnlyList<TripCity> Cities(IReadOnlyList<TripNight> nights)
    {
        var named = nights
            .Select(n => (Night: n, City: Clean(n.City), Country: Clean(n.Country)))
            .Where(n => n.City is not null || n.Country is not null);

        return
        [
            .. Rank(named, n => (n.City, n.Country), n => n.Night.Date).Select(g => new TripCity(
                g.Key.City ?? g.Key.Country!,
                g.Key.Country,
                g.Count(),
                g.Average(n => n.Night.Position.Latitude),
                g.Average(n => n.Night.Position.Longitude))),
        ];
    }

    /// <summary>
    /// <paramref name="items"/> grouped by <paramref name="key"/>, the group with the most items first and, between equal ones,
    /// the group whose earliest item is the earliest.
    /// </summary>
    private static List<IGrouping<TKey, T>> Rank<T, TKey>(IEnumerable<T> items, Func<T, TKey> key, Func<T, DateOnly> date)
        where TKey : notnull
        => [.. items.GroupBy(key).OrderByDescending(g => g.Count()).ThenBy(g => g.Min(date))];

    /// <summary>A city or country the geocoder left empty counts as none.</summary>
    private static string? Clean(string? name) => string.IsNullOrWhiteSpace(name) ? null : name;
}
