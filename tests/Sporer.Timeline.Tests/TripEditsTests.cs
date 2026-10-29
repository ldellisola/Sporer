namespace Sporer.Timeline.Tests;

/// <summary>
/// What the owner's edits make of the trips detection found (<see cref="TripEdits"/>): a name, a start date, an end date, or no trip at
/// all. The zones are given by a function of a night's date, so no test needs a night to be stored.
/// </summary>
public class TripEditsTests
{
    private const string Oslo = "Europe/Oslo";
    private const string Lisbon = "Europe/Lisbon";
    private const string Tokyo = "Asia/Tokyo";

    private static DateOnly D(int month, int day) => new(2026, month, day);

    private static DateTime Utc(int month, int day, int hour = 0, int minute = 0) => new(2026, month, day, hour, minute, 0, DateTimeKind.Utc);

    /// <summary>
    /// A trip with nights from <paramref name="first"/> to <paramref name="last"/> that left at 10:00 Oslo time on the date of its first night
    /// and came back at 12:00 on the day after its last (null: it is ongoing, and its end date is the day after its last night).
    /// </summary>
    private static DetectedTrip Trip(DateOnly first, DateOnly last, bool ongoing = false)
    {
        var start = new DateTime(first.Year, first.Month, first.Day, 8, 0, 0, DateTimeKind.Utc);
        var back = last.AddDays(1);
        DateTime? end = ongoing ? null : new DateTime(back.Year, back.Month, back.Day, 10, 0, 0, DateTimeKind.Utc);
        return new DetectedTrip(first, last, last.DayNumber - first.DayNumber + 1, start, end, Oslo, Oslo, first, back);
    }

    private static TripEdit Edit(
        DateOnly detectedId, DateOnly detectedLastNight, string? name = null, DateOnly? start = null, DateOnly? end = null, bool deleted = false)
        => new(detectedId, detectedLastNight, name, start, end, deleted);

    /// <summary>The zones of the nights of the trips of a test: Lisbon for the 11th to the 14th, Tokyo from the 15th, Oslo for any other.</summary>
    private static string? ZoneAt(DateOnly night) => night.Day switch
    {
        >= 11 and <= 14 => Lisbon,
        >= 15 => Tokyo,
        _ => Oslo,
    };

    [Fact]
    public void TripEdits_rename_keeps_dates()
    {
        var detected = Trip(D(9, 12), D(9, 13));

        var edited = Assert.Single(TripEdits.Apply([detected], [Edit(D(9, 12), D(9, 13), name: "Lisbon weekend")], ZoneAt));

        Assert.Equal(detected, edited.Trip);
        Assert.Equal("Lisbon weekend", edited.Name);
        Assert.Equal(D(9, 12), edited.DetectedId);
    }

    [Fact]
    public void TripEdits_without_an_edit_leave_a_trip_as_it_was()
    {
        var detected = Trip(D(9, 12), D(9, 13));

        var edited = Assert.Single(TripEdits.Apply([detected], [], ZoneAt));

        Assert.Equal(detected, edited.Trip);
        Assert.Null(edited.Name);
        Assert.Equal(D(9, 12), edited.DetectedId);
    }

    [Fact]
    public void TripEdits_dates_move_the_span_to_local_midnights_in_their_zones()
    {
        var detected = Trip(D(9, 12), D(9, 13));

        // From the 11th to the 16th: the last night is the 15th. The trip begins at the midnight that begins the 11th, which ends the night of the
        // 10th, so it is in the zone that night was read in (Oslo, UTC+2 in September: where the person slept before it). The 16th is the day
        // the person is back, so the trip is over when it ends: at the midnight after it, in the zone the night of the 16th was read in (Tokyo,
        // UTC+9), which is read three hours after it. Its local end date is the 16th, not the 17th that the instant is on.
        var edited = Assert.Single(TripEdits.Apply([detected], [Edit(D(9, 12), D(9, 13), start: D(9, 11), end: D(9, 16))], ZoneAt));

        Assert.Equal(
            new DetectedTrip(
                FirstNight: D(9, 11), LastNight: D(9, 15), Nights: 5,
                StartUtc: Utc(9, 10, 22), EndUtc: Utc(9, 16, 15),
                StartZone: Oslo, EndZone: Tokyo,
                LocalStartDate: D(9, 11), LocalEndDate: D(9, 16)),
            edited.Trip);
        Assert.Equal(D(9, 12), edited.DetectedId); // it is still the edit of the trip detected on the 12th
    }

