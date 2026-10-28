namespace Sporer.Timeline;

/// <summary>
/// Finds the trips (spec 6.6): maximal runs of consecutive nights spent away from home. A night is away when it is at
/// least <see cref="DetectionOptions.TripMinDistanceKm"/> from the home in effect that night. Unknown nights between two
/// away nights belong to the trip but never start or end one, so every trip is bracketed by known nights at home (or by
/// the edge of the history, which makes it ongoing at the end). The trip itself leaves and returns at the stays near
/// home on either side of those nights, not at the nights.
/// </summary>
public static class TripDetector
{
    /// <summary>
    /// The trips over <paramref name="nights"/>, in date order. Nothing is a trip without a home, because a night with
    /// no home in effect is never away.
    /// </summary>
    /// <param name="nights">One night per date. A date with no night counts as an unknown night.</param>
    /// <param name="homes">
    /// The home periods, as <see cref="HomeDetector"/> finds them (or as the owner set them). Periods should not overlap;
    /// if they do, the first in list order that covers a night is the home in effect that night.
    /// </param>
    /// <param name="placePositions">
    /// The position of each place a home period names. A home whose place is missing here has no known position, so the
    /// nights it covers count as at home: a gap in the data must not invent a trip.
    /// </param>
    /// <param name="stays">
    /// Every stay in time order. They do not overlap, so their ends are in order as well, which lets each search
    /// bisect to its place instead of scanning from the start. They are used only to find when the person left home and
    /// when they came back.
    /// </param>
    /// <remarks>
    /// A trip is cut from the nights in one pass: the latest home night seen is the one it left from, the first home
    /// night after it is the one it returned to. The stay searches look only between those nights, so their windows
    /// never overlap from one trip to the next and the whole run reads each stay a bounded number of times. With no home
    /// night on a side there is nothing to search between: the trip starts at its first away night, or is ongoing.
    /// The leaving is measured from the home in effect on the first away night, and the return from the home in effect on
    /// the night after the trip, which is another home when the person moved while away (a new home is backdated to the
    /// night after it, so the last away night is still away from the old one).
    /// </remarks>
    public static IReadOnlyList<DetectedTrip> Detect(
        IReadOnlyList<Night> nights,
        IReadOnlyList<HomePeriod> homes,
        IReadOnlyDictionary<long, GeoPoint> placePositions,
        IReadOnlyList<StayPosition> stays,
        DetectionOptions options)
    {
        var trips = new List<DetectedTrip>();
        Night? lastHomeNight = null;
        Run? run = null;

        foreach (var night in nights.OrderBy(n => n.Date))
        {
            // An unknown night is bridged inside a run and ignored outside one.
            if (night.Position is not { } position) continue;

            var homeThatNight = HomePositionOn(night.Date, homes, placePositions);
            if (homeThatNight is { } home && FarFrom(position, home, options))
            {
                run = run is null
                    ? new Run(night, home, night, home, lastHomeNight)
                    : run with { Last = night, LastHome = home };
                continue;
            }

            // A night at home, or with no home to be away from, ends the run it finds. It is also the night the next run
            // leaves from.
            if (run is not null) trips.Add(TripOf(run, night, homeThatNight, stays, options));
            run = null;
            lastHomeNight = night;
        }

        if (run is not null) trips.Add(TripOf(run, null, null, stays, options));
        return trips;
    }

    /// <summary>
    /// A run of away nights from <paramref name="First"/> to <paramref name="Last"/>, with the home position each of
    /// those two was measured against, and the home night it left from (null if none came before it).
    /// </summary>
    private sealed record Run(Night First, GeoPoint FirstHome, Night Last, GeoPoint LastHome, Night? Before);

