namespace Sporer.Timeline;

/// <summary>
/// Finds the periods during which each place was home (spec 6.6). Home must not flip during a long trip, so a place
/// becomes home only once it is the night location on at least <see cref="DetectionOptions.HomeMinNights"/> of the
/// last <see cref="DetectionOptions.HomeWindowNights"/> calendar nights (60 of 90). A stay below the bar stays a trip.
/// </summary>
public static class HomeDetector
{
    /// <summary>
    /// The home periods over <paramref name="nights"/>, in date order, one night per date. Each period is backdated to
    /// the first night of the run that earned it, so moving house is noticed late but recorded from the right night;
    /// the first home ever starts at the first night of the history, and the last period stays open.
    /// </summary>
    /// <remarks>
    /// Nights are counted by calendar date: a date with no night, a night without a position and a night whose position
    /// is at no place are all unknown nights, and count for no place. The window is counted afresh for every date,
    /// which is plenty for a few thousand nights.
    /// </remarks>
    public static IReadOnlyList<HomePeriod> Detect(IReadOnlyList<Night> nights, DetectionOptions options)
    {
        if (nights.Count == 0) return [];

        var placeOn = new Dictionary<DateOnly, long>();
        foreach (var night in nights)
            if (night.Position is not null && night.PlaceId is { } id)
                placeOn[night.Date] = id;

        var first = nights.Min(n => n.Date);
        var last = nights.Max(n => n.Date);
        var window = options.HomeWindowNights;

        var periods = new List<HomePeriod>();
        long? current = null;
        var currentFrom = first;
        var counts = new Dictionary<long, (int Nights, DateOnly Earliest)>();

        for (var date = first; date <= last; date = date.AddDays(1))
        {
            // The window's nights per place, oldest first so that the first one seen is the earliest.
            counts.Clear();
            for (var back = window - 1; back >= 0; back--)
            {
                var night = date.AddDays(-back);
                if (!placeOn.TryGetValue(night, out var place)) continue;
                counts[place] = counts.TryGetValue(place, out var seen) ? (seen.Nights + 1, seen.Earliest) : (1, night);
            }
            if (counts.Count == 0) continue;

            // With the bar above half the window only one place can reach it; a lower id settles a tie otherwise.
            var best = counts.OrderByDescending(c => c.Value.Nights).ThenBy(c => c.Key).First();
            if (best.Value.Nights < options.HomeMinNights || best.Key == current) continue;

            var start = first;
            if (current is not null)
            {
                // Back to the first night at the new home in the window, but never before the old home's second night.
                var floor = currentFrom.AddDays(1);
                start = best.Value.Earliest > floor ? best.Value.Earliest : floor;
                periods[^1] = periods[^1] with { To = start.AddDays(-1) };
            }

            periods.Add(new HomePeriod(best.Key, start, null));
            current = best.Key;
            currentFrom = start;
        }

        return periods;
    }
}