    [Fact]
    public void TripEdits_an_end_date_alone_ends_the_trip_and_a_start_date_alone_leaves_the_end_as_it_was()
    {
        var ongoing = Trip(D(9, 12), D(9, 13), ongoing: true);

        // An end date makes an ongoing trip one that is over.
        var ended = Assert.Single(TripEdits.Apply([ongoing], [Edit(D(9, 12), D(9, 13), end: D(9, 14))], ZoneAt));
        Assert.Equal(Utc(9, 14, 23), ended.Trip.EndUtc); // 15 September 00:00 in Lisbon (the night of the 14th was read there), one hour east of UTC
        Assert.Equal(Lisbon, ended.Trip.EndZone);
        Assert.Equal(D(9, 14), ended.Trip.LocalEndDate);
        Assert.Equal(D(9, 13), ended.Trip.LastNight);
        Assert.Equal(ongoing.StartUtc, ended.Trip.StartUtc); // the start is as it was detected
        Assert.Equal(ongoing.StartZone, ended.Trip.StartZone);

        // A start date alone moves only the start: it is still ongoing, with the end date the day after its last night.
        var restarted = Assert.Single(TripEdits.Apply([ongoing], [Edit(D(9, 12), D(9, 13), start: D(9, 11))], ZoneAt));
        Assert.Null(restarted.Trip.EndUtc);
        Assert.Equal(D(9, 14), restarted.Trip.LocalEndDate);
        Assert.Equal((D(9, 11), D(9, 13), 3), (restarted.Trip.FirstNight, restarted.Trip.LastNight, restarted.Trip.Nights));
        Assert.Equal(Utc(9, 10, 22), restarted.Trip.StartUtc); // 11 September 00:00 in Oslo (the night of the 10th was read there)
    }

    [Fact]
    public void TripEdits_use_the_zone_the_trip_was_detected_in_when_no_night_has_one()
    {
        var detected = Trip(D(9, 12), D(9, 13));

        var edited = Assert.Single(TripEdits.Apply([detected], [Edit(D(9, 12), D(9, 13), start: D(9, 11), end: D(9, 15))], _ => null));

        Assert.Equal((Oslo, Oslo), (edited.Trip.StartZone, edited.Trip.EndZone));
        Assert.Equal(Utc(9, 10, 22), edited.Trip.StartUtc); // Oslo is UTC+2 in September
        Assert.Equal(Utc(9, 15, 22), edited.Trip.EndUtc); // 16 September 00:00
    }

    [Fact]
    public void TripEdits_a_start_on_a_day_of_travel_begins_at_midnight_where_the_person_slept_the_night_before()
    {
        var detected = Trip(D(9, 16), D(9, 18));
        // The person flies east on the 14th: the night of the 14th (read at 03:00 on the 15th) is in Oslo, the night of the 15th in Tokyo.
        string? Eastbound(DateOnly night) => night <= D(9, 14) ? Oslo : Tokyo;

        // The trip is to begin on the 15th. The midnight that begins the 15th ends the night of the 14th, which was spent in Oslo, and it is
        // 00:00 there (22:00Z on the 14th), not 00:00 in Tokyo (15:00Z on the 14th), which is where the night of the 15th was.
        var edited = Assert.Single(TripEdits.Apply([detected], [Edit(D(9, 16), D(9, 18), start: D(9, 15))], Eastbound));

        Assert.Equal((Utc(9, 14, 22), Oslo), (edited.Trip.StartUtc, edited.Trip.StartZone));
        Assert.Equal(D(9, 15), edited.Trip.LocalStartDate);
        Assert.Equal(D(9, 15), edited.Trip.FirstNight);

        // The end is the other way round: it is where the night of the end date was spent, read three hours after the midnight that ends the day.
        var early = Trip(D(9, 10), D(9, 12));
        var back = Assert.Single(TripEdits.Apply([early], [Edit(D(9, 10), D(9, 12), end: D(9, 14))], Eastbound));
        Assert.Equal((Utc(9, 14, 22), Oslo), (back.Trip.EndUtc, back.Trip.EndZone)); // 15 September 00:00 in Oslo
        var away = Assert.Single(TripEdits.Apply([early], [Edit(D(9, 10), D(9, 12), end: D(9, 17))], Eastbound));
        Assert.Equal((Utc(9, 17, 15), Tokyo), (away.Trip.EndUtc, away.Trip.EndZone)); // 18 September 00:00 in Tokyo
    }

