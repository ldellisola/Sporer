using System.Globalization;
using System.Net;
using System.Text;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Time.Testing;
using Sporer.Api.Features.Timeline;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// A stretch of history that cannot be processed (a data-dependent failure) must not hold up anything else: not the rest of
/// the backfill, not live data, with or without a restart in between. The isolation comes from the database: a dirty range
/// that has failed <see cref="ProcessingQueue.SetAsideAfterAttempts"/> times is set aside, and rebuilds stay clear of it.
/// </summary>
[Collection("db")]
public class FailureIsolationTests(DatabaseFixture db)
{
    private static readonly DateTime Day = new(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Every2min = TimeSpan.FromMinutes(2);

    private static readonly Dictionary<string, string?> NoPause = new() { ["Processing:BackfillPause"] = "00:00:00" };

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime T(int hour, int minute, int day = 0) => Day.AddDays(day).AddHours(hour).AddMinutes(minute);

    /// <summary>Home 1 h -> walk to the cafe -> cafe 25 min -> cycle to the office -> office 8 h, starting 07:00 on <paramref name="day"/>.</summary>
    private static List<TrackPoint> CommuteDay(int day) => new TrackBuilder(T(7, 0, day), Spots.Home)
        .Stay(TimeSpan.FromHours(1), Every2min)
        .Travel(Spots.Cafe, 5, Every10s)
        .Stay(TimeSpan.FromMinutes(25), Every2min)
        .Travel(Spots.Office, 18, Every10s)
        .Stay(TimeSpan.FromHours(8), Every2min)
        .Build();

    private static IEnumerable<TrackPoint> CommuteDays(int firstDay, int count) => Enumerable.Range(firstDay, count).SelectMany(CommuteDay);

    /// <summary>
    /// Wraps the real processor and fails a rebuild whose loaded window contains the poison time, however often it is
    /// tried (a failure that depends on the data, as a real one would), or whose start matches <see cref="FailFrom"/>.
    /// The window is worked out the way the processor does it, from the anchors in the database.
    /// </summary>
    private sealed class PoisonProcessor(ITimelineProcessor inner, SegmentStore store) : ITimelineProcessor
    {
        public DateTime? Poison { get; set; }
        public Func<DateTime, bool>? FailFrom { get; set; }

        /// <summary>Runs, awaited, when a rebuild is asked for, before anything else.</summary>
        public Func<Task>? OnCall { get; set; }

        public List<(DateTime From, DateTime To)> Calls { get; } = [];
        public int Failures { get; private set; }

        public async Task<int> ReprocessAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct)
        {
            Calls.Add((fromUtc, toUtc));
            if (OnCall is { } hook)
                await hook();

            if (FailFrom?.Invoke(fromUtc) == true)
                throw Fail("step fails");

            if (Poison is { } poison)
            {
                var (t0, t1) = await store.FindAnchorsAsync(fromUtc, toUtc, ct);
                var last = await store.FindLastEndAsync(ct);
                var upper = t1 ?? (last is { } l && l > toUtc ? l : toUtc);
                if (t0 <= poison && poison <= upper)
                    throw Fail("poisoned data loaded");
            }

            return await inner.ReprocessAsync(fromUtc, toUtc, ct);
        }

        private InvalidOperationException Fail(string message)
        {
            Failures++;
            return new InvalidOperationException(message);
        }
    }

    private sealed class Harness(WebApplicationFactory<Program> api) : IAsyncDisposable
    {
        public WebApplicationFactory<Program> Api { get; } = api;
        public TimelineWorker Worker { get; } = api.Services.GetRequiredService<TimelineWorker>(); // starting the host runs the migrations
        public PoisonProcessor Processor { get; } = (PoisonProcessor)api.Services.GetRequiredService<ITimelineProcessor>();

        public ValueTask DisposeAsync() => Api.DisposeAsync();
    }

