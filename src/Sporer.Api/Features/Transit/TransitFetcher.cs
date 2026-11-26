using Sporer.Api.Configuration;
using Sporer.Timeline;

namespace Sporer.Api.Features.Transit;

/// <summary>
/// Fetches the railway and bus-route tiles that processing asked for from the Overpass API, one at a time, those of the most recent travels
/// first (transit spec section 3). It follows the service's rules: one request at a time, at least <see cref="TransitOptions.MinInterval"/>
/// apart, with a <c>User-Agent</c> that names the operator. A tile that fails waits 2, 4, 8, ... minutes before it is tried again, and after
/// <see cref="SetAsideAfterAttempts"/> failures is set aside and tried once a day (<see cref="Backoff"/>); every failure also pauses all
/// requests, for 1, 2, 4, ... minutes up to an hour (<see cref="Pause"/>), so that a server that is refusing us or down is not asked about
/// every other tile in turn. A tile that arrives is stored, and the stretch of the moves that waited for it is to be rebuilt, together with
/// those of the tiles that arrive soon after (see <see cref="TransitTileStore.SaveFetchedAsync"/>). It never holds up or breaks processing or
/// ingest: it only writes <c>transit_tile</c>, and the stretch to rebuild in <c>processing_state</c>, and no exception leaves its loop.
/// </summary>
public sealed class TransitFetcher(
    TransitTileStore tiles,
    OverpassClient client,
    TransitOptions options,
    TimeProvider time,
    ILogger<TransitFetcher> logger) : BackgroundService
{
    /// <summary>A tile that has failed this many times is set aside: it is tried again once a day.</summary>
    public const int SetAsideAfterAttempts = 5;

    private static readonly TimeSpan SetAsideRetry = TimeSpan.FromHours(24);
    private static readonly TimeSpan FirstPause = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan MaxPause = TimeSpan.FromHours(1);

    /// <summary>The loop never sleeps less than this, nor more than <see cref="MaxWait"/>.</summary>
    private static readonly TimeSpan MinWait = TimeSpan.FromMilliseconds(50);
    private static readonly TimeSpan MaxWait = TimeSpan.FromSeconds(5);

    // In memory: after a restart the first request needs no wait. Only touched by the pass that is running.
    private DateTimeOffset? _lastRequestAt;
    private DateTimeOffset? _pausedUntil;
    private int _consecutiveFailures;

    /// <summary>
    /// How long a tile waits before it is tried again after its <paramref name="attempts"/>-th failure: 2, 4, 8 and 16 minutes, then a day
    /// (it is set aside from the <see cref="SetAsideAfterAttempts"/>-th on).
    /// </summary>
    public static TimeSpan Backoff(int attempts)
    {
        if (attempts >= SetAsideAfterAttempts)
            return SetAsideRetry;
        var wait = TimeSpan.FromMinutes(Math.Pow(2, Math.Clamp(attempts, 0, 20))); // capped before the power so that it cannot overflow
        return wait < SetAsideRetry ? wait : SetAsideRetry;
    }

    /// <summary>
    /// How long all requests pause after the <paramref name="consecutiveFailures"/>-th failure in a row (of any tile): 1, 2, 4, ... minutes,
    /// at most an hour. A success resets the count.
    /// </summary>
    public static TimeSpan Pause(int consecutiveFailures)
    {
        var wait = FirstPause * Math.Pow(2, Math.Clamp(consecutiveFailures - 1, 0, 20)); // capped before the power so that it cannot overflow
        return wait < MaxPause ? wait : MaxPause;
    }

    /// <summary>
    /// One pass: fetches the tile that is due next, and returns whether it did. Returns <c>false</c> without any request when fetching is
    /// disabled (<see cref="TransitOptions.FetchingEnabled"/>), when requests are paused after a failure, when less than
    /// <see cref="TransitOptions.MinInterval"/> has passed since the last request, and when no tile is due (all measured with the injected
    /// <see cref="TimeProvider"/>). Whatever goes wrong with the request (Overpass refusing or unreachable, an answer that cannot be used, an
    /// unexpected exception) is recorded on the tile and is not thrown; a database failure is thrown, and so is an
    /// <see cref="OperationCanceledException"/> when <paramref name="ct"/> is cancelled.
    /// </summary>
    public async Task<bool> RunOnceAsync(CancellationToken ct) => await PassAsync(ct) is null;

    /// <summary>Runs <see cref="RunOnceAsync"/> until stopped, sleeping for a moment whenever it had nothing to do.</summary>
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            TimeSpan? wait;
            try
            {
                wait = await PassAsync(stoppingToken);
            }
            catch (Exception) when (stoppingToken.IsCancellationRequested)
            {
                return; // stopping: whatever the pass was interrupted by, it is not an error
            }
            catch (Exception ex)
            {
                // The database restarting, a bug: the tile stays as it was and the next pass tries again.
                wait = Clamp(options.MinInterval);
                logger.LogError(ex, "A pass fetching railway and bus lines failed; trying again in {Wait}", wait);
            }

            if (wait is not { } sleep)
                continue;

            try
            {
                await Task.Delay(sleep, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>Does one pass. <c>null</c>: it fetched a tile, so another pass may follow. Otherwise how long to wait first.</summary>
    private async Task<TimeSpan?> PassAsync(CancellationToken ct)
    {
        if (!options.FetchingEnabled)
            return Clamp(options.MinInterval);

        var now = time.GetUtcNow();
        if (_pausedUntil is { } until && now < until)
            return Clamp(until - now);
        if (_lastRequestAt is { } last && now - last < options.MinInterval)
            return Clamp(options.MinInterval - (now - last));

        if (await tiles.FindDueAsync(now.UtcDateTime, ct) is not { } due)
            return Clamp(options.MinInterval);

        _lastRequestAt = time.GetUtcNow(); // a request that fails counts as well
        IReadOnlyList<IReadOnlyList<GeoPoint>> lines;
        try
        {
            lines = await client.FetchAsync(due.Tile, ct);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            // Overpass being unavailable, or anything unexpected (a bug, a URL that cannot be requested): in every case the tile must not be
            // due again at once, or the same request would repeat as fast as the interval allows.
            var attempts = due.Attempts + 1;
            var failedAt = time.GetUtcNow();
            var setAside = attempts >= SetAsideAfterAttempts;
            var retryAt = failedAt + Backoff(attempts);
            await tiles.SaveFailureAsync(due.Tile, attempts, setAside, retryAt.UtcDateTime, Describe(ex), ct);

            _consecutiveFailures++;
            _pausedUntil = failedAt + Pause(_consecutiveFailures);
            if (ex is OverpassUnavailableException)
                logger.LogWarning(ex, "Overpass could not give transit tile {Tile} (attempt {Attempts}{SetAside}); this tile waits until {RetryAt:o}, all requests until {PausedUntil:o}", due.Tile, attempts, setAside ? ", set aside" : "", retryAt, _pausedUntil);
            else
                logger.LogError(ex, "Fetching transit tile {Tile} failed unexpectedly (attempt {Attempts}{SetAside}); this tile waits until {RetryAt:o}, all requests until {PausedUntil:o}", due.Tile, attempts, setAside ? ", set aside" : "", retryAt, _pausedUntil);
            return null;
        }

        (_consecutiveFailures, _pausedUntil) = (0, null);
        var rebuilt = await tiles.SaveFetchedAsync(due.Tile, lines, time.GetUtcNow().UtcDateTime, ct);
        if (rebuilt is { } span)
            logger.LogInformation("Fetched transit tile {Tile} ({Lines} lines); {FromUtc:o} to {ToUtc:o} is to be rebuilt", due.Tile, lines.Count, span.FromUtc, span.ToUtc);
        else
            logger.LogInformation("Fetched transit tile {Tile} ({Lines} lines)", due.Tile, lines.Count);
        return null;
    }

    private static string Describe(Exception error) => $"{error.GetType().Name}: {error.Message}";

    private static TimeSpan Clamp(TimeSpan wait) => wait < MinWait ? MinWait : wait > MaxWait ? MaxWait : wait;
}
