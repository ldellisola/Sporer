namespace Sporer.Api.Features.Trips;

/// <summary>What the stays and moves of a trip add up to: see <see cref="TripDays.Stats"/>.</summary>
public sealed record TripStats(int Flights, int Cities, int Places, double GroundDistanceMeters);

/// <summary>One local day of a trip: see <see cref="TripDays.Days"/>.</summary>
public sealed record TripDay(DateOnly Date, string Description, IReadOnlyList<string> Highlights, double GroundDistanceMeters, int Flights);

/// <summary>
/// The numbers and the days of a trip, worked out from what <see cref="TripStore.FindAsync"/> read, each time they are asked
/// for and never stored, like its name and its cities (see <see cref="TripNaming"/>): a place named since, or merged, changes
/// them without anything being reprocessed.
/// </summary>
public static class TripDays
{
    private const string Flight = "flight";

    /// <summary>The most highlights a day has.</summary>
    private const int MaxHighlights = 3;

    /// <summary>
    /// The numbers of the trip, over the stays and moves of its span (each as a whole, a move that began before the trip counts in
    /// full). <c>Flights</c> counts the moves whose mode is flight. <c>Cities</c> counts the distinct cities the stays were in, a
    /// city being what <see cref="TripNaming.CityKey"/> says (so that a stay with only the country "Singapore" and one in the city
    /// of Singapore are one), and a stay at a place with neither city nor country is in none. <c>Places</c> counts the distinct
    /// places of the stays, after merges; a stay that matched no place has none. <c>GroundDistanceMeters</c> adds up the moves
    /// that are not flights: one whose mode could not be told is not known to be a flight, so it is ground.
    /// </summary>
    public static TripStats Stats(TripDetail detail) => new(
        detail.Moves.Count(m => m.Mode == Flight),
        detail.Stays.Select(s => TripNaming.CityKey(s.City, s.Country)).Where(key => key is not null).Distinct().Count(),
        detail.Stays.Select(s => s.PlaceId).Where(id => id is not null).Distinct().Count(),
        detail.Moves.Where(m => m.Mode != Flight).Sum(m => m.DistanceM));

    /// <summary>
    /// A day for every local date from the trip's local start date to its local end date, in order. The stays and moves of a day
    /// are those of the trip's span that touch the date: <c>local_start_date &lt;= date &lt;= local_end_date</c>, so one across
    /// midnight is in both days. <c>Description</c> is <see cref="TripNaming.DayLine"/> of the stays, in time order.
    /// <c>GroundDistanceMeters</c> adds up the moves that are not flights and start on the date, so that a long drive across
    /// midnight is counted once; <c>Flights</c> counts the flights that touch it. <c>Highlights</c> are described by
    /// <see cref="Highlights"/>.
    /// </summary>
    public static IReadOnlyList<TripDay> Days(TripDetail detail)
    {
        var trip = detail.Trip;
        var days = new List<TripDay>();
        for (var date = trip.LocalStartDate; date <= trip.LocalEndDate; date = date.AddDays(1))
        {
            var stays = detail.Stays.Where(s => Touches(s.LocalStartDate, s.LocalEndDate, date)).ToList();
            var moves = detail.Moves.Where(m => Touches(m.LocalStartDate, m.LocalEndDate, date)).ToList();

            days.Add(new TripDay(
                date,
                TripNaming.DayLine([.. stays.Select(s => (s.City, s.Country, s.PlaceName))], moves.Count > 0),
                Highlights(detail, date, stays),
                moves.Where(m => m.LocalStartDate == date && m.Mode != Flight).Sum(m => m.DistanceM),
                moves.Count(m => m.Mode == Flight)));
        }

        return days;
    }

    /// <summary>
    /// The names of up to <see cref="MaxHighlights"/> places of the day, the one with the most time first, from the
    /// <paramref name="stays"/> that touch it. Only a place with a name counts (the owner's, else OpenStreetMap's). The places
    /// where the night before the date and the night of the date were spent are left out, by the place that survives merges:
    /// the hotel is where the person was most of the time, and is not what the day was about.
    /// </summary>
    /// <remarks>
    /// The time at a place is the sum of its stays, each clipped to the trip's span (a stay that began long before the trip, as a
    /// stay near home can when no stay is found to end it at, has only the hours that are the trip's) and then counted in full on
    /// every date it touches. That is simple rather than exact: a stay across midnight counts for all of its hours on both days
    /// and not for the part of them that is on each. Places of equal time are in the order of their ids, so that the answer, and
    /// with it its tag, is the same each time.
    /// </remarks>
    private static IReadOnlyList<string> Highlights(TripDetail detail, DateOnly date, IReadOnlyList<TripStay> stays)
    {
        var slept = new[] { SleptAt(detail, date.AddDays(-1)), SleptAt(detail, date) };

        return
        [
            .. stays
                .Where(s => s.PlaceId is { } id && !string.IsNullOrWhiteSpace(s.PlaceName) && !slept.Contains(id))
                .GroupBy(s => s.PlaceId!.Value)
                .Select(g => (Id: g.Key, Name: g.First().PlaceName!, Seconds: g.Sum(s => SecondsInSpan(detail, s))))
                .OrderByDescending(place => place.Seconds).ThenBy(place => place.Id)
                .Take(MaxHighlights)
                .Select(place => place.Name),
        ];
    }

    private static long? SleptAt(TripDetail detail, DateOnly night) => detail.SleepPlaces.TryGetValue(night, out var place) ? place : null;

    private static bool Touches(DateOnly localStart, DateOnly localEnd, DateOnly date) => localStart <= date && date <= localEnd;

    /// <summary>The seconds of <paramref name="stay"/> that fall between the start of the trip and the end of its span.</summary>
    private static double SecondsInSpan(TripDetail detail, TripStay stay)
    {
        var from = stay.StartUtc > detail.Trip.StartUtc ? stay.StartUtc : detail.Trip.StartUtc;
        var to = stay.EndUtc < detail.SpanEndUtc ? stay.EndUtc : detail.SpanEndUtc;
        return Math.Max(0, (to - from).TotalSeconds);
    }
}
