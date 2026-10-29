using System.Diagnostics;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// Works the homes and trips out once, in the background, after the app has started, and throws the result away: it is the first run of the code that
/// the first refresh of the worker and the first edit of the owner run (the queries, the mapping of their rows, home and trip detection), so that
/// they are not the ones that wait for it to be compiled (see <see cref="TripRefresher.WarmUpAsync"/>).
/// </summary>
/// <remarks>
/// It is only a warm-up, and so it is kept from doing any harm. It runs after the migrations (the hosted services start when the app does, which is
/// after Program.cs has migrated), and it yields first, so that the start of the app and the first requests never wait for it, and nor does ingest,
/// which it does not touch. It writes nothing and takes no lock (<see cref="TripRefresher.WarmUpAsync"/> reads in a read-only transaction), so
/// it cannot hold up a refresh or an edit. A failure is logged as a warning and ignored: a background service that throws stops the host, and
/// the app does not need this to work. It runs in the background only when processing does, as the worker does (and is there to be driven by
/// hand when it does not, for the tests).
/// </remarks>
public sealed class TripWarmUp(TripRefresher refresher, ILogger<TripWarmUp> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // The start of the host runs this until its first await: that is the whole of what the start waits for.
        await Task.Yield();
        await RunAsync(stoppingToken);
    }

    /// <summary>Warms up once. Returns whether it did; it does not throw, whatever goes wrong, and says nothing of a stop.</summary>
    internal async Task<bool> RunAsync(CancellationToken ct)
    {
        var began = Stopwatch.GetTimestamp();
        try
        {
            var (nights, homes, trips) = await refresher.WarmUpAsync(ct);
            logger.LogInformation(
                "Warmed up the homes and trips: {Nights} nights, {Homes} home periods, {Trips} trips in {Elapsed:0} ms",
                nights, homes, trips, Stopwatch.GetElapsedTime(began).TotalMilliseconds);
            return true;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return false; // the app is stopping
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Warming up the homes and trips failed; nothing was written, and the app goes on without it");
            return false;
        }
    }
}
