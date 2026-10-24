namespace Sporer.Api.Configuration;

/// <summary>
/// How the background timeline processing runs. Bound from configuration section <c>Processing</c>
/// (environment variables <c>Processing__Enabled</c>, <c>Processing__Debounce</c>, ...). A duration outside its bounds is
/// moved to the nearest bound when it is set, so a mistyped value cannot make the worker's wait throw (a negative one, or
/// one longer than <see cref="Task.Delay(TimeSpan)"/> accepts, which would stop the host) or spin.
/// </summary>
public sealed record ProcessingOptions
{
    public static readonly TimeSpan MinPollInterval = TimeSpan.FromMilliseconds(100);
    public static readonly TimeSpan MaxPollInterval = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan MaxBackfillPause = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan MaxDebounce = TimeSpan.FromHours(1);

    private readonly TimeSpan _pollInterval = TimeSpan.FromSeconds(5);
    private readonly TimeSpan _debounce = TimeSpan.FromSeconds(60);
    private readonly TimeSpan _backfillPause = TimeSpan.FromMilliseconds(200);

    /// <summary>Whether the worker runs in the background. Read once at start-up: it decides if the hosted service is registered.</summary>
    public bool Enabled { get; init; } = true;

    /// <summary>How long the worker sleeps when a pass found nothing to do. Between 100 ms and 10 minutes.</summary>
    public TimeSpan PollInterval
    {
        get => _pollInterval;
        init => _pollInterval = Clamp(value, MinPollInterval, MaxPollInterval);
    }

    /// <summary>
    /// Recorded points are processed once the oldest of a group of nearby ones has been waiting this long, and the newer ones
    /// go with it: a stream of batches is processed together, at most once per debounce. Between zero and one hour.
    /// </summary>
    public TimeSpan Debounce
    {
        get => _debounce;
        init => _debounce = Clamp(value, TimeSpan.Zero, MaxDebounce);
    }

    /// <summary>The length of one backfill step, and the longest range one rebuild is asked for: a dirty range longer than this is processed in pieces of it, oldest first.</summary>
    public int BackfillChunkDays { get; init; } = 7;

    /// <summary>The wait after each backfill step, so a backfill leaves the database free for ingest and reads. Between zero and 10 minutes.</summary>
    public TimeSpan BackfillPause
    {
        get => _backfillPause;
        init => _backfillPause = Clamp(value, TimeSpan.Zero, MaxBackfillPause);
    }

    private static TimeSpan Clamp(TimeSpan value, TimeSpan min, TimeSpan max) => value < min ? min : value > max ? max : value;
}