    private static Harness Start(string cs, TimeProvider time, IDictionary<string, string?>? settings = null)
        => new(new ApiFactory(cs, settings, time).WithWebHostBuilder(b => b.ConfigureTestServices(services =>
        {
            services.RemoveAll<ITimelineProcessor>();
            services.AddSingleton<ITimelineProcessor>(sp =>
                new PoisonProcessor(ActivatorUtilities.CreateInstance<TimelineProcessor>(sp), sp.GetRequiredService<SegmentStore>()));
        })));

    /// <summary>Runs passes until one finds nothing to do (the clock stands still, so nothing waiting out a backoff is tried).</summary>
    private static async Task DrainAsync(TimelineWorker worker)
    {
        for (var pass = 0; await worker.RunOnceAsync(Ct); pass++)
            Assert.True(pass < 100, "the worker keeps finding work");
    }

    private sealed record DirtyRow(long Id, DateTime FromUtc, DateTime ToUtc, int Attempts, DateTime? NextAttemptAt, string? LastError);

    private static Task<IReadOnlyList<DirtyRow>> DirtyAsync(string cs) => Sql.QueryAsync<DirtyRow>(cs,
        """
        select id as Id, from_utc as FromUtc, to_utc as ToUtc, attempts as Attempts, next_attempt_at as NextAttemptAt, last_error as LastError
        from dirty_range order by from_utc, id
        """, ct: Ct);

    private static Task<long> SetAsideCountAsync(string cs) => Sql.ScalarAsync<long>(cs,
        "select count(*) from dirty_range where attempts >= 3", ct: Ct);

    private static Task<DateTime?> CursorAsync(string cs) => Sql.ScalarAsync<DateTime?>(cs, "select backfill_cursor from processing_state", ct: Ct);

    private static Task<int> ChunkAttemptsAsync(string cs) => Sql.ScalarAsync<int>(cs, "select backfill_chunk_attempts from processing_state", ct: Ct);

    private static Task<bool> BackfillDoneAsync(string cs) => Sql.ScalarAsync<bool>(cs,
        "select backfill_cursor >= backfill_to from processing_state", ct: Ct);

    private static Task<long> StaysBetweenAsync(string cs, DateTime from, DateTime to) => Sql.ScalarAsync<long>(cs,
        "select count(*) from segment where kind = 'stay' and start_utc >= @from and start_utc < @to", new { from, to }, Ct);

    /// <summary>Runs passes, five minutes apart (longer than any backoff before the third failure), until <paramref name="count"/> dirty ranges are set aside.</summary>
    private static async Task RunUntilSetAsideAsync(Harness h, FakeTimeProvider clock, string cs, int count = 1)
    {
        for (var pass = 0; pass < 40; pass++)
        {
            await h.Worker.RunOnceAsync(Ct);
            if (await SetAsideCountAsync(cs) >= count)
                return;
            clock.Advance(TimeSpan.FromMinutes(5));
        }

        Assert.Fail($"fewer than {count} ranges were set aside");
    }

    /// <summary>The rows of one run over <paramref name="track"/> from the start of the day to <paramref name="to"/>, in a database of their own.</summary>
    private async Task<IReadOnlyList<string>> FullRunRowsAsync(IEnumerable<TrackPoint> track, DateTime to)
    {
        var referenceCs = await db.CreateDatabaseAsync(Ct);
        await using var reference = new ApiFactory(referenceCs);
        var processor = reference.Services.GetRequiredService<ITimelineProcessor>(); // starting the host runs the migrations
        await PointSeeder.InsertAsync(referenceCs, track, Ct);
        await processor.ReprocessAsync(T(0, 0), to, Ct);
        return await TimelineProcessorTests.CanonicalRowsAsync(referenceCs);
    }

    private static string ToOverlandPayload(IEnumerable<TrackPoint> points) => Payload.Many([.. points.Select(p =>
        Payload.Point(p.TimeUtc.ToString("o", CultureInfo.InvariantCulture), p.Longitude, p.Latitude, altitude: 10, device: p.Device))]);

