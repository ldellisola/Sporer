namespace Sporer.Timeline;

/// <summary>
/// Finds the periods during which each place was home (spec 6.6). Home must not flip during a long trip, so a place
/// becomes home only once it is the night location on at least <see cref="DetectionOptions.HomeMinNights"/> of the
/// last <see cref="DetectionOptions.HomeWindowNights"/> calendar nights (60 of 90). A stay below the bar stays a trip.
/// </summary>
/// <remarks>
/// A home is the owner's home, not one place id: GPS drift can split it into several places a hundred metres or so apart
/// (a stay matches a place within <see cref="DetectionOptions.PlaceRadiusMeters"/> or makes its own). The nights of
/// every place within <see cref="DetectionOptions.HomeRadiusMeters"/> of a candidate therefore count for the candidate.
/// </remarks>
public static class HomeDetector
{
    /// <summary>
    /// The home periods over <paramref name="nights"/>, in date order, one night per date. Each period is backdated to
    /// its first night in the window that earned it, so moving house is noticed late but recorded from the right night;
    /// the first home ever starts at the first night of the history, and the last period stays open.
    /// </summary>
    /// <param name="nights">One night per date.</param>
    /// <param name="placePositions">
    /// The position of each place the nights are at. A place missing here has no known position: it counts only for itself,
    /// and no other place counts for it.
    /// </param>
    /// <remarks>
    /// <para>
    /// Nights are counted by calendar date: a date with no night and a night without a position are unknown nights. A
    /// night whose position is at no place is known, but it counts for no place here; trip detection treats it by its
    /// distance from home. The window is counted afresh for every date, which is plenty for a few thousand nights.
    /// </para>
    /// <para>
    /// The candidates are the places of the window's nights. A candidate's count is the number of nights in the window at
    /// the candidate or at a place within <see cref="DetectionOptions.HomeRadiusMeters"/> of it, and its earliest night is
    /// the earliest of those. The best candidate has the most counted nights; a tie goes to the one with more nights at
    /// the place itself, then to the lower id. With the places grouped like this, the groups of two candidates can overlap
    /// and both pass the bar, so the bar alone does not choose: the tie-break does, and so does the rule that a fragment of
    /// the current home never starts a period.
    /// </para>
    /// <para>
    /// A new period starts only when the best count is at least <see cref="DetectionOptions.HomeMinNights"/>, the best is
    /// not the current home, and it is farther than <see cref="DetectionOptions.HomeRadiusMeters"/> from the current home.
    /// A place near the current home is the same home and starts nothing, however many of the nights it has, so the home
    /// does not flip between the fragments of one house. Two homes closer than the radius are one home. So can two homes up
    /// to about twice the radius apart: when a fragment of the new home lies within the radius of the old one, its group
    /// includes the old home and the rest of the new one, so it can be the best candidate every time and, being near the
    /// current home, never starts a period: the move is not detected. Trips are unaffected (that is far below
    /// <see cref="DetectionOptions.TripMinDistanceKm"/>), and a home override (planned) will cover it.
    /// </para>
    /// <para>
    /// The places near each other are worked out once, before the dates are walked, and not for each date.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<HomePeriod> Detect(
        IReadOnlyList<Night> nights, IReadOnlyDictionary<long, GeoPoint> placePositions, DetectionOptions options)
    {
        if (nights.Count == 0) return [];

        var placeOn = new Dictionary<DateOnly, long>();
        foreach (var night in nights)
            if (night.Position is not null && night.PlaceId is { } id)
                placeOn[night.Date] = id;

        var near = NearPlaces(placeOn.Values.Distinct(), placePositions, options.HomeRadiusMeters);

        var first = nights.Min(n => n.Date);
        var last = nights.Max(n => n.Date);
        var window = options.HomeWindowNights;

        var periods = new List<HomePeriod>();
        long? current = null;
        var currentFrom = first;
        var own = new Dictionary<long, (int Nights, DateOnly Earliest)>();

        for (var date = first; date <= last; date = date.AddDays(1))
        {
            // The window's nights per place, oldest first so that the first one seen is the earliest.
            own.Clear();
            for (var back = window - 1; back >= 0; back--)
            {
                var night = date.AddDays(-back);
                if (!placeOn.TryGetValue(night, out var place)) continue;
                own[place] = own.TryGetValue(place, out var seen) ? (seen.Nights + 1, seen.Earliest) : (1, night);
            }
            if (own.Count == 0) continue;

            // Each candidate counts the nights at the places near it too. Most counted wins; then most at the place itself; then the
            // lower id (the order of the dictionary decides nothing).
            (long Place, int Counted, int Own, DateOnly Earliest)? best = null;
            foreach (var (place, mine) in own)
            {
                var counted = mine.Nights;
                var earliest = mine.Earliest;
                foreach (var neighbour in near[place])
                {
                    if (!own.TryGetValue(neighbour, out var theirs)) continue;
                    counted += theirs.Nights;
                    if (theirs.Earliest < earliest) earliest = theirs.Earliest;
                }

                if (best is not { } b || counted > b.Counted
                    || (counted == b.Counted && (mine.Nights > b.Own || (mine.Nights == b.Own && place < b.Place))))
                    best = (place, counted, mine.Nights, earliest);
            }

            var winner = best!.Value;
            if (winner.Counted < options.HomeMinNights || winner.Place == current) continue;
            if (current is { } home && near[winner.Place].Contains(home)) continue; // a fragment of the home, not a move

            var start = first;
            if (current is not null)
            {
                // Back to the first night at the new home in the window, but never before the old home's second night.
                var floor = currentFrom.AddDays(1);
                start = winner.Earliest > floor ? winner.Earliest : floor;
                periods[^1] = periods[^1] with { To = start.AddDays(-1) };
            }

            periods.Add(new HomePeriod(winner.Place, start, null));
            current = winner.Place;
            currentFrom = start;
        }

        return periods;
    }

    /// <summary>
    /// For each of <paramref name="places"/>, the other places within <paramref name="radiusMeters"/> of it. A place with no
    /// position has none, and is in no one's set. The places are swept by latitude: the distance between two places is never
    /// less than their difference in latitude, so a place is compared only with the ones close enough in latitude.
    /// </summary>
    private static Dictionary<long, HashSet<long>> NearPlaces(
        IEnumerable<long> places, IReadOnlyDictionary<long, GeoPoint> positions, double radiusMeters)
    {
        var near = places.ToDictionary(place => place, _ => new HashSet<long>());
        var located = near.Keys
            .Where(positions.ContainsKey)
            .Select(place => (Place: place, Point: positions[place]))
            .OrderBy(p => p.Point.Latitude)
            .ToList();

        for (var i = 0; i < located.Count; i++)
        {
            for (var j = i + 1; j < located.Count; j++)
            {
                var northMeters = (located[j].Point.Latitude - located[i].Point.Latitude) * Math.PI / 180 * Geo.EarthRadiusMeters;
                if (northMeters > radiusMeters + 1) break; // every later place is farther north still

                if (Geo.DistanceMeters(located[i].Point, located[j].Point) > radiusMeters) continue;
                near[located[i].Place].Add(located[j].Place);
                near[located[j].Place].Add(located[i].Place);
            }
        }

        return near;
    }
}
