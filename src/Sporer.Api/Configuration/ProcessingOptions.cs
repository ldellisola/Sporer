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

    /// <summary>A dirty range is processed only once it has been recorded this long, so a stream of batches is processed together.</summary>
    public TimeSpan Debounce { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>The length of one backfill step.</summary>
    public int BackfillChunkDays { get; init; } = 7;

    /// <summary>The wait after each backfill step, so a backfill leaves the database free for ingest and reads.</summary>
    public TimeSpan BackfillPause { get; init; } = TimeSpan.FromMilliseconds(200);
}
