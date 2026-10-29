using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// The nights, homes and trips worked out from a stored timeline, and the store that holds them. The timelines are written
/// as segments, one stay for each stretch at a place, and every night of them is read in Europe/Oslo (UTC+2 in the summer)
/// or Europe/Lisbon (UTC+1): the night of 9 July is read at 01:00Z on the 10th in Oslo.
/// </summary>
[Collection("db")]
public class TripRefresherTests(DatabaseFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime Utc(int month, int day, int hour = 0) => new(2026, month, day, hour, 0, 0, DateTimeKind.Utc);

    private static DateOnly D(int month, int day) => new(2026, month, day);

    /// <summary>A stay of a place, at the place's own position.</summary>
    private static async Task<long> StayAsync(
        string cs, DateTime start, DateTime end, long place, GeoPoint at, string zone = "Europe/Oslo")
        => await TimelineSeeder.InsertSegmentAsync(cs, "stay", start, end, LocalTime.LocalDate(start, zone), LocalTime.LocalDate(end, zone),
            zone, placeId: place, lat: at.Latitude, lon: at.Longitude);

    private static Task<long> PlaceAsync(string cs, GeoPoint at, long? mergedInto = null)
        => TimelineSeeder.InsertPlaceAsync(cs, lat: at.Latitude, lon: at.Longitude, mergedInto: mergedInto);

    private sealed record HomeRow(long PlaceId, string From, string? To, string Source);

    private static Task<IReadOnlyList<HomeRow>> HomesAsync(string cs) => Sql.QueryAsync<HomeRow>(cs,
        """
        select place_id as PlaceId, from_date::text as "From", to_date::text as "To", source as Source
        from home_period order by from_date, id
        """, ct: Ct);

    private sealed record TripRow(
        string Id, string LastNight, int Nights, DateTime StartUtc, DateTime? EndUtc, string StartTz, string EndTz,
        string LocalStartDate, string LocalEndDate);

    private static Task<IReadOnlyList<TripRow>> TripsAsync(string cs) => Sql.QueryAsync<TripRow>(cs,
        """
        select id::text as Id, last_night::text as LastNight, nights as Nights, start_utc as StartUtc, end_utc as EndUtc,
               start_tz as StartTz, end_tz as EndTz, local_start_date::text as LocalStartDate, local_end_date::text as LocalEndDate
        from trip order by id
        """, ct: Ct);

    private sealed record PendingRow(DateTime? FromUtc, DateTime? ToUtc);

    private static async Task<(DateTime? From, DateTime? To)> PendingAsync(string cs)
    {
        var row = (await Sql.QueryAsync<PendingRow>(cs, "select from_utc as FromUtc, to_utc as ToUtc from night_refresh where id = 1", ct: Ct)).Single();
        return (row.FromUtc, row.ToUtc);
    }

    /// <summary>
    /// 100 nights at home from 31 March to 8 July (one long stay at the home place, which is read every night), then three
    /// nights in Lisbon, then home again for three more. Home leaves on 9 July at 09:00 local and is back on the 12th at 16:00.
    /// </summary>
    private static async Task<(long Home, long Lisbon, long LisbonStay)> SeedOneTripAsync(string cs)
    {
        var home = await PlaceAsync(cs, Spots.Home);
        var lisbon = await PlaceAsync(cs, Spots.Lisbon);
        await StayAsync(cs, Utc(3, 31, 12), Utc(7, 9, 7), home, Spots.Home);
        var away = await StayAsync(cs, Utc(7, 9, 12), Utc(7, 12, 8), lisbon, Spots.Lisbon, "Europe/Lisbon");
        await StayAsync(cs, Utc(7, 12, 14), Utc(7, 15, 12), home, Spots.Home);
        return (home, lisbon, away);
    }

    [Fact]
    public async Task TripRefresher_stores_nights_homes_and_trips_for_the_window()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var refresher = api.Services.GetRequiredService<ITripRefresher>(); // starting the host runs the migrations
        var (home, lisbon, _) = await SeedOneTripAsync(cs);

        await refresher.RefreshAsync(Utc(4, 1), Utc(7, 15, 12), Ct);

        // Nights from 31 March (the window's first day, less one) to 14 July: 100 at home, three away, three at home.
        var nights = await api.Services.GetRequiredService<NightStore>().LoadAllAsync(Ct);
        Assert.Equal(106, nights.Count);
        Assert.Equal(D(3, 31), nights[0].Date);
        Assert.Equal(D(7, 14), nights[^1].Date);
        Assert.Equal(103, nights.Count(n => n.PlaceId == home));
        Assert.Equal([D(7, 9), D(7, 10), D(7, 11)], nights.Where(n => n.PlaceId == lisbon).Select(n => n.Date));
        Assert.Equal(new Night(D(7, 9), Utc(7, 10, 2), "Europe/Lisbon", lisbon, Spots.Lisbon), nights.Single(n => n.Date == D(7, 9)));
        Assert.Equal(106, await Sql.ScalarAsync<long>(cs, "select count(*) from night where source = 'stay'", ct: Ct));

        // One home, from the first night, still open; one trip, from the first night away to the last.
        Assert.Equal([new HomeRow(home, "2026-03-31", null, "detected")], await HomesAsync(cs));
        Assert.Equal(
            [new TripRow("2026-07-09", "2026-07-11", 3, Utc(7, 9, 7), Utc(7, 12, 14), "Europe/Oslo", "Europe/Oslo", "2026-07-09", "2026-07-12")],
            await TripsAsync(cs));
    }

    [Fact]
    public async Task TripRefresher_recomputes_all_trips_when_one_window_changes()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        var (home, lisbon, lisbonStay) = await SeedOneTripAsync(cs);
        // A second trip, in September, outside every window below.
        await StayAsync(cs, Utc(7, 15, 12), Utc(9, 3, 7), home, Spots.Home);
        await StayAsync(cs, Utc(9, 3, 12), Utc(9, 5, 8), lisbon, Spots.Lisbon, "Europe/Lisbon");
        await StayAsync(cs, Utc(9, 5, 14), Utc(9, 8, 12), home, Spots.Home);
        await refresher.RefreshAsync(Utc(4, 1), Utc(9, 8, 12), Ct);
        Assert.Equal(["2026-07-09", "2026-09-03"], (await TripsAsync(cs)).Select(t => t.Id));
        // The stored second trip is made wrong: a refresh that left the trips outside its window alone would keep it so.
        await Sql.ExecAsync(cs, "update trip set nights = 99 where id = '2026-09-03'", ct: Ct);

        // The person was at home all along: the stay in Lisbon becomes a stay at home, and only July is refreshed.
        await Sql.ExecAsync(cs, "delete from segment where id = @lisbonStay", new { lisbonStay }, Ct);
        await Sql.ExecAsync(cs, "update segment set start_utc = @start, local_start_date = '2026-07-09' where start_utc = @was",
            new { start = Utc(7, 9, 12), was = Utc(7, 12, 14) }, Ct);
        await refresher.RefreshAsync(Utc(7, 9), Utc(7, 13), Ct);

        var trips = await TripsAsync(cs);
        var september = Assert.Single(trips); // the July trip is gone...
        Assert.Equal(("2026-09-03", 2), (september.Id, september.Nights)); // ...and the September one is worked out again, not kept
        Assert.Equal(3, await Sql.ScalarAsync<long>(cs, "select count(*) from night where date between '2026-07-09' and '2026-07-11' and place_id = @home",
            new { home }, Ct));
        Assert.Equal([new HomeRow(home, "2026-03-31", null, "detected")], await HomesAsync(cs));
    }

    [Fact]
    public async Task TripRefresher_resolves_merged_places_to_their_survivor()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        // Home for 30 nights at one place and then for 76 at a place that has been merged into the first since. The first alone
        // is not home for 60 of the last 90 nights; the second alone is, so without the merge the home would be the second
        // place. With it, the home is the first, for all 106.
        var survivor = await PlaceAsync(cs, Spots.Home);
        var merged = await PlaceAsync(cs, Geo.Offset(Spots.Home, 30, 0), mergedInto: survivor);
        await StayAsync(cs, Utc(3, 31, 12), Utc(4, 30, 7), survivor, Spots.Home);
        await StayAsync(cs, Utc(4, 30, 12), Utc(7, 15, 12), merged, Geo.Offset(Spots.Home, 30, 0));

        await refresher.RefreshAsync(Utc(4, 1), Utc(7, 15, 12), Ct);

        Assert.Equal([new HomeRow(survivor, "2026-03-31", null, "detected")], await HomesAsync(cs));
        // The nights keep the place their stay had: the merge is resolved when they are read, not when they are stored.
        Assert.Equal([survivor, merged], await Sql.QueryAsync<long>(cs, "select distinct place_id from night where place_id is not null order by place_id", ct: Ct));
    }

    [Fact]
    public async Task TripRefresher_counts_places_near_each_other_as_one_home()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        // One house that GPS drift made two places 120 m apart, slept at by turns in blocks of 20 nights, 100 nights in all: the first
        // place for 60 of them, the second for 40, and no 90 nights have more than 50 at either. Neither is home on its own; together
        // they have 60 of 90 on night 60. The first place stored, which has more of them by then, is the home from the first night,
        // and nothing is a trip, because the two are the same home.
        var first = await PlaceAsync(cs, Spots.Home);
        var second = await PlaceAsync(cs, Geo.Offset(Spots.Home, 0, 120));
        await StayAsync(cs, Utc(3, 31, 12), Utc(4, 20, 7), first, Spots.Home);
        await StayAsync(cs, Utc(4, 20, 12), Utc(5, 10, 7), second, Geo.Offset(Spots.Home, 0, 120));
        await StayAsync(cs, Utc(5, 10, 12), Utc(5, 30, 7), first, Spots.Home);
        await StayAsync(cs, Utc(5, 30, 12), Utc(6, 19, 7), second, Geo.Offset(Spots.Home, 0, 120));
        await StayAsync(cs, Utc(6, 19, 12), Utc(7, 9, 7), first, Spots.Home);

        await refresher.RefreshAsync(Utc(4, 1), Utc(7, 9, 7), Ct);

        Assert.Equal([new HomeRow(first, "2026-03-31", null, "detected")], await HomesAsync(cs));
        Assert.Empty(await TripsAsync(cs));
    }

    [Fact]
    public async Task TripRefresher_leaves_the_old_nights_homes_and_trips_when_writing_the_new_ones_fails()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        var nights = api.Services.GetRequiredService<NightStore>();
        var (home, lisbon, _) = await SeedOneTripAsync(cs);
        await refresher.RefreshAsync(Utc(4, 1), Utc(7, 15, 12), Ct);
        var (nightsBefore, homesBefore, tripsBefore) = (await nights.LoadAllAsync(Ct), await HomesAsync(cs), await TripsAsync(cs));
        Assert.NotEmpty(tripsBefore);

        // The timeline has changed (a month more at home, then a stay at the other place), so that the new nights, homes and trips
        // all differ from the stored ones, and writing a trip fails: whatever was written before it must go too.
        await Sql.ExecAsync(cs, "alter table trip add constraint no_trip_may_be_written check (nights < 0) not valid", ct: Ct);
        await StayAsync(cs, Utc(7, 15, 12), Utc(8, 20, 7), home, Spots.Home);
        await StayAsync(cs, Utc(8, 20, 12), Utc(8, 23, 8), lisbon, Spots.Lisbon, "Europe/Lisbon");

        await Assert.ThrowsAsync<PostgresException>(() => refresher.RefreshAsync(Utc(7, 15), Utc(8, 23, 8), Ct));

        // Nights that a reader would find new, with trips that are old, are what two transactions would have left.
        Assert.Equal(nightsBefore, await nights.LoadAllAsync(Ct));
        Assert.Equal(homesBefore, await HomesAsync(cs));
        Assert.Equal(tripsBefore, await TripsAsync(cs));
    }

    [Fact]
    public async Task TripRefresher_with_nothing_stored_leaves_nothing_and_clears_what_was_derived()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        await SeedOneTripAsync(cs);
        await refresher.RefreshAsync(Utc(4, 1), Utc(7, 15, 12), Ct);
        Assert.NotEmpty(await TripsAsync(cs));

        await Sql.ExecAsync(cs, "delete from segment", ct: Ct);
        await refresher.RefreshAsync(Utc(3, 1), Utc(7, 20), Ct);

        Assert.Equal(0, await Sql.ScalarAsync<long>(cs, "select count(*) from night", ct: Ct));
        Assert.Empty(await HomesAsync(cs));
        Assert.Empty(await TripsAsync(cs));
    }

    // ---- recomputing without rebuilding --------------------------------------------------------------------------------

    private sealed record Snapshot(IReadOnlyList<Night> Nights, IReadOnlyList<HomeRow> Homes, IReadOnlyList<TripRow> Trips);

    /// <summary>Row by row: a record does not compare the lists it holds by what is in them.</summary>
    private static void AssertSame(Snapshot expected, Snapshot actual)
    {
        Assert.Equal(expected.Nights, actual.Nights);
        Assert.Equal(expected.Homes, actual.Homes);
        Assert.Equal(expected.Trips, actual.Trips);
    }

    private static async Task<Snapshot> SnapshotAsync(ApiFactory api, string cs)
        => new(await api.Services.GetRequiredService<NightStore>().LoadAllAsync(Ct), await HomesAsync(cs), await TripsAsync(cs));

    [Fact]
    public async Task Recompute_works_out_homes_and_trips_from_the_stored_nights_and_builds_none()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        var (home, _, lisbonStay) = await SeedOneTripAsync(cs);
        await refresher.RefreshAsync(Utc(4, 1), Utc(7, 15, 12), Ct);
        await Sql.ExecAsync(cs, "insert into home_period (place_id, from_date, to_date, source) values (@home, '2025-01-01', '2025-12-31', 'user')", new { home }, Ct);
        var before = await SnapshotAsync(api, cs);
        Assert.Single(before.Trips);
        Assert.Equal(2, before.Homes.Count);

        // What was derived is lost, and the timeline is not what the nights were built from: a rebuild of the nights would show it.
        await Sql.ExecAsync(cs, "delete from trip; delete from home_period where source = 'detected'; delete from segment where id = @lisbonStay", new { lisbonStay }, Ct);

        await refresher.RecomputeAsync(Ct);

        // The trip is back, the nights are as they were stored, and the owner's home was not touched.
        AssertSame(before, await SnapshotAsync(api, cs));
    }

    [Fact]
    public async Task Recompute_resolves_merged_places_to_their_survivor()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        var survivor = await PlaceAsync(cs, Spots.Home);
        var other = await PlaceAsync(cs, Geo.Offset(Spots.Home, 0, 300));
        await StayAsync(cs, Utc(3, 31, 12), Utc(5, 20, 7), survivor, Spots.Home);
        await StayAsync(cs, Utc(5, 20, 12), Utc(7, 9, 7), other, Geo.Offset(Spots.Home, 0, 300));
        await refresher.RefreshAsync(Utc(4, 1), Utc(7, 9, 7), Ct);
        Assert.Empty(await HomesAsync(cs)); // 50 nights at each, 300 m apart: no home

        await Sql.ExecAsync(cs, "update place set merged_into_id = @survivor where id = @other", new { survivor, other }, Ct);
        await refresher.RecomputeAsync(Ct);

        Assert.Equal([new HomeRow(survivor, "2026-03-31", null, "detected")], await HomesAsync(cs));
    }

    [Fact]
    public async Task Merge_recomputes_homes_at_once()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        // One house that GPS drift made two places 300 m apart (more than the 250 m that make one home), slept at by turns for 50 nights
        // each: neither has 60 of 90 nights, so there is no home at all.
        var first = await PlaceAsync(cs, Spots.Home);
        var second = await PlaceAsync(cs, Geo.Offset(Spots.Home, 0, 300));
        await StayAsync(cs, Utc(3, 31, 12), Utc(5, 20, 7), first, Spots.Home);
        await StayAsync(cs, Utc(5, 20, 12), Utc(7, 9, 7), second, Geo.Offset(Spots.Home, 0, 300));
        await refresher.RefreshAsync(Utc(4, 1), Utc(7, 9, 7), Ct);
        Assert.Empty(await HomesAsync(cs));

        // Merged, they are one place with all 100 nights. The merge answers when the homes are worked out: nothing refreshes them after it.
        using var merged = await client.PostAsJsonAsync($"/api/places/{first}/merge", new { place = second, name = (string?)null }, Ct);
        Assert.Equal(HttpStatusCode.OK, merged.StatusCode);
        Assert.Equal([new HomeRow(first, "2026-03-31", null, "detected")], await HomesAsync(cs));
        Assert.Empty(await TripsAsync(cs));

        // And separated, they are two again, and so is what follows from it.
        using var separated = await client.DeleteAsync($"/api/places/{first}/merged/{second}", Ct);
        Assert.Equal(HttpStatusCode.NoContent, separated.StatusCode);
        Assert.Empty(await HomesAsync(cs));
    }

    [Fact]
    public async Task Merge_whose_recompute_fails_is_worked_out_by_the_worker_on_its_next_pass()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var refresher = default(FailingRefresher);
        await using var api = new ApiFactory(cs, configureServices: services =>
        {
            services.RemoveAll<ITripRefresher>();
            services.AddSingleton<ITripRefresher>(sp => refresher = new FailingRefresher(sp.GetRequiredService<TripRefresher>(), failures: 1));
        });
        var client = api.CreateClient();
        var worker = api.Services.GetRequiredService<TimelineWorker>();
        // The timeline is as the algorithm has made it: the worker's first pass starts it over (and deletes these segments) unless it is told so.
        await Sql.ExecAsync(cs, "update processing_state set algorithm_version = @version where id = 1",
            new { version = AlgorithmVersion.Compute(api.Services.GetRequiredService<DetectionOptions>()) }, Ct);
        var first = await PlaceAsync(cs, Spots.Home);
        var second = await PlaceAsync(cs, Geo.Offset(Spots.Home, 0, 300));
        await StayAsync(cs, Utc(3, 31, 12), Utc(5, 20, 7), first, Spots.Home);
        await StayAsync(cs, Utc(5, 20, 12), Utc(7, 9, 7), second, Geo.Offset(Spots.Home, 0, 300));
        await api.Services.GetRequiredService<ITripRefresher>().RefreshAsync(Utc(4, 1), Utc(7, 9, 7), Ct);
        Assert.Empty(await HomesAsync(cs));

        // The recompute of the merge fails (once). The merge answers, and the homes are as they were.
        using var merged = await client.PostAsJsonAsync($"/api/places/{first}/merge", new { place = second, name = (string?)null }, Ct);
        Assert.Equal(HttpStatusCode.OK, merged.StatusCode);
        Assert.Equal(1, refresher!.Recomputes);
        Assert.Empty(await HomesAsync(cs));
        Assert.NotNull(await api.Services.GetRequiredService<TripStore>().TakePendingAsync(Ct));

        // The worker's next pass does it: the two places are one home, and nothing is pending any more.
        Assert.True(await worker.RunOnceAsync(Ct));

        Assert.Equal([new HomeRow(first, "2026-03-31", null, "detected")], await HomesAsync(cs));
        Assert.Null(await api.Services.GetRequiredService<TripStore>().TakePendingAsync(Ct));
        Assert.Null(await Sql.ScalarAsync<string?>(cs, "select last_error from processing_state where id = 1", ct: Ct));
    }

    [Fact]
    public async Task Restarting_the_backfill_waits_for_the_lock_the_derived_tables_are_written_under()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        await SeedOneTripAsync(cs);
        await refresher.RefreshAsync(Utc(4, 1), Utc(7, 15, 12), Ct);
        Assert.NotEmpty(await TripsAsync(cs));

        // A refresh or a recompute holds the lock. The restart deletes the nights, homes and trips, so it must not do it under the feet
        // of one that is working from them: it waits.
        await using var holder = await AdvisoryLockHolder.HoldAsync(cs, Ct);
        var restart = Task.Run(() => api.Services.GetRequiredService<ProcessingQueue>().RestartBackfillAsync("a new version", Utc(1, 1), Utc(7, 15), Ct), Ct);
        await AdvisoryLockHolder.WaitForWaitersAsync(cs, 1, Ct, (restart, "the restart"));
        Assert.NotEmpty(await TripsAsync(cs));

        await holder.ReleaseAsync(Ct);
        await restart;

        Assert.Empty(await TripsAsync(cs));
        Assert.Equal(0, await Sql.ScalarAsync<long>(cs, "select count(*) from night", ct: Ct));
    }

    [Fact]
    public async Task Recompute_and_refresh_do_not_interleave()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        var (home, lisbon, lisbonStay) = await SeedOneTripAsync(cs);
        // A second trip, in September, outside the window of the refresh.
        await StayAsync(cs, Utc(7, 15, 12), Utc(9, 3, 7), home, Spots.Home);
        await StayAsync(cs, Utc(9, 3, 12), Utc(9, 5, 8), lisbon, Spots.Lisbon, "Europe/Lisbon");
        await StayAsync(cs, Utc(9, 5, 14), Utc(9, 8, 12), home, Spots.Home);
        await refresher.RefreshAsync(Utc(4, 1), Utc(9, 8, 12), Ct);
        Assert.Equal(["2026-07-09", "2026-09-03"], (await TripsAsync(cs)).Select(t => t.Id));

        // Someone else holds the lock, as the worker's refresh or an edit's recompute would while it works. Both calls ask for it first,
        // before they read anything, and both wait.
        await using var holder = await AdvisoryLockHolder.HoldAsync(cs, Ct);
        var recompute = Task.Run(() => refresher.RecomputeAsync(Ct), Ct);
        var refresh = Task.Run(() => refresher.RefreshAsync(Utc(7, 9), Utc(7, 13), Ct), Ct);
        await AdvisoryLockHolder.WaitForWaitersAsync(cs, 2, Ct, (recompute, "the recompute"), (refresh, "the refresh"));

        // While they wait, the timeline changes under them: the person was at home all along in July, so the July trip is gone and
        // the nights of those days are at home. Whatever either of them did read before it asked for the lock would be out of date.
        await Sql.ExecAsync(cs, "delete from segment where id = @lisbonStay", new { lisbonStay }, Ct);
        await Sql.ExecAsync(cs, "update segment set start_utc = @start, local_start_date = '2026-07-09' where start_utc = @was",
            new { start = Utc(7, 9, 12), was = Utc(7, 12, 14) }, Ct);
        await holder.ReleaseAsync(Ct);
        await Task.WhenAll(recompute, refresh);

        // One after the other, in whichever order, each reading what the other left: the homes and trips are those of the nights that are
        // stored, and the nights those of the timeline as it is. Nothing is left from a read that was out of date, and nothing is twice.
        var stored = await SnapshotAsync(api, cs);
        Assert.Equal(["2026-09-03"], stored.Trips.Select(t => t.Id));
        Assert.Equal(3, stored.Nights.Count(n => n.Date >= D(7, 9) && n.Date <= D(7, 11) && n.PlaceId == home));
        Assert.Equal([new HomeRow(home, "2026-03-31", null, "detected")], stored.Homes);

        await refresher.RefreshAsync(Utc(4, 1), Utc(9, 8, 12), Ct); // a fresh computation over the final data
        AssertSame(stored, await SnapshotAsync(api, cs));
        await refresher.RecomputeAsync(Ct);
        AssertSame(stored, await SnapshotAsync(api, cs));
    }

    // ---- the store ---------------------------------------------------------------------------------------------------

    [Fact]
    public async Task TripStore_pending_window_grows_to_cover_everything_added()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var store = api.Services.GetRequiredService<TripStore>(); // starting the host runs the migrations
        Assert.Null(await store.TakePendingAsync(Ct));

        await store.ExtendPendingAsync(Utc(5, 10), Utc(5, 12), Ct);
        Assert.Equal((Utc(5, 10), Utc(5, 12)), await store.TakePendingAsync(Ct));

        await store.ExtendPendingAsync(Utc(5, 11), Utc(5, 11, 12), Ct); // inside: nothing changes
        Assert.Equal((Utc(5, 10), Utc(5, 12)), await store.TakePendingAsync(Ct));

        await store.ExtendPendingAsync(Utc(5, 8), Utc(5, 9), Ct); // before, and apart from it: what lies between is in it too
        await store.ExtendPendingAsync(Utc(5, 20), Utc(5, 21), Ct); // after
        Assert.Equal((Utc(5, 8), Utc(5, 21)), await store.TakePendingAsync(Ct));
        Assert.Equal(1, await Sql.ScalarAsync<long>(cs, "select count(*) from night_refresh", ct: Ct)); // still the one row
    }

    [Fact]
    public async Task TripStore_clears_the_pending_window_only_if_it_is_still_the_one_that_was_taken()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var store = api.Services.GetRequiredService<TripStore>();
        await store.ExtendPendingAsync(Utc(5, 10), Utc(5, 12), Ct);
        var (from, to) = (await store.TakePendingAsync(Ct))!.Value;

        await store.ExtendPendingAsync(Utc(5, 12), Utc(5, 14), Ct); // a rebuild that finished while the refresh ran
        await store.ClearPendingAsync(from, to, Ct);

        Assert.Equal((Utc(5, 10), Utc(5, 14)), await store.TakePendingAsync(Ct)); // not refreshed yet, so it stays
        await store.ClearPendingAsync(Utc(5, 10), Utc(5, 14), Ct);
        Assert.Null(await store.TakePendingAsync(Ct));
        Assert.Equal((null, null), await PendingAsync(cs));
    }

    [Fact]
    public async Task TripStore_replaces_detected_homes_and_all_trips_and_keeps_the_owners_homes()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var store = api.Services.GetRequiredService<TripStore>();
        var (old, current) = (await PlaceAsync(cs, Spots.Cafe), await PlaceAsync(cs, Spots.Home));
        await Sql.ExecAsync(cs,
            """
            insert into home_period (place_id, from_date, to_date, source) values
              (@old, '2026-01-01', '2026-02-28', 'detected'), (@old, '2025-01-01', '2025-12-31', 'user');
            insert into trip (id, last_night, nights, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date)
            values ('2026-01-05', '2026-01-06', 2, '2026-01-05T10:00:00Z', '2026-01-07T10:00:00Z', 'Europe/Oslo', 'Europe/Oslo', '2026-01-05', '2026-01-07');
            """, new { old }, Ct);

        await store.ReplaceDetectedAsync(
            [new HomePeriod(old, D(1, 1), D(3, 31)), new HomePeriod(current, D(4, 1), null)],
            [
                new DetectedTrip(D(5, 3), D(5, 5), 3, Utc(5, 3, 8), Utc(5, 6, 9), "Europe/Oslo", "Europe/Lisbon", D(5, 3), D(5, 6)),
                new DetectedTrip(D(6, 20), D(6, 24), 5, Utc(6, 20, 8), null, "Europe/Oslo", "Asia/Tokyo", D(6, 20), D(6, 25)),
            ],
            Ct);

        Assert.Equal(
            [
                new HomeRow(old, "2025-01-01", "2025-12-31", "user"),
                new HomeRow(old, "2026-01-01", "2026-03-31", "detected"),
                new HomeRow(current, "2026-04-01", null, "detected"),
            ],
            await HomesAsync(cs));
        Assert.Equal(
            [
                new TripRow("2026-05-03", "2026-05-05", 3, Utc(5, 3, 8), Utc(5, 6, 9), "Europe/Oslo", "Europe/Lisbon", "2026-05-03", "2026-05-06"),
                new TripRow("2026-06-20", "2026-06-24", 5, Utc(6, 20, 8), null, "Europe/Oslo", "Asia/Tokyo", "2026-06-20", "2026-06-25"),
            ],
            await TripsAsync(cs));

        await store.ReplaceDetectedAsync([], [], Ct); // nothing detected: nothing of it is left, and the owner's home is

        Assert.Equal([new HomeRow(old, "2025-01-01", "2025-12-31", "user")], await HomesAsync(cs));
        Assert.Empty(await TripsAsync(cs));
    }

    [Fact]
    public async Task TripStore_keeps_what_was_stored_when_an_insert_fails()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var store = api.Services.GetRequiredService<TripStore>();
        var place = await PlaceAsync(cs, Spots.Home);
        var trip = new DetectedTrip(D(5, 3), D(5, 5), 3, Utc(5, 3, 8), Utc(5, 6, 9), "Europe/Oslo", "Europe/Oslo", D(5, 3), D(5, 6));
        await store.ReplaceDetectedAsync([new HomePeriod(place, D(1, 1), null)], [trip], Ct);

        await Assert.ThrowsAsync<PostgresException>(() =>
            store.ReplaceDetectedAsync([new HomePeriod(999_999, D(1, 1), null)], [], Ct)); // no such place

        Assert.Equal([new HomeRow(place, "2026-01-01", null, "detected")], await HomesAsync(cs)); // the deletes went with it
        Assert.Equal(["2026-05-03"], (await TripsAsync(cs)).Select(t => t.Id));
    }

    [Fact]
    public async Task TripStore_replace_all_leaves_the_nights_homes_and_trips_as_they_were_when_a_write_fails()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var store = api.Services.GetRequiredService<TripStore>();
        var nights = api.Services.GetRequiredService<NightStore>();
        var place = await PlaceAsync(cs, Spots.Home);
        var old = new Night(D(6, 1), Utc(6, 2, 1), "Europe/Oslo", place, Spots.Home);
        var trip = new DetectedTrip(D(5, 3), D(5, 5), 3, Utc(5, 3, 8), Utc(5, 6, 9), "Europe/Oslo", "Europe/Oslo", D(5, 3), D(5, 6));
        await store.ReplaceAllAsync(D(6, 1), D(6, 3), [(old, "stay")], [new HomePeriod(place, D(6, 1), null)], [trip], Ct);
        var changed = old with { PlaceId = null, Position = Spots.Cafe };

        // The nights are written first and the home period fails (no such place): the nights go back with it.
        await Assert.ThrowsAsync<PostgresException>(() =>
            store.ReplaceAllAsync(D(6, 1), D(6, 3), [(changed, "point")], [new HomePeriod(999_999, D(6, 1), null)], [], Ct));

        Assert.Equal([old], await nights.LoadAllAsync(Ct));
        Assert.Equal([new HomeRow(place, "2026-06-01", null, "detected")], await HomesAsync(cs));
        Assert.Equal(["2026-05-03"], (await TripsAsync(cs)).Select(t => t.Id));

        // And a night outside the range fails before anything is written.
        await Assert.ThrowsAsync<ArgumentException>(() =>
            store.ReplaceAllAsync(D(6, 1), D(6, 3), [(old with { Date = D(6, 9) }, "stay")], [], [], Ct));
        Assert.Equal(["2026-05-03"], (await TripsAsync(cs)).Select(t => t.Id));
    }
}
