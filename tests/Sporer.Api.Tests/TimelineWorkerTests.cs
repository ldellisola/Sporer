using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Time.Testing;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

[Collection("db")]
public class TimelineWorkerTests(DatabaseFixture db)
{
    private static readonly DateTime Day = new(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Every2min = TimeSpan.FromMinutes(2);

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

    private static IEnumerable<TrackPoint> CommuteDays(int firstDay, int count)
        => Enumerable.Range(firstDay, count).SelectMany(CommuteDay);

    /// <summary>A "now" after the three weeks of seeded history.</summary>
    private static FakeTimeProvider ClockAfterThreeWeeks() => new(new DateTimeOffset(T(0, 0, 22)));

    /// <summary>
    /// Wraps the real processor: records every range it is asked to rebuild, can be told to fail the next call, and can
    /// be told to fail every call that matches a condition (a range that cannot be processed, however often it is tried).
    /// </summary>
    private sealed class RecordingProcessor(ITimelineProcessor inner) : ITimelineProcessor
    {
        private Exception? _failNext;
        private Func<DateTime, DateTime, bool>? _failWhen;

        private readonly ConcurrentQueue<(DateTime From, DateTime To)> _calls = new();

        /// <summary>The ranges asked for, in order.</summary>
        public IEnumerable<(DateTime From, DateTime To)> Calls => _calls;

        public void FailNext(Exception error) => _failNext = error;

        /// <summary>Fails every call whose range matches, with the same error each time; null stops it.</summary>
        public void FailWhen(Func<DateTime, DateTime, bool>? matches) => _failWhen = matches;

        public (DateTime From, DateTime To)[] TakeCalls()
        {
            var calls = Calls.ToArray();
            _calls.Clear();
            return calls;
        }

        public async Task<ReprocessResult> ReprocessAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct)
        {
            _calls.Enqueue((fromUtc, toUtc));
            if (Interlocked.Exchange(ref _failNext, null) is { } error)
                throw error;
            if (_failWhen?.Invoke(fromUtc, toUtc) == true)
                throw new InvalidOperationException("this range cannot be processed");
            return await inner.ReprocessAsync(fromUtc, toUtc, ct);
        }
    }

