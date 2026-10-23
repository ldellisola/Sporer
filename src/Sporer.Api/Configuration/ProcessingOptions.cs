namespace Sporer.Api.Configuration;

/// <summary>
/// How the background timeline processing runs. Bound from configuration section <c>Processing</c>
/// (environment variables <c>Processing__Enabled</c>, <c>Processing__Debounce</c>, ...).
/// </summary>
public sealed record ProcessingOptions
{
    /// <summary>Whether the worker runs in the background. Read once at start-up: it decides if the hosted service is registered.</summary>
    public bool Enabled { get; init; } = true;

    /// <summary>How long the worker sleeps when a pass found nothing to do.</summary>
    public TimeSpan PollInterval { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Recorded points are processed once the oldest of a group of nearby ones has been waiting this long, and the newer ones
    /// go with it: a stream of batches is processed together, at most once per debounce.
    /// </summary>
    public TimeSpan Debounce { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>The length of one backfill step, and the longest range one rebuild is asked for: a dirty range longer than this is processed in pieces of it, oldest first.</summary>
    public int BackfillChunkDays { get; init; } = 7;

    /// <summary>The wait after each backfill step, so a backfill leaves the database free for ingest and reads.</summary>
    public TimeSpan BackfillPause { get; init; } = TimeSpan.FromMilliseconds(200);
}
