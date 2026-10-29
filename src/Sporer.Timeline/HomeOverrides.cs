namespace Sporer.Timeline;

/// <summary>
/// The home periods the owner set (spec 6.6, Plan 4) put over the ones detection found: the homes that trips are measured from.
/// Pure: the detected periods are worked out afresh from the nights each time, and the owner's are put on them each time, so that what
/// the owner said holds across refreshes and rebuilds of the timeline.
/// </summary>
public static class HomeOverrides
{
    /// <summary>
    /// The home periods in effect: those of <paramref name="user"/> as they are, and those of <paramref name="detected"/> where no user
    /// period covers the date, in date order and overlapping nowhere. A detected period that a user period lies inside is split in two,
    /// one that it covers an end of is cut short there, and one that it covers all of is gone. An open user period (no end) runs to the
    /// end of time, and takes every detected period from its start on with it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Whichever of two periods has precedence has the dates they share, and the other is cut around it: a user period before a detected
    /// one, then the one that begins later, then the one that comes later in its list. That is how the stored periods are read everywhere
    /// else (the trips list and the day view), so that what the trips are measured from and what the views show cannot disagree. Detected
    /// periods do not overlap, and the app does not let two user periods, so the last two rules decide nothing in practice: they only
    /// define the result for any input. A period that ends before it begins is no period and is left out.
    /// </para>
    /// <para>
    /// Pieces of one period are not joined again when the periods around them are the same place (a user period that names the home a
    /// detected period already had splits it all the same): a period is a stretch of nights that a trip is measured from, and neither
    /// the trips nor the views need them whole.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<HomePeriod> Apply(IReadOnlyList<HomePeriod> detected, IReadOnlyList<HomePeriod> user)
    {
        // Every period, in the order of precedence: the one that comes first in it keeps its dates, and the ones after it are cut around.
        var ranked = user
            .Select((period, index) => (Period: period, Source: 0, Index: index))
            .Concat(detected.Select((period, index) => (Period: period, Source: 1, Index: index)))
            .Where(p => p.Period.To is not { } to || p.Period.From <= to)
            .OrderBy(p => p.Source)
            .ThenByDescending(p => p.Period.From)
            .ThenByDescending(p => p.Index)
            .Select(p => p.Period)
            .ToList();

        var result = new List<HomePeriod>();
        for (var i = 0; i < ranked.Count; i++)
            result.AddRange(Outside(ranked[i], ranked.Take(i)));

        return [.. result.OrderBy(p => p.From)];
    }

    /// <summary>
    /// The pieces of <paramref name="period"/> that none of <paramref name="cutters"/> covers, earliest first. An open period's last piece
    /// is open when nothing covers its end.
    /// </summary>
    private static IEnumerable<HomePeriod> Outside(HomePeriod period, IEnumerable<HomePeriod> cutters)
    {
        // An open period ends at the last date there is; nothing covers the date after it, so it is never stepped past.
        var end = period.To ?? DateOnly.MaxValue;
        var next = period.From; // the first date not yet looked at, as long as it is not past the end

        foreach (var cutter in cutters.OrderBy(c => c.From))
        {
            var cutterEnd = cutter.To ?? DateOnly.MaxValue;
            if (cutterEnd < next) continue;   // all of it is behind what has been looked at
            if (cutter.From > end) break;     // and this one and every later one are past the end

            if (cutter.From > next)
                yield return new HomePeriod(period.PlaceId, next, cutter.From.AddDays(-1));

            if (cutterEnd >= end) yield break; // it covers the rest of the period
            next = cutterEnd.AddDays(1);
        }

        yield return new HomePeriod(period.PlaceId, next, period.To);
    }
}