    /// <summary>
    /// Rebuilds nothing and says it rebuilt from two hours before the range to three hours after it: a window that is not
    /// the range, so that a test can tell what the worker takes from the result.
    /// </summary>
    private sealed class WindowProcessor : ITimelineProcessor
    {
        public Task<ReprocessResult> ReprocessAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct)
            => Task.FromResult(new ReprocessResult(0, fromUtc.AddHours(-2), toUtc.AddHours(3)));
    }

    /// <summary>Wraps the real refresher: records every window it is asked to refresh, and can be told to fail every call.</summary>
    private sealed class RecordingRefresher(ITripRefresher inner) : ITripRefresher
    {
        private Exception? _failWith;
        private readonly ConcurrentQueue<(DateTime From, DateTime To)> _calls = new();

        /// <summary>The windows asked for, in order.</summary>
        public IEnumerable<(DateTime From, DateTime To)> Calls => _calls;

        /// <summary>Fails every call with <paramref name="error"/>; null stops it.</summary>
        public void FailWith(Exception? error) => _failWith = error;

        /// <summary>Runs, awaited, when a refresh is asked for, before anything else (it can cancel, as a host that stops does).</summary>
        public Func<CancellationToken, Task>? OnCall { get; set; }

        public (DateTime From, DateTime To)[] TakeCalls()
        {
            var calls = Calls.ToArray();
            _calls.Clear();
            return calls;
        }

        public async Task RefreshAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct)
        {
            _calls.Enqueue((fromUtc, toUtc));
            if (OnCall is { } hook)
                await hook(ct);
            if (_failWith is { } error)
                throw error;
            await inner.RefreshAsync(fromUtc, toUtc, ct);
        }
    }

    private sealed class Harness(WebApplicationFactory<Program> api) : IAsyncDisposable
    {
        public WebApplicationFactory<Program> Api { get; } = api;
        public TimelineWorker Worker { get; } = api.Services.GetRequiredService<TimelineWorker>(); // starting the host runs the migrations
        public RecordingProcessor Processor { get; } = (RecordingProcessor)api.Services.GetRequiredService<ITimelineProcessor>();
        public RecordingRefresher Refresher { get; } = (RecordingRefresher)api.Services.GetRequiredService<ITripRefresher>();

        public ValueTask DisposeAsync() => Api.DisposeAsync();
    }

    /// <summary>The processor underneath the recording one is the real one, unless <paramref name="processor"/> makes another.</summary>
    private static Harness Start(
        string cs, TimeProvider time, IDictionary<string, string?>? settings = null, Func<IServiceProvider, ITimelineProcessor>? processor = null)
        => new(new ApiFactory(cs, settings, time).WithWebHostBuilder(b => b.ConfigureTestServices(services =>
        {
            services.RemoveAll<ITimelineProcessor>();
            services.AddSingleton<ITimelineProcessor>(sp =>
                new RecordingProcessor(processor?.Invoke(sp) ?? ActivatorUtilities.CreateInstance<TimelineProcessor>(sp)));
            services.RemoveAll<ITripRefresher>();
            services.AddSingleton<ITripRefresher>(sp => new RecordingRefresher(sp.GetRequiredService<TripRefresher>()));
        })));

    /// <summary>Runs passes until one finds nothing to do.</summary>
    private static async Task FinishBackfillAsync(TimelineWorker worker)
    {
        for (var pass = 0; await worker.RunOnceAsync(Ct); pass++)
            Assert.True(pass < 100, "the worker keeps finding work");
    }

    private static async Task WaitForAsync(Func<Task<bool>> condition, string what)
    {
        var until = DateTime.UtcNow.AddSeconds(20);
        while (!await condition())
        {
            Assert.True(DateTime.UtcNow < until, $"timed out waiting for {what}");
            await Task.Delay(20, Ct);
        }
    }

    private sealed record StateRow(
        string? AlgorithmVersion, DateTime? BackfillFrom, DateTime? BackfillTo, DateTime? BackfillCursor,
        bool Paused, DateTime? LastRunAt, string? LastError);

    private static async Task<StateRow> StateAsync(string cs) => (await Sql.QueryAsync<StateRow>(cs,
        """
        select algorithm_version as AlgorithmVersion, backfill_from as BackfillFrom, backfill_to as BackfillTo,
               backfill_cursor as BackfillCursor, paused as Paused, last_run_at as LastRunAt, last_error as LastError
        from processing_state where id = 1
        """, ct: Ct)).Single();

    private sealed record DirtyRow(long Id, DateTime FromUtc, DateTime ToUtc, int Attempts, DateTime? NextAttemptAt, string? LastError);

    private static Task<IReadOnlyList<DirtyRow>> DirtyAsync(string cs, bool onlyFailed = false) => Sql.QueryAsync<DirtyRow>(cs,
        $"""
        select id as Id, from_utc as FromUtc, to_utc as ToUtc, attempts as Attempts, next_attempt_at as NextAttemptAt, last_error as LastError
        from dirty_range {(onlyFailed ? "where attempts > 0" : "")} order by from_utc, id
        """, ct: Ct);

    private static Task AddDirtyAsync(string cs, DateTime from, DateTime to, DateTime createdAt) => Sql.ExecAsync(cs,
        "insert into dirty_range (from_utc, to_utc, created_at) values (@from, @to, @createdAt)",
        new { from, to, createdAt }, Ct);

    private static Task<long> CountAsync(string cs, string table) => Sql.ScalarAsync<long>(cs, $"select count(*) from {table}", ct: Ct);

    private sealed record PendingRow(DateTime? FromUtc, DateTime? ToUtc);

    /// <summary>The window waiting to be refreshed (<c>night_refresh</c>): both null when nothing is.</summary>
    private static async Task<(DateTime? From, DateTime? To)> PendingAsync(string cs)
    {
        var row = (await Sql.QueryAsync<PendingRow>(cs, "select from_utc as FromUtc, to_utc as ToUtc from night_refresh where id = 1", ct: Ct)).Single();
        return (row.FromUtc, row.ToUtc);
    }

    private static Task<long> StaysBetweenAsync(string cs, DateTime from, DateTime to) => Sql.ScalarAsync<long>(cs,
        "select count(*) from segment where kind = 'stay' and start_utc >= @from and start_utc < @to", new { from, to }, Ct);

    private static string ToOverlandPayload(IEnumerable<TrackPoint> points) => Payload.Many([.. points.Select(p =>
        Payload.Point(p.TimeUtc.ToString("o", CultureInfo.InvariantCulture), p.Longitude, p.Latitude, altitude: 10, device: p.Device))]);

    [Fact]
    public void Algorithm_version_is_the_code_version_and_a_hash_of_the_thresholds()
    {
        var version = AlgorithmVersion.Compute(new DetectionOptions());

        Assert.Matches("^2:[0-9a-f]{12}$", version);
        Assert.StartsWith($"{AlgorithmVersion.CodeVersion}:", version);
        Assert.Equal(version, AlgorithmVersion.Compute(new DetectionOptions()));
        Assert.NotEqual(version, AlgorithmVersion.Compute(new DetectionOptions { StayRadiusMeters = 150 }));
        Assert.NotEqual(version, AlgorithmVersion.Compute(new DetectionOptions { StayMinDuration = TimeSpan.FromMinutes(6) }));
        Assert.NotEqual(version, AlgorithmVersion.Compute(new DetectionOptions { HomeMinNights = 61 })); // the home and trip options count too
    }

    [Fact]
    public void AlgorithmVersion_code_version_is_2()
    {
        // 2 is the code that derives nights, homes and trips: a database built by version 1 has none, and is rebuilt once.
        Assert.Equal(2, AlgorithmVersion.CodeVersion);
        Assert.StartsWith("2:", AlgorithmVersion.Compute(new DetectionOptions()));
    }

    [Fact]
    public void Backoff_doubles_from_two_minutes_up_to_six_hours()
    {
        Assert.Equal(TimeSpan.FromMinutes(2), ProcessingQueue.Backoff(1));
        Assert.Equal(TimeSpan.FromMinutes(4), ProcessingQueue.Backoff(2));
        Assert.Equal(TimeSpan.FromMinutes(256), ProcessingQueue.Backoff(8));
        Assert.Equal(TimeSpan.FromHours(6), ProcessingQueue.Backoff(9));
        Assert.Equal(TimeSpan.FromHours(6), ProcessingQueue.Backoff(10_000));
    }

    [Fact]
    public async Task The_worker_runs_in_the_background_only_when_processing_is_enabled()
    {
        var cs = await db.CreateDatabaseAsync(Ct);

        await using (var off = new ApiFactory(cs)) // Processing:Enabled=false, as in every test
        {
            Assert.NotNull(off.Services.GetService<TimelineWorker>()); // still there to be driven by hand
            Assert.Empty(off.Services.GetServices<IHostedService>().OfType<TimelineWorker>());
        }

        await using var on = new ApiFactory(cs, new Dictionary<string, string?> { ["Processing:Enabled"] = "true" });
        var hosted = Assert.Single(on.Services.GetServices<IHostedService>().OfType<TimelineWorker>());
        Assert.Same(on.Services.GetRequiredService<TimelineWorker>(), hosted); // one worker, not a second copy
    }

    [Fact]
    public async Task First_run_backfills_all_history()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 21), Ct);

        await FinishBackfillAsync(h.Worker);

        var state = await StateAsync(cs);
        Assert.Equal(AlgorithmVersion.Compute(new DetectionOptions()), state.AlgorithmVersion);
        Assert.Equal(T(7, 0), state.BackfillFrom);
        Assert.Equal(clock.GetUtcNow().UtcDateTime, state.BackfillTo);
        Assert.True(state.BackfillCursor >= state.BackfillTo);
        Assert.Equal(clock.GetUtcNow().UtcDateTime, state.LastRunAt);
        Assert.Null(state.LastError);

        // Stays in every one of the three weeks, one set for each of the 21 days.
        foreach (var week in new[] { 0, 7, 14 })
            Assert.True(await StaysBetweenAsync(cs, T(0, 0, week), T(0, 0, week + 7)) >= 21, $"stays in the week from day {week}");
        Assert.Equal(21, await Sql.ScalarAsync<long>(cs, "select count(distinct local_start_date) from segment where kind = 'stay'", ct: Ct));
        Assert.Equal(3, await CountAsync(cs, "place"));

        // Oldest first, in chunks of a week; the last one ends where the backfill does.
        Assert.Equal(
            [(T(7, 0), T(7, 0, 7)), (T(7, 0, 7), T(7, 0, 14)), (T(7, 0, 14), T(7, 0, 21)), (T(7, 0, 21), clock.GetUtcNow().UtcDateTime)],
            h.Processor.Calls.ToArray());
        Assert.False(await h.Worker.RunOnceAsync(Ct));
    }

    [Fact]
    public async Task First_run_on_an_empty_database_is_immediately_complete()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);

        Assert.True(await h.Worker.RunOnceAsync(Ct)); // records the version
        Assert.False(await h.Worker.RunOnceAsync(Ct));

        var state = await StateAsync(cs);
        Assert.Equal(AlgorithmVersion.Compute(new DetectionOptions()), state.AlgorithmVersion);
        Assert.Null(state.BackfillFrom);
        Assert.Null(state.BackfillTo);
        Assert.Null(state.BackfillCursor);
        Assert.Equal(clock.GetUtcNow().UtcDateTime, state.LastRunAt);
        Assert.Empty(h.Processor.Calls);
        Assert.Equal(0, await CountAsync(cs, "segment"));
    }

    [Fact]
    public async Task Dirty_range_waits_for_debounce()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(18, 0, 7)));
        await using var h = Start(cs, clock);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 7), Ct);
        await FinishBackfillAsync(h.Worker); // the initial backfill is out of the way: this is about the dirty-range path
        Assert.Equal(0, await CountAsync(cs, "dirty_range"));
        h.Processor.TakeCalls();
        var segmentsBefore = await CountAsync(cs, "segment");

        var res = await h.Api.CreateClient().PostAsync("/api/overland",
            new StringContent(ToOverlandPayload(CommuteDay(7)), Encoding.UTF8, "application/json"), Ct);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(1, await CountAsync(cs, "dirty_range"));

        clock.Advance(TimeSpan.FromSeconds(10));
        Assert.False(await h.Worker.RunOnceAsync(Ct));
        Assert.Equal(segmentsBefore, await CountAsync(cs, "segment"));
        Assert.Equal(1, await CountAsync(cs, "dirty_range"));
        Assert.Empty(h.Processor.Calls);

        clock.Advance(TimeSpan.FromSeconds(51));
        Assert.True(await h.Worker.RunOnceAsync(Ct));
        Assert.Equal(0, await CountAsync(cs, "dirty_range"));
        Assert.Equal(3, await StaysBetweenAsync(cs, T(0, 0, 7), T(0, 0, 8)));
        var call = Assert.Single(h.Processor.Calls); // the posted batch's own range: first point to last point
        Assert.Equal(T(7, 0, 7), call.From);
        Assert.Equal(CommuteDay(7)[^1].TimeUtc, call.To);
        Assert.False(await h.Worker.RunOnceAsync(Ct));
    }

    [Fact]
    public async Task Failed_range_is_retried_later()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 3), Ct);
        await FinishBackfillAsync(h.Worker);
        h.Processor.TakeCalls();
        await AddDirtyAsync(cs, T(8, 0, 1), T(9, 0, 1), clock.GetUtcNow().UtcDateTime.AddMinutes(-5));

        h.Processor.FailNext(new InvalidOperationException("boom"));
        Assert.True(await h.Worker.RunOnceAsync(Ct));

        var failedAt = clock.GetUtcNow().UtcDateTime;
        var row = Assert.Single(await DirtyAsync(cs));
        Assert.Equal(1, row.Attempts);
        Assert.Contains("boom", row.LastError);
        Assert.Equal(failedAt.AddMinutes(2), row.NextAttemptAt);
        Assert.Single(h.Processor.TakeCalls());

        // Not before the backoff has passed: the row is left as it was.
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.False(await h.Worker.RunOnceAsync(Ct));
        Assert.Equal(row, Assert.Single(await DirtyAsync(cs)));
        Assert.Empty(h.Processor.Calls);

        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.True(await h.Worker.RunOnceAsync(Ct));
        Assert.Empty(await DirtyAsync(cs));
        Assert.Equal([(T(8, 0, 1), T(9, 0, 1))], h.Processor.TakeCalls());
        Assert.False(await h.Worker.RunOnceAsync(Ct));
    }

    [Fact]
    public async Task A_failing_range_does_not_stop_the_others()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await FinishBackfillAsync(h.Worker); // empty database: nothing to backfill
        var old = clock.GetUtcNow().UtcDateTime.AddMinutes(-5);
        await AddDirtyAsync(cs, T(8, 0, 1), T(9, 0, 1), old);
        await AddDirtyAsync(cs, T(8, 0, 5), T(9, 0, 5), old);

        h.Processor.FailNext(new InvalidOperationException("first one fails"));
        await h.Worker.RunOnceAsync(Ct);

        var left = Assert.Single(await DirtyAsync(cs)); // the second range went through
        Assert.Equal(T(8, 0, 1), left.FromUtc);
        Assert.Equal(1, left.Attempts);
    }

    [Fact]
    public async Task Overlapping_and_nearby_ranges_are_merged()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await FinishBackfillAsync(h.Worker); // empty database: nothing to backfill
        var old = clock.GetUtcNow().UtcDateTime.AddMinutes(-5);
        await AddDirtyAsync(cs, T(10, 0), T(10, 30), old);
        await AddDirtyAsync(cs, T(10, 20), T(11, 0), old);  // overlaps the first
        await AddDirtyAsync(cs, T(11, 30), T(12, 0), old);  // starts 30 min after the second ends
        await AddDirtyAsync(cs, T(15, 0), T(15, 10), old);  // 3 h later: separate
        await AddDirtyAsync(cs, T(16, 10), T(16, 20), old); // exactly 1 h after the previous one ends: merged
        await AddDirtyAsync(cs, T(17, 21), T(17, 30), old); // 1 h 1 min after: separate

        await h.Worker.RunOnceAsync(Ct);

        Assert.Equal(
            [(T(10, 0), T(12, 0)), (T(15, 0), T(16, 20)), (T(17, 21), T(17, 30))],
            h.Processor.Calls.ToArray());
        Assert.Empty(await DirtyAsync(cs));
    }

    [Fact]
    public async Task A_group_is_due_once_its_oldest_range_has_waited_and_takes_the_newer_ones_with_it()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await FinishBackfillAsync(h.Worker);
        var now = clock.GetUtcNow().UtcDateTime;
        await AddDirtyAsync(cs, T(10, 0), T(10, 30), now.AddSeconds(-60)); // exactly the debounce old: due
        await AddDirtyAsync(cs, T(10, 20), T(10, 40), now.AddSeconds(-59)); // overlaps it: one second short, but it goes with it
        await AddDirtyAsync(cs, T(11, 30), T(11, 40), now.AddSeconds(-5));  // within an hour of it: the same group
        await AddDirtyAsync(cs, T(15, 0), T(15, 10), now.AddSeconds(-59));  // a group of its own, not old enough: it waits

        await h.Worker.RunOnceAsync(Ct);

        Assert.Equal([(T(10, 0), T(11, 40))], h.Processor.Calls.ToArray());
        Assert.Equal(T(15, 0), Assert.Single(await DirtyAsync(cs)).FromUtc);
    }

    [Fact]
    public async Task A_group_of_ranges_that_have_all_waited_less_than_the_debounce_is_not_due()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await FinishBackfillAsync(h.Worker);
        var now = clock.GetUtcNow().UtcDateTime;
        await AddDirtyAsync(cs, T(10, 0), T(10, 30), now.AddSeconds(-59));
        await AddDirtyAsync(cs, T(10, 20), T(10, 40), now.AddSeconds(-1));

        Assert.False(await h.Worker.RunOnceAsync(Ct));

        Assert.Empty(h.Processor.Calls);
        Assert.Equal(2, (await DirtyAsync(cs)).Count);
    }

    [Fact]
    public async Task A_stream_of_batches_is_processed_at_most_once_per_debounce()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await FinishBackfillAsync(h.Worker);

        // A batch every 20 seconds for four minutes, all of it near the same time: each one is recorded when it arrives.
        var processedAt = new List<TimeSpan>();
        var start = clock.GetUtcNow().UtcDateTime;
        for (var second = 0; second <= 240; second += 20)
        {
            await AddDirtyAsync(cs, T(10, 0).AddSeconds(second), T(10, 0).AddSeconds(second + 20), clock.GetUtcNow().UtcDateTime);
            if (await h.Worker.RunOnceAsync(Ct))
                processedAt.Add(clock.GetUtcNow().UtcDateTime - start);
            clock.Advance(TimeSpan.FromSeconds(20));
        }

        // At 60 s the first batch has waited a minute, and the group it belongs to goes with it: the batches of 0, 20, 40 and
        // 60 s. The next group is due a minute after its first batch (80 s), at 140 s, and the next at 220 s. Before, every
        // batch became due a minute after it arrived: a pass every 20 s, as often as the batches come.
        Assert.Equal([TimeSpan.FromSeconds(60), TimeSpan.FromSeconds(140), TimeSpan.FromSeconds(220)], processedAt);
        Assert.Equal(
            [(T(10, 0), T(10, 0).AddSeconds(80)), (T(10, 0).AddSeconds(80), T(10, 0).AddSeconds(160)), (T(10, 0).AddSeconds(160), T(10, 0).AddSeconds(240))],
            h.Processor.Calls.ToArray());
        Assert.Equal(T(10, 0).AddSeconds(240), Assert.Single(await DirtyAsync(cs)).FromUtc); // the last batch is still waiting
    }

    [Fact]
    public async Task A_dirty_range_longer_than_a_backfill_step_is_processed_in_bounded_pieces_oldest_first()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 100)));
        await using var h = Start(cs, clock); // BackfillChunkDays is 7
        await FinishBackfillAsync(h.Worker); // empty database: nothing to backfill
        var old = clock.GetUtcNow().UtcDateTime.AddMinutes(-5);
        await AddDirtyAsync(cs, T(8, 0), T(8, 0, 30), old);       // 30 days: four pieces of a week and one of two days
        await AddDirtyAsync(cs, T(8, 0, 40), T(8, 0, 47), old);   // exactly a week: one piece
        await AddDirtyAsync(cs, T(8, 0, 60), T(8, 30, 60), old);  // half an hour: one piece, as before

        Assert.True(await h.Worker.RunOnceAsync(Ct));

        Assert.Equal(
            [
                (T(8, 0), T(8, 0, 7)), (T(8, 0, 7), T(8, 0, 14)), (T(8, 0, 14), T(8, 0, 21)), (T(8, 0, 21), T(8, 0, 28)), (T(8, 0, 28), T(8, 0, 30)),
                (T(8, 0, 40), T(8, 0, 47)),
                (T(8, 0, 60), T(8, 30, 60)),
            ],
            h.Processor.Calls.ToArray());
        Assert.Empty(await DirtyAsync(cs)); // every row is done once all the pieces of its range are
    }

    [Fact]
    public async Task A_failing_piece_fails_the_whole_range_and_the_retry_starts_again_from_the_oldest_piece()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(T(0, 0, 100)));
        await using var h = Start(cs, clock);
        await FinishBackfillAsync(h.Worker);
        var old = clock.GetUtcNow().UtcDateTime.AddMinutes(-5);
        await AddDirtyAsync(cs, T(8, 0), T(8, 0, 30), old);
        await AddDirtyAsync(cs, T(8, 0, 30).AddMinutes(30), T(8, 0, 31), old); // within an hour of the first: one group, two rows
        h.Processor.FailWhen((from, _) => from == T(8, 0, 14));

        Assert.True(await h.Worker.RunOnceAsync(Ct));

        // Up to the third piece, which fails; the later ones are left for the retry. Both rows of the group fail with it.
        Assert.Equal([T(8, 0), T(8, 0, 7), T(8, 0, 14)], h.Processor.TakeCalls().Select(c => c.From));
        var rows = await DirtyAsync(cs);
        Assert.Equal(2, rows.Count);
        Assert.All(rows, r =>
        {
            Assert.Equal(1, r.Attempts);
            Assert.Contains("this range cannot be processed", r.LastError);
        });

        h.Processor.FailWhen(null);
        clock.Advance(TimeSpan.FromMinutes(2));
        Assert.True(await h.Worker.RunOnceAsync(Ct));
        Assert.Equal(
            [T(8, 0), T(8, 0, 7), T(8, 0, 14), T(8, 0, 21), T(8, 0, 28)],
            h.Processor.TakeCalls().Select(c => c.From));
        Assert.Empty(await DirtyAsync(cs));
    }

    [Fact]
    public async Task Changed_threshold_triggers_backfill()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        string oldVersion;
        await using (var first = Start(cs, clock))
        {
            await PointSeeder.InsertAsync(cs, CommuteDays(0, 21), Ct);
            await FinishBackfillAsync(first.Worker);
            var done = await StateAsync(cs);
            Assert.True(done.BackfillCursor >= done.BackfillTo);
            oldVersion = done.AlgorithmVersion!;
        }
        await Sql.ExecAsync(cs, "update processing_state set paused = true", ct: Ct); // so the reset can be seen before it moves on
        clock.Advance(TimeSpan.FromHours(1));

        await using var second = Start(cs, clock, new Dictionary<string, string?> { ["Detection:StayRadiusMeters"] = "150" });
        Assert.True(await second.Worker.RunOnceAsync(Ct));

        var newVersion = AlgorithmVersion.Compute(new DetectionOptions { StayRadiusMeters = 150 });
        var state = await StateAsync(cs);
        Assert.NotEqual(oldVersion, newVersion);
        Assert.Equal(newVersion, state.AlgorithmVersion);
        Assert.Equal(await Sql.ScalarAsync<DateTime>(cs, "select min(time) from locationlog", ct: Ct), state.BackfillFrom);
        Assert.Equal(state.BackfillFrom, state.BackfillCursor);
        Assert.Equal(clock.GetUtcNow().UtcDateTime, state.BackfillTo);
        Assert.Empty(second.Processor.Calls); // paused: nothing else yet

        // Unpaused, it runs again from the start and finishes.
        await Sql.ExecAsync(cs, "update processing_state set paused = false", ct: Ct);
        await FinishBackfillAsync(second.Worker);
        state = await StateAsync(cs);
        Assert.True(state.BackfillCursor >= state.BackfillTo);
        Assert.Equal(T(7, 0), second.Processor.Calls.First().From);
        Assert.Equal(21, await Sql.ScalarAsync<long>(cs, "select count(distinct local_start_date) from segment where kind = 'stay'", ct: Ct));
    }

    [Fact]
    public async Task Version_change_clears_segments_but_keeps_places_and_points()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using (var first = Start(cs, clock))
        {
            await PointSeeder.InsertAsync(cs, CommuteDays(0, 3), Ct);
            await FinishBackfillAsync(first.Worker);
        }
        var (segments, places, points) = (await CountAsync(cs, "segment"), await CountAsync(cs, "place"), await CountAsync(cs, "locationlog"));
        Assert.True(segments > 0);
        Assert.Equal(3, places);
        await Sql.ExecAsync(cs, "update processing_state set paused = true", ct: Ct);

        await using var second = Start(cs, clock, new Dictionary<string, string?> { ["Detection:StayRadiusMeters"] = "150" });
        await second.Worker.RunOnceAsync(Ct);

        Assert.Equal(0, await CountAsync(cs, "segment")); // the old algorithm's stays must not anchor the rebuild
        Assert.Equal(places, await CountAsync(cs, "place"));
        Assert.Equal(points, await CountAsync(cs, "locationlog"));

        // The rebuild finds the same places again rather than making new ones.
        await Sql.ExecAsync(cs, "update processing_state set paused = false", ct: Ct);
        await FinishBackfillAsync(second.Worker);
        Assert.Equal(places, await CountAsync(cs, "place"));
        Assert.Equal(3, await Sql.ScalarAsync<long>(cs, "select count(distinct place_id) from segment where kind = 'stay'", ct: Ct));
    }

    [Fact]
    public async Task Paused_backfill_does_not_advance()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 21), Ct);
        Assert.True(await h.Worker.RunOnceAsync(Ct)); // resets and does the first week
        var cursor = (await StateAsync(cs)).BackfillCursor;
        Assert.Equal(T(7, 0, 7), cursor);
        await Sql.ExecAsync(cs, "update processing_state set paused = true", ct: Ct);
        var old = clock.GetUtcNow().UtcDateTime.AddMinutes(-5);
        await AddDirtyAsync(cs, T(8, 0, 2), T(9, 0, 2), old);   // behind the cursor
        await AddDirtyAsync(cs, T(8, 0, 10), T(9, 0, 10), old); // ahead of it
        h.Processor.TakeCalls();

        Assert.True(await h.Worker.RunOnceAsync(Ct));

        Assert.Equal(cursor, (await StateAsync(cs)).BackfillCursor);
        Assert.Equal([(T(8, 0, 2), T(9, 0, 2))], h.Processor.TakeCalls()); // no backfill step, the range behind the cursor only
        var left = Assert.Single(await DirtyAsync(cs));
        Assert.Equal(T(8, 0, 10), left.FromUtc);
        Assert.Equal((0, null, null), (left.Attempts, left.NextAttemptAt, left.LastError));

        // Nothing more to do while it stays paused, however often it runs.
        Assert.False(await h.Worker.RunOnceAsync(Ct));
        Assert.Equal(cursor, (await StateAsync(cs)).BackfillCursor);
        Assert.Empty(h.Processor.Calls);
    }

    [Fact]
    public async Task Range_ahead_of_the_backfill_cursor_is_deferred_until_the_cursor_passes_it()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 21), Ct);
        await h.Worker.RunOnceAsync(Ct); // week 1; the cursor is at the start of week 2
        var cursor = T(7, 0, 7);
        Assert.Equal(cursor, (await StateAsync(cs)).BackfillCursor);
        var old = clock.GetUtcNow().UtcDateTime.AddMinutes(-5);
        await AddDirtyAsync(cs, T(8, 0, 2), T(9, 0, 2), old);     // behind the cursor
        await AddDirtyAsync(cs, T(23, 0, 6), cursor, old);        // ends exactly at the cursor: not behind it
        await AddDirtyAsync(cs, T(8, 0, 9), T(9, 0, 9), old);     // ahead of it
        h.Processor.TakeCalls();

        await h.Worker.RunOnceAsync(Ct);

        // The range behind the cursor, then the next backfill step. The other two wait: not processed, not failed.
        Assert.Equal([(T(8, 0, 2), T(9, 0, 2)), (cursor, T(7, 0, 14))], h.Processor.TakeCalls());
        Assert.Equal([T(23, 0, 6), T(8, 0, 9)], (await DirtyAsync(cs)).Select(r => r.FromUtc));
        Assert.All(await DirtyAsync(cs), r => Assert.Equal((0, null, null), (r.Attempts, r.NextAttemptAt, r.LastError)));

        // The cursor has moved past both now: the next pass processes them.
        await h.Worker.RunOnceAsync(Ct);
        Assert.Equal([(T(23, 0, 6), cursor), (T(8, 0, 9), T(9, 0, 9)), (T(7, 0, 14), T(7, 0, 21))], h.Processor.TakeCalls());
        Assert.Empty(await DirtyAsync(cs));
    }

    [Fact]
    public async Task Failed_backfill_step_is_recorded_and_retried_later()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 14), Ct);

        h.Processor.FailNext(new InvalidOperationException("chunk exploded"));
        Assert.True(await h.Worker.RunOnceAsync(Ct));

        var state = await StateAsync(cs);
        Assert.Equal(T(7, 0), state.BackfillCursor); // not advanced
        Assert.Contains("chunk exploded", state.LastError);
        Assert.Single(h.Processor.TakeCalls());

        // It waits before trying that step again...
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.False(await h.Worker.RunOnceAsync(Ct));
        Assert.Empty(h.Processor.Calls);
        Assert.Contains("chunk exploded", (await StateAsync(cs)).LastError);

        // ...and then carries on from where it was.
        clock.Advance(TimeSpan.FromMinutes(1));
        await FinishBackfillAsync(h.Worker);
        state = await StateAsync(cs);
        Assert.True(state.BackfillCursor >= state.BackfillTo);
        Assert.Null(state.LastError);
        Assert.Equal(T(7, 0), h.Processor.Calls.First().From);
    }

    /// <summary>
    /// Three weeks of history, the second week's backfill step cannot be processed. Returns once the worker has set that step
    /// aside: three failures, the first after the pass that did week one, the others after the backoff of 2 and 4 minutes.
    /// </summary>
    private static async Task<(Harness H, FakeTimeProvider Clock, string Cs, DateTime SetAsideAt)> SetAsideSecondWeekAsync(
        DatabaseFixture db, bool liveRangeAhead)
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        var h = Start(cs, clock, new Dictionary<string, string?> { ["Processing:BackfillPause"] = "00:00:00" });
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 21), Ct);
        h.Processor.FailWhen((from, _) => from == T(7, 0, 7));

        Assert.True(await h.Worker.RunOnceAsync(Ct)); // week 1
        Assert.True(await h.Worker.RunOnceAsync(Ct)); // week 2: first failure
        clock.Advance(TimeSpan.FromMinutes(2));
        Assert.True(await h.Worker.RunOnceAsync(Ct)); // second
        Assert.Empty(await DirtyAsync(cs));           // still only a failing step, not yet set aside
        Assert.Equal(T(7, 0, 7), (await StateAsync(cs)).BackfillCursor);

        if (liveRangeAhead) // live data: ahead of the cursor, so it waits for the backfill
            await AddDirtyAsync(cs, T(8, 0, 18), T(9, 0, 18), clock.GetUtcNow().UtcDateTime.AddMinutes(-5));

        clock.Advance(TimeSpan.FromMinutes(4));
        Assert.True(await h.Worker.RunOnceAsync(Ct)); // third: set aside
        return (h, clock, cs, clock.GetUtcNow().UtcDateTime);
    }

    [Fact]
    public async Task A_backfill_step_that_keeps_failing_is_set_aside_and_the_backfill_moves_on()
    {
        var (h, _, cs, setAsideAt) = await SetAsideSecondWeekAsync(db, liveRangeAhead: true);
        await using var owner = h;

        // The step is a failed dirty range now (three attempts, the error, the usual backoff), and the cursor is past it. The
        // range reaches over the step after it as well (a week further), so that its retry rebuilds the edge between them.
        var failed = Assert.Single(await DirtyAsync(cs, onlyFailed: true));
        Assert.Equal((T(7, 0, 7), T(7, 0, 21)), (failed.FromUtc, failed.ToUtc));
        Assert.Equal(3, failed.Attempts);
        Assert.Contains("this range cannot be processed", failed.LastError);
        Assert.Equal(setAsideAt + ProcessingQueue.Backoff(3), failed.NextAttemptAt);
        var state = await StateAsync(cs);
        Assert.Equal(T(7, 0, 14), state.BackfillCursor);
        Assert.Null(state.LastError); // the backfill is not stuck: the failed range says what went wrong

        // The rest of the history is processed, and so is the live range that waited for it. Week 3 starts at its own first
        // point: its rebuild is not widened back to the last stay before it (the set-aside range in the table stops it), which
        // would load week 2 and fail again.
        h.Processor.TakeCalls();
        await FinishBackfillAsync(h.Worker);

        var calls = h.Processor.Calls.ToArray();
        Assert.Equal([(T(7, 0, 14), T(7, 0, 21)), (T(8, 0, 18), T(9, 0, 18)), (T(7, 0, 21), T(0, 0, 22))], calls); // the backfill ends where "now" was when it began
        state = await StateAsync(cs);
        Assert.True(state.BackfillCursor >= state.BackfillTo);
        Assert.Null(state.LastError);
        Assert.Equal(failed.Id, Assert.Single(await DirtyAsync(cs)).Id); // only the set-aside step is left
        Assert.Equal(0, await StaysBetweenAsync(cs, T(0, 0, 8), T(7, 0, 14)));  // week 2 was not rebuilt by anything
        Assert.Equal(T(7, 0, 14), await Sql.ScalarAsync<DateTime>(cs, "select min(start_utc) from segment where start_utc >= @from",
            new { from = T(0, 0, 8) }, Ct)); // week 3 starts at its own first point
        Assert.True(await StaysBetweenAsync(cs, T(7, 0, 14), T(0, 0, 21)) >= 7 * 3);
        Assert.True(await StaysBetweenAsync(cs, T(0, 0), T(0, 0, 7)) >= 7 * 3);

        // /api/status says which range failed.
        var response = await h.Api.CreateClient().GetAsync("/api/status", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct));
        var failedRange = Assert.Single(body.RootElement.GetProperty("failedRanges").EnumerateArray());
        Assert.Equal(T(7, 0, 7), failedRange.GetProperty("from").GetDateTime());
        Assert.Equal(T(7, 0, 21), failedRange.GetProperty("to").GetDateTime());
        Assert.Equal(3, failedRange.GetProperty("attempts").GetInt32());
        Assert.Contains("this range cannot be processed", failedRange.GetProperty("lastError").GetString());
        Assert.Equal(100.0, body.RootElement.GetProperty("backfill").GetProperty("percent").GetDouble());
    }

    [Fact]
    public async Task The_set_aside_step_is_retried_behind_the_cursor_with_backoff_and_fills_the_hole_once_it_succeeds()
    {
        var (h, clock, cs, _) = await SetAsideSecondWeekAsync(db, liveRangeAhead: false);
        await using var owner = h;
        await FinishBackfillAsync(h.Worker);
        h.Processor.TakeCalls();
        var week2 = (T(7, 0, 7), T(7, 0, 14));
        var week3 = (T(7, 0, 14), T(7, 0, 21)); // the set-aside range covers the week after the failed one as well: a second piece

        // Not due before the backoff has passed...
        clock.Advance(TimeSpan.FromMinutes(7));
        Assert.False(await h.Worker.RunOnceAsync(Ct));
        Assert.Empty(h.Processor.Calls);

        // ...then it is tried again, as a dirty range behind the cursor, and fails again (on its first piece): a longer wait.
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.True(await h.Worker.RunOnceAsync(Ct));
        Assert.Equal([week2], h.Processor.TakeCalls());
        var failed = Assert.Single(await DirtyAsync(cs));
        Assert.Equal(4, failed.Attempts);
        Assert.Equal(clock.GetUtcNow().UtcDateTime + ProcessingQueue.Backoff(4), failed.NextAttemptAt);

        // When whatever was wrong is fixed, the next attempt fills the hole.
        h.Processor.FailWhen(null);
        clock.Advance(ProcessingQueue.Backoff(4));
        Assert.True(await h.Worker.RunOnceAsync(Ct));
        Assert.Equal([week2, week3], h.Processor.TakeCalls());
        Assert.Empty(await DirtyAsync(cs));
        Assert.Equal(21, await Sql.ScalarAsync<long>(cs, "select count(distinct local_start_date) from segment where kind = 'stay'", ct: Ct));
        Assert.Equal(3, await CountAsync(cs, "place"));
        Assert.False(await h.Worker.RunOnceAsync(Ct));
    }

    [Fact]
    public async Task Cancelling_during_the_backfill_pause_stops_the_pass_promptly()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var h = Start(cs, ClockAfterThreeWeeks(), new Dictionary<string, string?> { ["Processing:BackfillPause"] = "01:00:00" });
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 14), Ct);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(Ct);

        var pass = h.Worker.RunOnceAsync(cts.Token);
        // The cursor is saved before the pause, so once it has moved the pass is waiting out the hour.
        await WaitForAsync(async () => (await StateAsync(cs)).BackfillCursor > T(7, 0), "the first backfill step");
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pass.WaitAsync(TimeSpan.FromSeconds(10), Ct));
        Assert.Equal(T(7, 0, 7), (await StateAsync(cs)).BackfillCursor);
    }

    [Fact]
    public async Task The_loop_survives_errors_and_carries_on_when_they_clear()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var h = Start(cs, TimeProvider.System, new Dictionary<string, string?> { ["Processing:PollInterval"] = "00:00:00.050" });
        await Sql.ExecAsync(cs, "alter table processing_state rename to processing_state_away", ct: Ct);

        await h.Worker.StartAsync(Ct);
        try
        {
            await Task.Delay(500, Ct); // several passes, each failing
            Assert.False(h.Worker.ExecuteTask!.IsCompleted);

            await Sql.ExecAsync(cs, "alter table processing_state_away rename to processing_state", ct: Ct);
            await WaitForAsync(async () => (await Sql.ScalarAsync<DateTime?>(cs, "select last_run_at from processing_state", ct: Ct)) is not null,
                "the worker to run again");
        }
        finally
        {
            await h.Worker.StopAsync(Ct);
        }

        Assert.True(h.Worker.ExecuteTask!.IsCompletedSuccessfully);
    }

    [Theory]
    [InlineData("Processing:PollInterval", "100.00:00:00")] // more than Task.Delay accepts: it would throw out of the loop
    [InlineData("Processing:Debounce", "10675199.02:48:05")] // "now - debounce" would not be a date
    public async Task Out_of_range_durations_do_not_stop_the_loop(string key, string value)
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var h = Start(cs, TimeProvider.System, new Dictionary<string, string?> { [key] = value });
        await PointSeeder.InsertAsync(cs, new TrackBuilder(DateTime.UtcNow.Date.AddDays(-3).AddHours(7), Spots.Home).Stay(TimeSpan.FromHours(1), Every2min).Build(), Ct);
        await Sql.ExecAsync(cs, "insert into dirty_range (from_utc, to_utc) values (now() - interval '1 day', now())", ct: Ct);

        await h.Worker.StartAsync(Ct);
        try
        {
            await WaitForAsync(async () => (await Sql.ScalarAsync<DateTime?>(cs, "select last_run_at from processing_state", ct: Ct)) is not null,
                "the worker to run");
            await Task.Delay(300, Ct); // the pass that follows is the one that used to fail
            Assert.False(h.Worker.ExecuteTask!.IsCompleted, "the loop has stopped");
        }
        finally
        {
            await h.Worker.StopAsync(Ct);
        }

        Assert.True(h.Worker.ExecuteTask!.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task The_loop_drains_dirty_ranges_and_backfills_in_the_background()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var h = Start(cs, TimeProvider.System, new Dictionary<string, string?>
        {
            ["Processing:PollInterval"] = "00:00:00.050",
            ["Processing:BackfillPause"] = "00:00:00",
            ["Processing:Debounce"] = "00:00:00",
        });
        var recent = DateTime.UtcNow.Date.AddDays(-3);
        await PointSeeder.InsertAsync(cs, new TrackBuilder(recent.AddHours(7), Spots.Home).Stay(TimeSpan.FromHours(1), Every2min).Build(), Ct);

        await h.Worker.StartAsync(Ct);
        try
        {
            await WaitForAsync(async () =>
            {
                var state = await StateAsync(cs);
                return state.BackfillCursor >= state.BackfillTo && await CountAsync(cs, "segment") > 0;
            }, "the backfill");
            await AddDirtyAsync(cs, recent.AddHours(7), recent.AddHours(8), DateTime.UtcNow.AddMinutes(-1));
            await WaitForAsync(async () => await CountAsync(cs, "dirty_range") == 0, "the dirty range to be processed");
        }
        finally
        {
            await h.Worker.StopAsync(Ct);
        }
    }

    // ---- homes and trips ---------------------------------------------------------------------------------------------

    [Fact]
    public async Task Worker_refreshes_trips_once_per_pass_after_rebuilding()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock, processor: _ => new WindowProcessor());
        await FinishBackfillAsync(h.Worker); // empty database: nothing to backfill
        var old = clock.GetUtcNow().UtcDateTime.AddMinutes(-5);
        await AddDirtyAsync(cs, T(10, 0), T(10, 30), old);
        await AddDirtyAsync(cs, T(15, 0), T(15, 10), old); // 4.5 hours later: a range of its own
        h.Refresher.TakeCalls();

        Assert.True(await h.Worker.RunOnceAsync(Ct));

        // Two ranges were rebuilt, and one refresh covers both: from where the first window starts to where the last one
        // ends (the windows the processor reported, not the ranges it was asked for).
        Assert.Equal([(T(10, 0), T(10, 30)), (T(15, 0), T(15, 10))], h.Processor.TakeCalls());
        Assert.Equal([(T(8, 0), T(18, 10))], h.Refresher.TakeCalls());
        Assert.Equal((null, null), await PendingAsync(cs)); // and it is done with

        Assert.False(await h.Worker.RunOnceAsync(Ct));
        Assert.Empty(h.Refresher.Calls); // nothing was rebuilt since: nothing to refresh
    }

    [Fact]
    public async Task Worker_refreshes_the_window_of_a_backfill_step_in_the_same_pass()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 14), Ct);

        Assert.True(await h.Worker.RunOnceAsync(Ct)); // week 1

        // The window of the rebuilt step (the real processor's: from the step's start), and the nights of it are stored: each
        // is covered by the stay that carries on through it, from the first day to the seventh.
        var call = Assert.Single(h.Refresher.Calls);
        Assert.Equal((T(7, 0), T(7, 0, 7)), call);
        Assert.Equal((null, null), await PendingAsync(cs));
        Assert.Equal(
            Enumerable.Range(0, 7).Select(day => DateOnly.FromDateTime(T(0, 0, day))),
            (await Sql.QueryAsync<DateTime>(cs, "select date::timestamp from night where source = 'stay' order by date", ct: Ct)).Select(DateOnly.FromDateTime));
    }

    [Fact]
    public async Task Worker_keeps_a_failed_refresh_pending_and_does_not_fail_the_range()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock, processor: _ => new WindowProcessor());
        await FinishBackfillAsync(h.Worker);
        await AddDirtyAsync(cs, T(10, 0), T(10, 30), clock.GetUtcNow().UtcDateTime.AddMinutes(-5));
        var window = (T(8, 0), T(13, 30));
        h.Refresher.FailWith(new InvalidOperationException("refresh exploded"));

        Assert.True(await h.Worker.RunOnceAsync(Ct)); // the range was rebuilt

        // The range is done, not failed: it is not retried, and the processor is not asked for it again. What is retried is the
        // refresh, from the window in the database.
        Assert.Empty(await DirtyAsync(cs));
        Assert.Equal(window, await PendingAsync(cs));
        Assert.Contains("refresh exploded", (await StateAsync(cs)).LastError);
        Assert.Equal([window], h.Refresher.TakeCalls());
        h.Processor.TakeCalls();

        // It waits before trying again, as a failed backfill step does (2 minutes the first time): the passes in between are not
        // work, so the loop waits its poll interval, and do not call the refresher. They still save the error, which a pass
        // that saved only what it found would wipe.
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.False(await h.Worker.RunOnceAsync(Ct));
        Assert.Empty(h.Refresher.Calls);
        Assert.Equal(window, await PendingAsync(cs));
        Assert.Contains("refresh exploded", (await StateAsync(cs)).LastError);

        // Then it is tried again from the same window, fails again, and waits twice as long.
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.False(await h.Worker.RunOnceAsync(Ct));
        Assert.Equal([window], h.Refresher.TakeCalls());
        clock.Advance(TimeSpan.FromMinutes(3));
        Assert.False(await h.Worker.RunOnceAsync(Ct));
        Assert.Empty(h.Refresher.Calls);
        Assert.Empty(h.Processor.Calls);
        Assert.Contains("refresh exploded", (await StateAsync(cs)).LastError);

        // Once it works the window is refreshed and cleared, and the error with it.
        h.Refresher.FailWith(null);
        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.True(await h.Worker.RunOnceAsync(Ct));
        Assert.Equal([window], h.Refresher.TakeCalls());
        Assert.Equal((null, null), await PendingAsync(cs));
        Assert.Null((await StateAsync(cs)).LastError);
        Assert.False(await h.Worker.RunOnceAsync(Ct));
        Assert.Empty(h.Refresher.Calls);

        // A success starts the wait over: the next failure is tried again after 2 minutes, not after the 8 that came next.
        await AddDirtyAsync(cs, T(10, 0), T(10, 30), clock.GetUtcNow().UtcDateTime.AddMinutes(-5));
        h.Refresher.FailWith(new InvalidOperationException("refresh exploded again"));
        Assert.True(await h.Worker.RunOnceAsync(Ct));
        h.Refresher.TakeCalls();
        clock.Advance(TimeSpan.FromMinutes(2));
        Assert.False(await h.Worker.RunOnceAsync(Ct));
        Assert.Single(h.Refresher.Calls);
    }

    [Fact]
    public async Task A_restart_forgets_the_wait_of_a_failing_refresh()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 14), Ct);
        h.Refresher.FailWith(new InvalidOperationException("refresh exploded"));
        Assert.True(await h.Worker.RunOnceAsync(Ct)); // week 1; its refresh fails and now waits 2 minutes
        Assert.Single(h.Refresher.TakeCalls());

        // The algorithm version changes under the running worker (as it would for a new one after a restart): the backfill starts
        // over, which clears what was pending, so a failure of the old window has nothing to wait for.
        await Sql.ExecAsync(cs, "update processing_state set algorithm_version = 'old'", ct: Ct);
        Assert.True(await h.Worker.RunOnceAsync(Ct));

        Assert.Single(h.Refresher.TakeCalls()); // the first week again, refreshed at once, not after the 2 minutes
    }

    [Fact]
    public async Task A_refresh_error_is_saved_with_the_error_of_a_backfill_step_until_each_clears()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using var h = Start(cs, clock);
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 14), Ct);
        h.Refresher.FailWith(new InvalidOperationException("refresh exploded"));

        Assert.True(await h.Worker.RunOnceAsync(Ct)); // week 1 is rebuilt; its refresh fails
        var state = await StateAsync(cs);
        Assert.Equal(T(7, 0, 7), state.BackfillCursor); // the refresh did not hold the backfill up
        Assert.Contains("refresh exploded", state.LastError);
        Assert.DoesNotContain("chunk exploded", state.LastError);

        h.Processor.FailNext(new InvalidOperationException("chunk exploded"));
        Assert.True(await h.Worker.RunOnceAsync(Ct)); // week 2 fails; week 1's refresh is still waiting, and its error is saved again
        state = await StateAsync(cs);
        Assert.Equal(T(7, 0, 7), state.BackfillCursor);
        Assert.Contains("chunk exploded", state.LastError);
        Assert.Contains("refresh exploded", state.LastError);

        h.Refresher.FailWith(null);
        clock.Advance(TimeSpan.FromMinutes(2)); // the backoff of the failed step
        await FinishBackfillAsync(h.Worker);

        state = await StateAsync(cs);
        Assert.True(state.BackfillCursor >= state.BackfillTo);
        Assert.Null(state.LastError);
        Assert.Equal((null, null), await PendingAsync(cs));
        // The night before the first day to the night of the last day but one: the last day's night has not happened.
        Assert.Equal(14, await CountAsync(cs, "night"));
    }

    [Fact]
    public async Task A_stop_during_the_refresh_keeps_the_step_the_backfill_has_just_done()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var h = Start(cs, ClockAfterThreeWeeks());
        await PointSeeder.InsertAsync(cs, CommuteDays(0, 14), Ct);
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        h.Refresher.OnCall = token =>
        {
            stopping.Cancel(); // the host stops while the refresh runs
            token.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => h.Worker.RunOnceAsync(stopping.Token));

        // The cursor has moved past the week that was rebuilt, and its attempt is cleared: had they been lost, the next starts would
        // find the week's attempts counting up to a chunk the process cannot get through, and set a good one aside.
        var state = await StateAsync(cs);
        Assert.Equal(T(7, 0, 7), state.BackfillCursor);
        Assert.Equal(0, await Sql.ScalarAsync<int>(cs, "select backfill_chunk_attempts from processing_state", ct: Ct));
        Assert.NotNull((await PendingAsync(cs)).From); // and the window that was being refreshed is still waiting
        Assert.Empty(await DirtyAsync(cs));

        // The next process refreshes it, and goes on from the second week.
        h.Refresher.OnCall = null;
        h.Processor.TakeCalls();
        h.Refresher.TakeCalls();
        Assert.True(await h.Worker.RunOnceAsync(Ct));
        Assert.Equal([(T(7, 0, 7), T(7, 0, 14))], h.Processor.TakeCalls());
        Assert.Equal((null, null), await PendingAsync(cs));
    }

    [Fact]
    public async Task Worker_refreshes_a_window_that_a_stopped_process_left_pending()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var h = Start(cs, ClockAfterThreeWeeks());
        await FinishBackfillAsync(h.Worker);
        // What a process that was killed after rebuilding and before refreshing leaves behind.
        await Sql.ExecAsync(cs, "update night_refresh set from_utc = @from, to_utc = @to", new { from = T(8, 0), to = T(9, 0) }, Ct);

        Assert.True(await h.Worker.RunOnceAsync(Ct));

        Assert.Equal([(T(8, 0), T(9, 0))], h.Refresher.TakeCalls());
        Assert.Equal((null, null), await PendingAsync(cs));
    }

    [Fact]
    public async Task Worker_restart_clears_nights_homes_and_trips()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = ClockAfterThreeWeeks();
        await using (var first = Start(cs, clock))
        {
            await PointSeeder.InsertAsync(cs, CommuteDays(0, 3), Ct);
            await FinishBackfillAsync(first.Worker);
            Assert.True(await CountAsync(cs, "night") > 0); // what the backfill derived
        }
        var place = await Sql.ScalarAsync<long>(cs, "select min(id) from place", ct: Ct);
        await Sql.ExecAsync(cs,
            """
            insert into home_period (place_id, from_date, to_date, source) values
              (@place, '2026-09-01', null, 'detected'), (@place, '2026-01-01', '2026-08-31', 'user');
            insert into trip (id, last_night, nights, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date)
            values ('2026-10-05', '2026-10-06', 2, '2026-10-05T10:00:00Z', null, 'Europe/Oslo', 'Europe/Oslo', '2026-10-05', '2026-10-07');
            update night_refresh set from_utc = '2026-10-01T00:00:00Z', to_utc = '2026-10-02T00:00:00Z';
            update processing_state set paused = true; -- so that the reset can be seen before it moves on
            """, new { place }, Ct);

        await using var second = Start(cs, clock, new Dictionary<string, string?> { ["Detection:StayRadiusMeters"] = "150" });
        Assert.True(await second.Worker.RunOnceAsync(Ct));

        Assert.Equal(0, await CountAsync(cs, "night"));
        Assert.Equal(0, await CountAsync(cs, "trip"));
        Assert.Equal(["user"], await Sql.QueryAsync<string>(cs, "select source from home_period", ct: Ct)); // the owner's own stays
        Assert.Equal((null, null), await PendingAsync(cs));
        Assert.Empty(second.Refresher.Calls); // nothing was waiting after the reset
    }
}