    [Fact]
    public void TripEdits_a_midnight_the_clocks_skip_moves_forward_by_the_gap()
    {
        // Chile puts its clocks forward at midnight on the first Sunday of September: 00:00 on 6 September 2026 does not exist, and 23:59 on
        // the 5th (UTC-4) is followed by 01:00 (UTC-3). A trip that begins that day begins when the day does, which is 01:00.
        const string Santiago = "America/Santiago";
        var detected = Trip(D(9, 8), D(9, 9));

        var edited = Assert.Single(TripEdits.Apply([detected], [Edit(D(9, 8), D(9, 9), start: D(9, 6))], _ => Santiago));
        Assert.Equal(Utc(9, 6, 4), edited.Trip.StartUtc); // 04:00Z is 01:00 at UTC-3, the first moment of the 6th
        Assert.Equal(D(9, 6), LocalTime.LocalDate(edited.Trip.StartUtc, Santiago));

        // And the same for the end: the trip that is over when the 6th begins is over at 01:00, the instant after the gap.
        var early = Trip(D(9, 1), D(9, 2));
        var over = Assert.Single(TripEdits.Apply([early], [Edit(D(9, 1), D(9, 2), end: D(9, 5))], _ => Santiago));
        Assert.Equal(Utc(9, 6, 4), over.Trip.EndUtc);
        Assert.Equal(D(9, 5), over.Trip.LocalEndDate);

        // The days around it are as ordinary: 00:00 on the 8th is at UTC-3.
        var after = Assert.Single(TripEdits.Apply([detected], [Edit(D(9, 8), D(9, 9), start: D(9, 7))], _ => Santiago));
        Assert.Equal(Utc(9, 7, 3), after.Trip.StartUtc);
    }

    [Fact]
    public void TripEdits_delete_drops_the_trip()
    {
        var kept = Trip(D(9, 1), D(9, 2));
        var gone = Trip(D(9, 12), D(9, 13));

        var edited = TripEdits.Apply([kept, gone], [Edit(D(9, 12), D(9, 13), name: "Not mine", deleted: true)], ZoneAt);

        Assert.Equal([kept], edited.Select(e => e.Trip));
    }

    [Fact]
    public void TripEdits_fall_back_to_the_largest_overlap_when_detection_moves_a_night()
    {
        // The edit was made when the trip's nights were the 12th to the 14th. Detection now finds the 10th to the 12th (one night in
        // common) and the 13th to the 20th (two in common), and the edit goes to the second.
        var first = Trip(D(9, 10), D(9, 12));
        var second = Trip(D(9, 13), D(9, 20));

        var edited = TripEdits.Apply([first, second], [Edit(D(9, 12), D(9, 14), name: "Moved")], ZoneAt);

        Assert.Equal([null, "Moved"], edited.Select(e => e.Name));
        Assert.Equal([D(9, 10), D(9, 12)], edited.Select(e => e.DetectedId)); // it keeps the key it was made with
        Assert.Equal([first, second], edited.Select(e => e.Trip)); // and the dates are those detected
    }

    [Fact]
    public void TripEdits_a_deletion_found_by_overlap_needs_more_than_half_of_the_trip_it_deletes()
    {
        // A, five nights, was deleted; B, five more before it, was kept. Detection now finds one trip of the ten, which begins where B did:
        // the deletion has half of its nights and no more, so it is not for that trip, which is kept (and the deletion waits).
        var merged = Trip(D(9, 1), D(9, 10));
        var deletion = Edit(D(9, 6), D(9, 10), name: "Not mine", deleted: true);

        var kept = Assert.Single(TripEdits.Apply([merged], [deletion], ZoneAt));
        Assert.Equal(merged, kept.Trip);
        Assert.Null(kept.Name);

        // With the nights it has in common more than half of the trip's (6 of 10), it is that trip's deletion.
        Assert.Empty(TripEdits.Apply([merged], [Edit(D(9, 5), D(9, 10), deleted: true)], ZoneAt));

        // What is not a deletion goes to the trip it overlaps most, however little of it that is: a name is no loss.
        var renamed = Assert.Single(TripEdits.Apply([merged], [Edit(D(9, 6), D(9, 10), name: "Second half")], ZoneAt));
        Assert.Equal("Second half", renamed.Name);

        // And an edit made for the trip's own first night is its edit whatever else is in the trip now.
        Assert.Empty(TripEdits.Apply([merged], [Edit(D(9, 1), D(9, 2), deleted: true)], ZoneAt));
    }