    /// <summary>
    /// The trip of <paramref name="run"/>. <paramref name="after"/> is the night that ended it, with <paramref name="homeAfter"/>
    /// the home in effect on it: the return is measured from there, and not from the home of the last away night, because a
    /// person who moved while away comes back to the new home, which is in effect from the night after the trip. A night after
    /// with no home in effect (or no home of known position) leaves the return to be measured from the home of the last away night.
    /// </summary>
    private static DetectedTrip TripOf(
        Run run, Night? after, GeoPoint? homeAfter, IReadOnlyList<StayPosition> stays, DetectionOptions options)
    {
        var before = run.Before;

        // Leaves when the last stay near home ends; failing that, when the home night before was read.
        var startUtc = before is null
            ? run.First.InstantUtc
            : LastEndNearHome(stays, before.InstantUtc, run.First.InstantUtc, run.FirstHome, options) ?? before.InstantUtc;

        // Returns when the first stay near home begins; failing that, when the home night after was read. Null if none.
        DateTime? endUtc = after is null
            ? null
            : FirstStartNearHome(stays, run.Last.InstantUtc, after.InstantUtc, homeAfter ?? run.LastHome, options) ?? after.InstantUtc;

        var startZone = before?.Zone ?? run.First.Zone;
        var endZone = after?.Zone ?? run.Last.Zone;

        return new DetectedTrip(
            run.First.Date,
            run.Last.Date,
            run.Last.Date.DayNumber - run.First.Date.DayNumber + 1,
            startUtc,
            endUtc,
            startZone,
            endZone,
            LocalTime.LocalDate(startUtc, startZone),
            endUtc is { } end ? LocalTime.LocalDate(end, endZone) : run.Last.Date.AddDays(1));
    }

    /// <summary>
    /// The position of the home in effect on <paramref name="date"/>, or null if no home period covers it or its place
    /// has no known position. Either way the night has no home to be away from.
    /// </summary>
    private static GeoPoint? HomePositionOn(
        DateOnly date, IReadOnlyList<HomePeriod> homes, IReadOnlyDictionary<long, GeoPoint> placePositions)
    {
        foreach (var period in homes)
            if (period.From <= date && (period.To is null || date <= period.To))
                return placePositions.TryGetValue(period.PlaceId, out var position) ? position : null;
        return null;
    }

    /// <summary>
    /// Whether <paramref name="position"/> is away from <paramref name="home"/>: at least the threshold, so a distance
    /// of exactly the threshold is away. A stay is near home when this is false.
    /// </summary>
    private static bool FarFrom(GeoPoint position, GeoPoint home, DetectionOptions options)
        => Geo.DistanceMeters(position, home) / 1000 >= options.TripMinDistanceKm;

    /// <summary>The end of the last stay near <paramref name="home"/> that ends in (<paramref name="since"/>, <paramref name="until"/>].</summary>
    private static DateTime? LastEndNearHome(
        IReadOnlyList<StayPosition> stays, DateTime since, DateTime until, GeoPoint home, DetectionOptions options)
    {
        // The last stay that ends by `until`, then back through the ones that still end after `since`.
        for (var i = CountWhile(stays, s => s.EndUtc <= until) - 1; i >= 0 && stays[i].EndUtc > since; i--)
            if (!FarFrom(stays[i].Position, home, options)) return stays[i].EndUtc;
        return null;
    }

    /// <summary>The start of the first stay near <paramref name="home"/> that starts in [<paramref name="since"/>, <paramref name="until"/>).</summary>
    private static DateTime? FirstStartNearHome(
        IReadOnlyList<StayPosition> stays, DateTime since, DateTime until, GeoPoint home, DetectionOptions options)
    {
        // The first stay that starts at or after `since`, then forward through the ones that still start before `until`.
        for (var i = CountWhile(stays, s => s.StartUtc < since); i < stays.Count && stays[i].StartUtc < until; i++)
            if (!FarFrom(stays[i].Position, home, options)) return stays[i].StartUtc;
        return null;
    }

    /// <summary>
    /// How many stays from the start of the list satisfy <paramref name="holds"/>, by bisection. The list must be split
    /// in two: every stay for which it holds comes before every stay for which it does not.
    /// </summary>
    private static int CountWhile(IReadOnlyList<StayPosition> stays, Func<StayPosition, bool> holds)
    {
        int low = 0, high = stays.Count;
        while (low < high)
        {
            var middle = low + (high - low) / 2;
            if (holds(stays[middle])) low = middle + 1;
            else high = middle;
        }
        return low;
    }
}