    private static async Task PostAsync(Harness h, IEnumerable<TrackPoint> points)
    {
        var response = await h.Api.CreateClient().PostAsync("/api/overland",
            new StringContent(ToOverlandPayload(points), Encoding.UTF8, "application/json"), Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact] // reviewer probe N-1: the failing stretch is followed only by a short step without data, then by live data
    public async Task Failing_last_chunk_does_not_block_live_ranges()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 22)));
        await using var h = Start(cs, clock, NoPause);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 21), Ct);
        h.Processor.Poison = T(12, 0, 16); // in the third step [day 14 07:00, day 21 07:00]; the fourth is [day 21 07:00, day 22 00:00]

        await RunUntilSetAsideAsync(h, clock, cs);
        Assert.Equal(3, h.Processor.Failures);
        await DrainAsync(h.Worker); // the short last step goes through: nothing in it reaches back into the third step

        Assert.True(await BackfillDoneAsync(cs));
        Assert.Equal(3, h.Processor.Failures);
        var setAside = Assert.Single(await DirtyAsync(cs));
        Assert.Equal((T(7, 0, 14), T(0, 0, 22)), (setAside.FromUtc, setAside.ToUtc)); // the failed step and the one after it, up to where the backfill ends
        Assert.Equal(3, setAside.Attempts);

        // Live data on day 22 is processed once it has waited out the debounce.
        await PostAsync(h, CommuteDay(22));
        clock.Advance(TimeSpan.FromSeconds(61));
        await h.Worker.RunOnceAsync(Ct);

        Assert.Equal(3, h.Processor.Failures);
        Assert.Equal(3, await StaysBetweenAsync(cs, T(0, 0, 22), T(0, 0, 23)));
        Assert.Equal(setAside.Id, Assert.Single(await DirtyAsync(cs)).Id); // only the set-aside step is left
    }

    [Fact] // week 1 and 4 have data, week 2 fails, week 3 has none (the phone was off): nothing in week 4 may reach back into week 2
    public async Task Failing_middle_chunk_followed_by_stayless_week_is_isolated()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 29)));
        await using var h = Start(cs, clock, NoPause);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 14).Concat(CommuteDays(21, 7)), Ct);
        h.Processor.Poison = T(12, 0, 10); // in the second step [day 7 07:00, day 14 07:00]

        await RunUntilSetAsideAsync(h, clock, cs);
        await DrainAsync(h.Worker);

        Assert.True(await BackfillDoneAsync(cs));
        Assert.Equal(3, h.Processor.Failures); // week 3 and week 4 did not fail
        var setAside = Assert.Single(await DirtyAsync(cs)); // one set-aside row, not one per step that followed
        Assert.Equal((T(7, 0, 7), T(7, 0, 21)), (setAside.FromUtc, setAside.ToUtc)); // the failed week and the one after it
        Assert.Equal(3, setAside.Attempts);
        Assert.Equal(0, await StaysBetweenAsync(cs, T(0, 0, 8), T(0, 0, 14)));
        Assert.Equal(7 * 3, await StaysBetweenAsync(cs, T(0, 0), T(0, 0, 7))); // week 1
        Assert.Equal(7 * 3, await StaysBetweenAsync(cs, T(0, 0, 21), T(0, 0, 28)));
    }

    [Fact] // the same as above, but the process restarts after the set-aside: nothing about it may be kept in memory
    public async Task Restart_between_set_aside_and_next_chunk_keeps_isolation()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 22)));
        await using (var first = Start(cs, clock, NoPause))
        {
            await PointSeeder.InsertAsync(cs, CommuteDays(0, 21), Ct);
            first.Processor.Poison = T(12, 0, 9); // in the second step [day 7 07:00, day 14 07:00]
            await RunUntilSetAsideAsync(first, clock, cs);
            Assert.Equal(T(7, 0, 14), await CursorAsync(cs)); // the set-aside step is behind the cursor, the third is next
        }

        await using var second = Start(cs, clock, NoPause); // a fresh worker, as after a restart
        second.Processor.Poison = T(12, 0, 9);
        await DrainAsync(second.Worker);

        Assert.True(await BackfillDoneAsync(cs));
        Assert.Equal(0, second.Processor.Failures);
        Assert.Equal(7 * 3, await StaysBetweenAsync(cs, T(0, 0, 14), T(0, 0, 21)));
        var setAside = Assert.Single(await DirtyAsync(cs));
        Assert.Equal(T(7, 0, 7), setAside.FromUtc);
        Assert.Equal(3, setAside.Attempts);
    }

    [Fact] // a live range that cannot be processed was holding up everything after it
    public async Task Failing_live_range_does_not_freeze_later_live_ranges()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 8)));
        await using var h = Start(cs, clock, NoPause);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 7), Ct);
        await DrainAsync(h.Worker); // the history is done
        Assert.True(await BackfillDoneAsync(cs));
        Assert.Empty(await DirtyAsync(cs));
        h.Processor.Poison = T(12, 0, 8);

        // Day 8 arrives and cannot be processed: tried, then again after 2 and 4 minutes, then set aside.
        clock.Advance(TimeSpan.FromHours(20));
        await PostAsync(h, CommuteDay(8));
        clock.Advance(TimeSpan.FromSeconds(61));
        await RunUntilSetAsideAsync(h, clock, cs);
        Assert.Equal(3, h.Processor.Failures);
        var setAside = Assert.Single(await DirtyAsync(cs));
        Assert.Equal(T(7, 0, 8), setAside.FromUtc);

        // Day 9 arrives, and is processed: it does not reach back into day 8.
        await PostAsync(h, CommuteDay(9));
        clock.Advance(TimeSpan.FromSeconds(61));
        await h.Worker.RunOnceAsync(Ct);

        Assert.Equal(3, h.Processor.Failures);
        Assert.Equal(3, await StaysBetweenAsync(cs, T(0, 0, 9), T(0, 0, 10)));
        Assert.Equal(setAside.Id, Assert.Single(await DirtyAsync(cs)).Id);
    }

    /// <summary>
    /// Office 2 h, home overnight, office, home until 07:58 on day 2, then a stay 60 m east of home (08:01-08:29) and one
    /// 50 m west of it (08:32-08:50), then the office: the second one-day step ends (day 2 08:00) inside a stay.
    /// </summary>
    private static List<TrackPoint> SeamTrack()
    {
        var home = Spots.Home;
        var b = new TrackBuilder(T(8, 0), Spots.Office)
            .Stay(TimeSpan.FromHours(2), Every2min)
            .Travel(home, 18, Every10s);
        b.Stay(T(9, 0, 1) - b.Now, Every2min).Travel(Spots.Office, 18, Every10s); // home overnight to day 1 09:00
        b.Stay(T(17, 0, 1) - b.Now, Every2min).Travel(home, 18, Every10s);
        b.Stay(T(7, 58, 2) - b.Now, Every2min);
        b.Teleport(Geo.Offset(home, 0, 60), T(8, 1, 2) - b.Now).Stay(TimeSpan.FromMinutes(29), Every2min)
         .Teleport(Geo.Offset(home, 0, -50), TimeSpan.FromMinutes(2)).Stay(TimeSpan.FromMinutes(18), Every2min)
         .Travel(Spots.Office, 18, Every10s).Stay(TimeSpan.FromHours(8), Every2min);
        return b.Build();
    }

    [Fact] // reviewer probe N-2: a retry of a set-aside step that began inside a stay left overlapping segments behind
    public async Task Set_aside_retry_leaves_no_seam()
    {
        var track = SeamTrack();

        // The reference: the same points processed in one go.
        var referenceCs = await db.CreateDatabaseAsync(Ct);
        await using (var reference = new ApiFactory(referenceCs))
        {
            var processor = reference.Services.GetRequiredService<ITimelineProcessor>(); // starting the host runs the migrations
            await PointSeeder.InsertAsync(referenceCs, track, Ct);
            await processor.ReprocessAsync(T(0, 0), T(0, 0, 4), Ct);
        }
        var expected = await TimelineProcessorTests.CanonicalRowsAsync(referenceCs);
        Assert.Equal(9, expected.Count); // five stays and four moves, the one at the edge of the failed step among them

        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 4)));
        await using var h = Start(cs, clock, new Dictionary<string, string?>(NoPause) { ["Processing:BackfillChunkDays"] = "1" });
        await PointSeeder.InsertAsync(cs, track, Ct);
        h.Processor.FailFrom = from => from == T(8, 0, 1); // the second one-day step [day 1 08:00, day 2 08:00]

        await RunUntilSetAsideAsync(h, clock, cs);
        await DrainAsync(h.Worker);
        Assert.True(await BackfillDoneAsync(cs));
        var setAside = Assert.Single(await DirtyAsync(cs));
        Assert.Equal((T(8, 0, 1), T(8, 0, 3)), (setAside.FromUtc, setAside.ToUtc)); // the failed step and the one after it

        // Whatever was wrong is fixed (no version change): the retry rebuilds the stretch, and the seam at its edge with it.
        h.Processor.FailFrom = null;
        clock.Advance(TimeSpan.FromMinutes(9));
        await DrainAsync(h.Worker);

        Assert.Empty(await DirtyAsync(cs));
        Assert.Equal(expected, await TimelineProcessorTests.CanonicalRowsAsync(cs));
    }

    /// <summary>
    /// Office on day 0 from 08:00, then home overnight until 09:00 and the office until 17:00 on days 1 to 5. With one-day
    /// steps from 08:00, every step edge falls inside a home stay, and the far end of a set-aside range does too.
    /// </summary>
    private static List<TrackPoint> HomeNightsTrack()
    {
        var b = new TrackBuilder(T(8, 0), Spots.Office)
            .Stay(T(17, 0) - T(8, 0), Every2min)
            .Travel(Spots.Home, 18, Every10s);
        for (var day = 1; day <= 5; day++)
        {
            b.Stay(T(9, 0, day) - b.Now, Every2min).Travel(Spots.Office, 18, Every10s);
            b.Stay(T(17, 0, day) - b.Now, Every2min).Travel(Spots.Home, 18, Every10s);
        }

        return b.Stay(TimeSpan.FromHours(3), Every2min).Build();
    }

    [Fact] // the range of a set-aside step runs on over the step after it: the edge at its far end must be rebuilt too
    public async Task Set_aside_retry_leaves_no_seam_at_the_far_end_of_its_range()
    {
        var track = HomeNightsTrack();
        var expected = await FullRunRowsAsync(track, T(0, 0, 6));
        Assert.Equal(23, expected.Count); // twelve stays and eleven moves

        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 6)));
        await using var h = Start(cs, clock, new Dictionary<string, string?>(NoPause) { ["Processing:BackfillChunkDays"] = "1" });
        await PointSeeder.InsertAsync(cs, track, Ct);
        h.Processor.FailFrom = from => from == T(8, 0, 1); // the second step [day 1 08:00, day 2 08:00]

        await RunUntilSetAsideAsync(h, clock, cs);
        await DrainAsync(h.Worker);
        Assert.True(await BackfillDoneAsync(cs));
        var setAside = Assert.Single(await DirtyAsync(cs));
        Assert.Equal((T(8, 0, 1), T(8, 0, 3)), (setAside.FromUtc, setAside.ToUtc)); // its far end, day 3 08:00, is inside a home stay

        h.Processor.FailFrom = null;
        clock.Advance(TimeSpan.FromMinutes(9));
        await DrainAsync(h.Worker);

        Assert.Empty(await DirtyAsync(cs));
        Assert.Equal(expected, await TimelineProcessorTests.CanonicalRowsAsync(cs));
    }

    [Fact] // two set-aside steps in a row overlap; they are due together and are retried as one range
    public async Task Consecutive_set_aside_steps_retried_together_leave_no_seam()
    {
        var track = HomeNightsTrack();
        var expected = await FullRunRowsAsync(track, T(0, 0, 6));
        Assert.Equal(23, expected.Count);

        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 6)));
        await using var h = Start(cs, clock, new Dictionary<string, string?>(NoPause) { ["Processing:BackfillChunkDays"] = "1" });
        await PointSeeder.InsertAsync(cs, track, Ct);
        h.Processor.FailFrom = from => from == T(8, 0, 1) || from == T(8, 0, 2); // the steps [day 1 08:00, day 2 08:00] and [day 2 08:00, day 3 08:00]

        await RunUntilSetAsideAsync(h, clock, cs, count: 2);
        await DrainAsync(h.Worker);
        Assert.True(await BackfillDoneAsync(cs));
        var rows = await DirtyAsync(cs);
        Assert.Equal([(T(8, 0, 1), T(8, 0, 3)), (T(8, 0, 2), T(8, 0, 4))], rows.Select(r => (r.FromUtc, r.ToUtc)));
        Assert.All(rows, r => Assert.True(r.Attempts >= 3));

        // Fixed: both are due after a while, overlap, and are rebuilt as one range of three steps.
        h.Processor.FailFrom = null;
        clock.Advance(TimeSpan.FromHours(1));
        h.Processor.Calls.Clear();
        await DrainAsync(h.Worker);

        Assert.Equal([(T(8, 0, 1), T(8, 0, 2)), (T(8, 0, 2), T(8, 0, 3)), (T(8, 0, 3), T(8, 0, 4))], h.Processor.Calls);
        Assert.Empty(await DirtyAsync(cs));
        Assert.Equal(expected, await TimelineProcessorTests.CanonicalRowsAsync(cs));
    }

    [Fact] // the set-aside range reaches over the step after it, so the backfill-open deferral (R17) holds it back until the cursor is past
    public async Task A_set_aside_chunk_is_retried_once_the_backfill_has_passed_its_range()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 22)));
        await using var h = Start(cs, clock, NoPause);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 21), Ct);
        h.Processor.Poison = T(12, 0, 9); // in the second step [day 7 07:00, day 14 07:00]
        await RunUntilSetAsideAsync(h, clock, cs);
        Assert.Equal(T(7, 0, 14), await CursorAsync(cs));
        h.Processor.Calls.Clear();

        // Well past its backoff, but the backfill is still open and the range ends after the cursor: it waits.
        clock.Advance(TimeSpan.FromDays(1));
        await h.Worker.RunOnceAsync(Ct);
        Assert.Equal([(T(7, 0, 14), T(7, 0, 21))], h.Processor.Calls);
        await h.Worker.RunOnceAsync(Ct); // the cursor is at the end of the range now, not past it
        Assert.Equal([(T(7, 0, 14), T(7, 0, 21)), (T(7, 0, 21), T(0, 0, 22))], h.Processor.Calls);
        Assert.True(await BackfillDoneAsync(cs));
        Assert.Equal(3, (await DirtyAsync(cs)).Single().Attempts);

        // The backfill is done: now it is tried, from its start (so it is not floored by itself), and fails again.
        h.Processor.Calls.Clear();
        await h.Worker.RunOnceAsync(Ct);
        Assert.Equal([(T(7, 0, 7), T(7, 0, 14))], h.Processor.Calls);
        Assert.Equal(4, (await DirtyAsync(cs)).Single().Attempts);

        // The cause goes away: it is rebuilt over both weeks, and the row, with its floor, is gone.
        h.Processor.Poison = null;
        h.Processor.Calls.Clear();
        clock.Advance(ProcessingQueue.Backoff(4));
        await h.Worker.RunOnceAsync(Ct);
        Assert.Equal([(T(7, 0, 7), T(7, 0, 14)), (T(7, 0, 14), T(7, 0, 21))], h.Processor.Calls);
        Assert.Empty(await DirtyAsync(cs));
        Assert.Equal(21, await Sql.ScalarAsync<long>(cs, "select count(distinct local_start_date) from segment where kind = 'stay'", ct: Ct));
    }

    [Fact] // a reset starts from nothing, set-aside steps included: the backfill goes over that history again
    public async Task Version_reset_removes_set_aside_rows()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 22)));
        await using (var first = Start(cs, clock, NoPause))
        {
            await PointSeeder.InsertAsync(cs, CommuteDays(0, 21), Ct);
            first.Processor.Poison = T(12, 0, 9);
            await RunUntilSetAsideAsync(first, clock, cs);
        }
        await Sql.ExecAsync(cs,
            "insert into dirty_range (from_utc, to_utc, created_at, attempts) values (@from, @to, @at, 1)",
            new { from = T(8, 0, 18), to = T(9, 0, 18), at = T(0, 0, 18) }, Ct); // failed once: not set aside, and still waiting
        await Sql.ExecAsync(cs, "update processing_state set backfill_chunk_attempts = 2, paused = true", ct: Ct); // paused: the reset can be seen before it moves on
        Assert.Equal(1, await SetAsideCountAsync(cs));

        await using var second = Start(cs, clock, new Dictionary<string, string?> { ["Detection:StayRadiusMeters"] = "150" });
        await second.Worker.RunOnceAsync(Ct);

        Assert.Equal(0, await SetAsideCountAsync(cs));
        Assert.Equal(T(8, 0, 18), Assert.Single(await DirtyAsync(cs)).FromUtc); // only what was set aside is gone
        Assert.Equal(0, await ChunkAttemptsAsync(cs));
        Assert.Equal(0, await Sql.ScalarAsync<long>(cs, "select count(*) from segment", ct: Ct));
    }

    [Fact] // a process killed in the middle of a chunk (out of memory) cannot count its failures in memory
    public async Task Chunk_attempts_survive_a_crash()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 22)));
        await using var h = Start(cs, clock, NoPause);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 21), Ct);
        await h.Worker.RunOnceAsync(Ct); // the first week
        Assert.Equal(T(7, 0, 7), await CursorAsync(cs));
        h.Processor.Calls.Clear();

        // The three earlier starts of the second week all ended in a crash, so the fourth does not try it again.
        await Sql.ExecAsync(cs, "update processing_state set backfill_chunk_attempts = 3", ct: Ct);
        await h.Worker.RunOnceAsync(Ct);

        Assert.Empty(h.Processor.Calls); // not run
        var setAside = Assert.Single(await DirtyAsync(cs));
        Assert.Equal((T(7, 0, 7), T(7, 0, 21)), (setAside.FromUtc, setAside.ToUtc));
        Assert.Equal(3, setAside.Attempts);
        Assert.NotEmpty(setAside.LastError!);
        Assert.Equal(T(7, 0, 14), await CursorAsync(cs));
        Assert.Equal(0, await ChunkAttemptsAsync(cs)); // the next chunk starts counting afresh
        await DrainAsync(h.Worker);
        Assert.True(await BackfillDoneAsync(cs));
    }

    [Fact]
    public async Task A_chunk_attempt_is_stored_before_the_chunk_runs_and_cleared_when_it_succeeds()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 22)));
        await using var h = Start(cs, clock, NoPause);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 21), Ct);
        var seen = new List<int>();
        h.Processor.OnCall = async () => seen.Add(await ChunkAttemptsAsync(cs));

        await h.Worker.RunOnceAsync(Ct); // the first week succeeds

        Assert.Equal([1], seen); // already counted while it ran, which is what a crash would leave behind
        Assert.Equal(0, await ChunkAttemptsAsync(cs));

        h.Processor.FailFrom = from => from == T(7, 0, 7);
        seen.Clear();
        await h.Worker.RunOnceAsync(Ct); // the second week fails
        clock.Advance(TimeSpan.FromMinutes(5));
        await h.Worker.RunOnceAsync(Ct);

        Assert.Equal([1, 2], seen);
        Assert.Equal(2, await ChunkAttemptsAsync(cs)); // a failure is not forgotten between passes
        Assert.Empty(await DirtyAsync(cs));
    }
}