    [Fact]
    public void TripEdits_a_deleted_trip_that_drifted_by_a_night_is_still_deleted()
    {
        var deletion = Edit(D(9, 12), D(9, 16), deleted: true); // five nights

        // A night earlier (five of its six nights are the deleted trip's), and a night later (four of five).
        Assert.Empty(TripEdits.Apply([Trip(D(9, 11), D(9, 16))], [deletion], ZoneAt));
        Assert.Empty(TripEdits.Apply([Trip(D(9, 13), D(9, 17))], [deletion], ZoneAt));

        // The trip beside it is another trip.
        var other = Trip(D(9, 20), D(9, 22));
        var remaining = Assert.Single(TripEdits.Apply([Trip(D(9, 13), D(9, 17)), other], [deletion], ZoneAt));
        Assert.Equal(other, remaining.Trip);
    }

    [Fact]
    public void TripEdits_a_trip_takes_the_edit_made_for_its_first_night_before_one_that_overlaps_it()
    {
        // Both edits overlap the second trip most, but the first is keyed by that trip's first night, so the second goes to the first trip.
        var first = Trip(D(9, 10), D(9, 12));
        var second = Trip(D(9, 13), D(9, 20));

        var edited = TripEdits.Apply(
            [first, second], [Edit(D(9, 12), D(9, 14), name: "Overlaps"), Edit(D(9, 13), D(9, 20), name: "Exact")], ZoneAt);

        Assert.Equal(["Overlaps", "Exact"], edited.Select(e => e.Name));
        Assert.Equal([D(9, 12), D(9, 13)], edited.Select(e => e.DetectedId));
    }

    [Fact]
    public void TripEdits_one_edit_per_trip_and_one_trip_per_edit()
    {
        var only = Trip(D(9, 10), D(9, 20));

        // Two edits for the one trip: the one keyed by its first night has it, and the other, with nothing left to overlap, waits.
        var edited = Assert.Single(TripEdits.Apply(
            [only], [Edit(D(9, 15), D(9, 18), name: "Overlaps"), Edit(D(9, 10), D(9, 20), name: "Exact")], ZoneAt));
        Assert.Equal("Exact", edited.Name);

        // One edit over two trips changes one of them, the one it overlaps most.
        var (a, b) = (Trip(D(9, 10), D(9, 12)), Trip(D(9, 14), D(9, 20)));
        var both = TripEdits.Apply([a, b], [Edit(D(9, 11), D(9, 17), name: "One")], ZoneAt);
        Assert.Equal([null, "One"], both.Select(e => e.Name)); // 2 nights in common with the first trip, 4 with the second
    }

    [Fact]
    public void TripEdits_unmatched_edit_waits()
    {
        var detected = Trip(D(9, 12), D(9, 13));
        var edit = Edit(D(8, 1), D(8, 3), name: "Gone for now", start: D(7, 30), end: D(8, 5));

        // It touches no trip: nothing changes, and nothing is made of it.
        var edited = Assert.Single(TripEdits.Apply([detected], [edit], ZoneAt));
        Assert.Equal(detected, edited.Trip);
        Assert.Null(edited.Name);
        Assert.Empty(TripEdits.Apply([], [edit], ZoneAt));

        // The trip is detected again, and the same edit applies to it.
        var back = Assert.Single(TripEdits.Apply([Trip(D(8, 2), D(8, 3))], [edit], ZoneAt));
        Assert.Equal("Gone for now", back.Name);
        Assert.Equal((D(7, 30), D(8, 4)), (back.Trip.FirstNight, back.Trip.LastNight));
    }

    [Fact]
    public void TripEdits_dates_that_would_share_a_night_with_another_trip_are_not_applied()
    {
        var first = Trip(D(9, 12), D(9, 13));
        var second = Trip(D(9, 20), D(9, 22));

        // The first trip is to end on the 22nd, which takes in the nights of the second (the 20th and the 21st): its name is kept, its dates not.
        var edited = TripEdits.Apply([first, second], [Edit(D(9, 12), D(9, 13), name: "Long", end: D(9, 22))], ZoneAt);

        Assert.Equal(["Long", null], edited.Select(e => e.Name));
        Assert.Equal([first, second], edited.Select(e => e.Trip));
    }

