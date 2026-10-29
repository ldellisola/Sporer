namespace Sporer.Timeline;

/// <summary>
/// What the owner changed of a trip that detection found: <paramref name="Name"/> (null: the automatic one), the local dates it begins and
/// ends on (<paramref name="StartDate"/>, <paramref name="EndDate"/>; null: as detected), or that it is <paramref name="Deleted"/>. It is
/// made for the trip whose first night was <paramref name="DetectedId"/> and last night <paramref name="DetectedLastNight"/> when the owner
/// made it, and goes on being the edit of that trip while detection moves its nights a little (see <see cref="TripEdits.Apply"/>).
/// </summary>
public sealed record TripEdit(
    DateOnly DetectedId, DateOnly DetectedLastNight, string? Name, DateOnly? StartDate, DateOnly? EndDate, bool Deleted);

/// <summary>
/// A trip as it is stored and shown once the owner's edits are in: <paramref name="Trip"/> has the dates the edit gave it, if it gave any;
/// <paramref name="Name"/> is the owner's name, null for the automatic one; and <paramref name="DetectedId"/> is the key of its edit, the
/// first night of the trip as detection had it when the edit was made (the trip's own first night where it has no edit).
/// </summary>
public sealed record EditedTrip(DetectedTrip Trip, string? Name, DateOnly DetectedId)
{
    /// <summary>A trip that has no edit: as it was detected, with the automatic name, and its own first night for a key.</summary>
    public static EditedTrip Unedited(DetectedTrip trip) => new(trip, null, trip.FirstNight);
}

