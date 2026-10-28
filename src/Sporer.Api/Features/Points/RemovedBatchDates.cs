namespace Sporer.Api.Features.Points;

/// <summary>Which local days the points of a removal were on.</summary>
internal static class RemovedBatchDates
{
    private static readonly TimeSpan HalfDay = TimeSpan.FromHours(12);

    /// <summary>The time of day after which a point can be the next local day's: zones reach 14 hours ahead of UTC.</summary>
    private static readonly TimeSpan NextDayFrom = TimeSpan.FromHours(24 - 14);

    /// <summary>
    /// The local dates whose points (<c>GET /api/day/{date}/points</c>) include one of <paramref name="timesUtc"/> (oldest first), oldest date
    /// first. <paramref name="spanOf"/> says what a date is: the time from its start to its end, the end exclusive (see
    /// <see cref="Sporer.Api.Features.Day.DayZone.FindPointSpanAsync"/>). A day is at most 14 hours ahead of UTC and 12 behind, so a time can only be on the UTC date it
    /// is on, the day before (before noon) or the day after (from 10:00): those are the dates asked about, once each, however many times there are.
    /// </summary>
    public static async Task<IReadOnlyList<DateOnly>> OfAsync(
        IReadOnlyList<DateTime> timesUtc, Func<DateOnly, Task<(DateTime FromUtc, DateTime ToUtc)>> spanOf)
    {
        var candidates = new SortedSet<DateOnly>();
        foreach (var time in timesUtc)
        {
            var utcDate = DateOnly.FromDateTime(time);
            candidates.Add(utcDate);
            if (time.TimeOfDay < HalfDay && utcDate > DateOnly.MinValue)
                candidates.Add(utcDate.AddDays(-1));
            if (time.TimeOfDay >= NextDayFrom && utcDate < DateOnly.MaxValue)
                candidates.Add(utcDate.AddDays(1));
        }

        var dates = new List<DateOnly>();
        foreach (var date in candidates)
        {
            var (fromUtc, toUtc) = await spanOf(date);
            if (AnyIn(timesUtc, fromUtc, toUtc))
                dates.Add(date);
        }

        return dates;
    }

    /// <summary>Whether one of <paramref name="sorted"/> is at or after <paramref name="fromUtc"/> and before <paramref name="toUtc"/>: the first that is not before it, by bisection, is before the end.</summary>
    private static bool AnyIn(IReadOnlyList<DateTime> sorted, DateTime fromUtc, DateTime toUtc)
    {
        int low = 0, high = sorted.Count;
        while (low < high)
        {
            var middle = low + (high - low) / 2;
            if (sorted[middle] < fromUtc)
                low = middle + 1;
            else
                high = middle;
        }

        return low < sorted.Count && sorted[low] < toUtc;
    }
}