    [Fact]
    public void TripEdits_trips_whose_new_dates_touch_are_both_moved()
    {
        var first = Trip(D(9, 12), D(9, 13));
        var second = Trip(D(9, 20), D(9, 22));

        // One comes back on the 16th and the other leaves on the 16th: the first night of one is the day after the last of the other, and
        // the 16th is a day of both of them.
        var edited = TripEdits.Apply(
            [first, second],
            [Edit(D(9, 12), D(9, 13), end: D(9, 16)), Edit(D(9, 20), D(9, 22), start: D(9, 16))],
            ZoneAt);

        Assert.Equal([(D(9, 12), D(9, 15)), (D(9, 16), D(9, 22))], edited.Select(e => (e.Trip.FirstNight, e.Trip.LastNight)));
        Assert.Equal(D(9, 16), edited[0].Trip.LocalEndDate);
        Assert.Equal(D(9, 16), edited[1].Trip.LocalStartDate);
        Assert.Equal(TimeSpan.FromDays(1), edited[0].Trip.EndUtc - edited[1].Trip.StartUtc); // the day they share, which is in the span of both
    }

    [Fact]
    public void TripEdits_edits_that_swap_their_places_are_both_applied()
    {
        // Each trip's new nights are the other's old ones: they overlap the detected trips, not each other.
        var first = Trip(D(9, 10), D(9, 11));
        var second = Trip(D(9, 12), D(9, 13));

        var edited = TripEdits.Apply(
            [first, second],
            [Edit(D(9, 10), D(9, 11), start: D(9, 12), end: D(9, 14)), Edit(D(9, 12), D(9, 13), start: D(9, 10), end: D(9, 12))],
            ZoneAt);

        Assert.Equal([(D(9, 10), D(9, 11)), (D(9, 12), D(9, 13))], edited.Select(e => (e.Trip.FirstNight, e.Trip.LastNight)));
        Assert.Equal([D(9, 12), D(9, 10)], edited.Select(e => e.DetectedId)); // each is the edit of the trip it was made for
    }

    [Fact]
    public void TripEdits_dates_that_leave_no_night_are_not_applied()
    {
        var detected = Trip(D(9, 12), D(9, 13));

        // The trip is now over before the start date the owner gave it was made for.
        var edited = Assert.Single(TripEdits.Apply([detected], [Edit(D(9, 12), D(9, 13), name: "Short", start: D(9, 20))], ZoneAt));

        Assert.Equal(detected, edited.Trip);
        Assert.Equal("Short", edited.Name);
    }

    [Fact]
    public void TripEdits_come_back_in_the_order_of_their_first_nights()
    {
        var edited = TripEdits.Apply(
            [Trip(D(9, 1), D(9, 2)), Trip(D(9, 5), D(9, 6))],
            [Edit(D(9, 1), D(9, 2), start: D(9, 8), end: D(9, 10))],
            ZoneAt);

        Assert.Equal([D(9, 5), D(9, 8)], edited.Select(e => e.Trip.FirstNight));
    }

    [Fact]
    public void TripEdits_nearest_night_zone_is_the_zone_of_the_night_or_of_the_one_closest_to_the_date()
    {
        var nights = new[]
        {
            new Night(D(9, 10), Utc(9, 11, 1), Oslo, null, null),
            new Night(D(9, 11), Utc(9, 12, 1), Oslo, null, null),
            new Night(D(9, 14), Utc(9, 15, 2), Lisbon, null, null),
        };
        var zoneAt = TripEdits.ZoneOfNearestNight(nights);

        Assert.Equal(Oslo, zoneAt(D(9, 11)));   // the night itself
        Assert.Equal(Lisbon, zoneAt(D(9, 14)));
        Assert.Equal(Oslo, zoneAt(D(9, 12)));   // one day from the 11th, two from the 14th
        Assert.Equal(Lisbon, zoneAt(D(9, 13))); // one day from the 14th, two from the 11th
        Assert.Equal(Oslo, zoneAt(D(9, 1)));    // before the first
        Assert.Equal(Lisbon, zoneAt(D(12, 1))); // after the last

        // Two nights equally near: the earlier one.
        var apart = TripEdits.ZoneOfNearestNight([nights[0], nights[2]]);
        Assert.Equal(Oslo, apart(D(9, 12)));
        Assert.Equal(Lisbon, apart(D(9, 13)));
        Assert.Null(TripEdits.ZoneOfNearestNight([])(D(9, 1)));
    }
}