/// <summary>
/// The owner's edits of trips (spec 4.5, 6.6), applied to the trips detection found. Pure: detection is worked out afresh from the nights
/// every time the trips are, so what the owner changed is kept as edits and put over what is found, each time.
/// </summary>
public static class TripEdits
{
    /// <summary>
    /// The trips with the <paramref name="edits"/> applied, in the order of their first nights.
    /// </summary>
    /// <param name="trips">The detected trips.</param>
    /// <param name="edits">The owner's edits, one for each <see cref="TripEdit.DetectedId"/>.</param>
    /// <param name="zoneAt">
    /// The IANA zone the night of a date was read in, or null where it is not known (see <see cref="ZoneOfNearestNight"/>). It is asked for
    /// the zone of the night on the start date and of the night on the end date of a trip whose dates were edited (the night of a date is
    /// the one that begins its evening, and is read at 03:00 local time on the next), and where it says nothing the zone the trip was
    /// detected in is used.
    /// </param>
    /// <remarks>
    /// <para>
    /// <b>Which trip an edit is for.</b> The trip whose first night is its <see cref="TripEdit.DetectedId"/>; failing that, the trip that
    /// shares most nights with <c>[DetectedId, DetectedLastNight]</c> (the earlier one, between trips that share as many), so that an edit
    /// still finds its trip when new data moves a night of it. A trip has at most one edit, and the ones keyed by a first night are given
    /// theirs before any is matched by overlap. An edit that matches no trip waits: it changes nothing, and is applied to the trip it
    /// matches if one is detected again.
    /// </para>
    /// <para>
    /// <b>What an edit does.</b> A deleted trip is dropped. A name is carried. A start date makes the date of the trip's first night, and
    /// its start the local midnight that begins that date, in the zone the night of the date was read in. An end date is the day the person
    /// is back, which is a day of the trip: the trip ends at the local midnight that ends that date (the one after it, 17 September 00:00
    /// for an end date of the 16th), in the zone the night of the date was read in, so the day of the journey home, its moves and its
    /// stays, is inside the trip; its local end date is the end date itself; and its last night is the one before. The nights are those from
    /// the first to the last, and a trip that was ongoing and is given an end date no longer is. A date the owner left out is as it was
    /// detected, so a start date alone leaves the end of the trip alone, ongoing or not.
    /// </para>
    /// <para>
    /// <b>What an edit cannot do.</b> New dates are not applied (the name still is) when they would leave the trip with no night or end it
    /// before it began, or when they would make it share a night with another trip, edited or not: trips never overlap, which the ids
    /// (the first nights) depend on. Detection can change what an edit was made against, so the owner's request was fine when it was made
    /// and is not any more. The trips that share a night in that way all go back to their detected dates, and that is repeated until none
    /// does: a trip whose dates were given up may now share a night with another. Trips that merely touch (one is over the day the next
    /// begins) do not share a night, though both of them have that day in their spans: the rule is about nights alone.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<EditedTrip> Apply(
        IReadOnlyList<DetectedTrip> trips, IReadOnlyList<TripEdit> edits, Func<DateOnly, string?> zoneAt)
    {
        var matched = Match(trips, edits);

        var items = new List<Item>();
        for (var i = 0; i < trips.Count; i++)
        {
            if (!matched.TryGetValue(i, out var edit))
            {
                items.Add(new Item(trips[i], trips[i].FirstNight, null, null));
                continue;
            }

            if (edit.Deleted)
                continue;

            items.Add(new Item(trips[i], edit.DetectedId, edit.Name, Redate(trips[i], edit, zoneAt)));
        }

        // Trips that share a night give up the dates they were given, and a trip that has given them up is as it was detected, which may
        // be where another trip was moved to. Every round gives up at least one, so it ends.
        while (items.Where(item => item.Dated is not null && items.Any(other => other != item && Shares(item.Trip, other.Trip))).ToList()
               is { Count: > 0 } conflicting)
        {
            foreach (var item in conflicting)
                item.Dated = null;
        }

        return [.. items.Select(item => new EditedTrip(item.Trip, item.Name, item.DetectedId)).OrderBy(edited => edited.Trip.FirstNight)];
    }

    /// <summary>
    /// The zone of the night nearest to a date, for <see cref="Apply"/>: that of the night of the date itself if there is one, else of the
    /// one the fewest days away (the earlier, between two as far), before the first night and after the last included. Null when there
    /// are no nights.
    /// </summary>
    public static Func<DateOnly, string?> ZoneOfNearestNight(IReadOnlyList<Night> nights)
    {
        var ordered = nights.OrderBy(n => n.Date).ToArray();
        if (ordered.Length == 0)
            return _ => null;

        return date =>
        {
            // The first night on or after the date, and the last one before it.
            int low = 0, high = ordered.Length;
            while (low < high)
            {
                var middle = low + (high - low) / 2;
                if (ordered[middle].Date < date) low = middle + 1;
                else high = middle;
            }

            if (low == ordered.Length) return ordered[^1].Zone;
            if (low == 0) return ordered[0].Zone;

            var (before, after) = (ordered[low - 1], ordered[low]);
            return date.DayNumber - before.Date.DayNumber <= after.Date.DayNumber - date.DayNumber ? before.Zone : after.Zone;
        };
    }

    /// <summary>A trip on its way through <see cref="Apply"/>: <see cref="Dated"/> is the trip with the dates of its edit, null where it has none to give.</summary>
    private sealed class Item(DetectedTrip detected, DateOnly detectedId, string? name, DetectedTrip? dated)
    {
        public DetectedTrip Detected { get; } = detected;
        public DateOnly DetectedId { get; } = detectedId;
        public string? Name { get; } = name;
        public DetectedTrip? Dated { get; set; } = dated;

        /// <summary>The trip as it is: with the edit's dates if they stand, else as detected.</summary>
        public DetectedTrip Trip => Dated ?? Detected;
    }

    /// <summary>The edit of each trip, by the trip's position in <paramref name="trips"/>.</summary>
    private static Dictionary<int, TripEdit> Match(IReadOnlyList<DetectedTrip> trips, IReadOnlyList<TripEdit> edits)
    {
        var matched = new Dictionary<int, TripEdit>();
        var left = new List<TripEdit>();

        // The ones keyed by a first night come first: a trip that has its own edit is not for another to take by overlap.
        foreach (var edit in edits.OrderBy(e => e.DetectedId))
        {
            var index = IndexOfFirstNight(trips, edit.DetectedId);
            if (index >= 0 && !matched.ContainsKey(index))
                matched[index] = edit;
            else
                left.Add(edit);
        }

        foreach (var edit in left)
        {
            var best = -1;
            var most = 0;
            for (var i = 0; i < trips.Count; i++)
            {
                if (matched.ContainsKey(i))
                    continue;

                var shared = SharedNights(trips[i].FirstNight, trips[i].LastNight, edit.DetectedId, edit.DetectedLastNight);
                if (shared > most || (shared == most && shared > 0 && trips[i].FirstNight < trips[best].FirstNight))
                    (best, most) = (i, shared);
            }

            if (best >= 0)
                matched[best] = edit;
        }

        return matched;
    }

    private static int IndexOfFirstNight(IReadOnlyList<DetectedTrip> trips, DateOnly firstNight)
    {
        for (var i = 0; i < trips.Count; i++)
            if (trips[i].FirstNight == firstNight)
                return i;
        return -1;
    }

    /// <summary>How many nights two spans of nights (both ends included) have in common.</summary>
    private static int SharedNights(DateOnly firstA, DateOnly lastA, DateOnly firstB, DateOnly lastB)
        => Math.Max(0, Math.Min(lastA.DayNumber, lastB.DayNumber) - Math.Max(firstA.DayNumber, firstB.DayNumber) + 1);

    private static bool Shares(DetectedTrip a, DetectedTrip b) => SharedNights(a.FirstNight, a.LastNight, b.FirstNight, b.LastNight) > 0;

    /// <summary>
    /// <paramref name="trip"/> with the dates of <paramref name="edit"/>, or null where the edit gives none or they leave the trip with no
    /// night, or with an end that is not after its start.
    /// </summary>
    private static DetectedTrip? Redate(DetectedTrip trip, TripEdit edit, Func<DateOnly, string?> zoneAt)
    {
        if (edit.StartDate is null && edit.EndDate is null)
            return null;

        var moved = trip;
        if (edit.StartDate is { } start)
        {
            var zone = zoneAt(start) ?? trip.StartZone;
            moved = moved with { FirstNight = start, StartUtc = MidnightUtc(start, zone), StartZone = zone, LocalStartDate = start };
        }

        if (edit.EndDate is { } end)
        {
            // It ends where the end date ends: at the midnight after it, in the zone the night of that date was read in (which is read three
            // hours after the instant). The local end date is the date itself, not what the instant gives (that is the day after).
            var zone = zoneAt(end) ?? trip.EndZone;
            moved = moved with { LastNight = end.AddDays(-1), EndUtc = MidnightUtc(end.AddDays(1), zone), EndZone = zone, LocalEndDate = end };
        }

        moved = moved with { Nights = moved.LastNight.DayNumber - moved.FirstNight.DayNumber + 1 };
        return moved.Nights >= 1 && (moved.EndUtc is not { } over || over > moved.StartUtc) ? moved : null;
    }

    private static DateTime MidnightUtc(DateOnly date, string zone) => LocalTime.ToUtc(date.ToDateTime(TimeOnly.MinValue), zone);
}
