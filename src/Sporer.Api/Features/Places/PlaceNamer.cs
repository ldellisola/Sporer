using Dapper;
using Npgsql;
using Sporer.Api.Configuration;
using Sporer.Timeline;

namespace Sporer.Api.Features.Places;

/// <summary>
/// Names the places that processing creates, from Nominatim (the public OpenStreetMap service, in English). It follows
/// the service's usage policy (a request at most every <see cref="NominatimOptions.MinInterval"/>, a descriptive
/// <c>User-Agent</c>, answers cached in <c>geocode_cache</c>) and can neither hold up nor break processing or ingest:
/// it only reads <c>place</c> and <c>segment</c>, writes the name fields and geocoding state of <c>place</c> and
/// <c>geocode_cache</c>, and a failing or misbehaving Nominatim only leaves a place unnamed, to be tried again later
/// with a growing delay. No exception leaves its loop.
/// </summary>
public sealed class PlaceNamer(
    NpgsqlDataSource dataSource,
    NominatimClient client,
    NominatimOptions options,
    TimeProvider time,
    ILogger<PlaceNamer> logger) : BackgroundService
{
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromHours(24);

    /// <summary>The loop never sleeps less than this, nor more than <see cref="MaxWait"/>, however <see cref="NominatimOptions.MinInterval"/> is set.</summary>
    private static readonly TimeSpan MinWait = TimeSpan.FromMilliseconds(50);
    private static readonly TimeSpan MaxWait = TimeSpan.FromSeconds(5);

    // In memory: after a restart the first request needs no wait. Only touched by the pass that is running.
    private DateTimeOffset? _lastRequestAt;

    /// <summary>How long to wait before asking again after a place's <paramref name="attempts"/>-th failure: 2, 4, 8, ... minutes, at most 24 hours.</summary>
    public static TimeSpan Backoff(int attempts)
    {
        // Capped before the power so that a huge count cannot overflow.
        var wait = TimeSpan.FromMinutes(Math.Pow(2, Math.Clamp(attempts, 0, 20)));
        return wait < MaxBackoff ? wait : MaxBackoff;
    }

    /// <summary>
    /// One pass: names the first place that is due, from the cache if it is there, else from one Nominatim request,
    /// and returns whether it did anything. Returns <c>false</c> without any request when naming is disabled
    /// (<see cref="NominatimOptions.NamingEnabled"/>), when no place is due, and when a request is needed but less than
    /// <see cref="NominatimOptions.MinInterval"/> has passed since the last one (measured with the injected
    /// <see cref="TimeProvider"/>; a cache hit does not count). A Nominatim failure is recorded on the place and is not
    /// thrown; a database failure is, and so is an <see cref="OperationCanceledException"/> when <paramref name="ct"/>
    /// is cancelled.
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
                // The database restarting, a bug: the place stays as it was and the next pass tries again.
                wait = Clamp(options.MinInterval);
                logger.LogError(ex, "A place naming pass failed; trying again in {Wait}", wait);
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

    /// <summary>Does one pass. <c>null</c>: it did something, so another pass may follow at once. Otherwise how long to wait first.</summary>
    private async Task<TimeSpan?> PassAsync(CancellationToken ct)
    {
        if (!options.NamingEnabled)
            return Clamp(options.MinInterval);

        var place = await FindDueAsync(Now(), ct);
        if (place is null)
            return Clamp(options.MinInterval);

        if (await FindCachedAsync(place, ct) is { } cached)
        {
            await SaveNameAsync(place.Id, cached, ct);
            logger.LogInformation("Named place {PlaceId} from the cache", place.Id);
            return null;
        }

        var now = Now();
        if (_lastRequestAt is { } last && now - last < options.MinInterval)
            return Clamp(options.MinInterval - (now - last));

        _lastRequestAt = now; // a request that fails counts as well
        NominatimResult? result;
        try
        {
            result = await client.ReverseAsync(new GeoPoint(place.Latitude, place.Longitude), ct);
        }
        catch (NominatimUnavailableException ex)
        {
            var attempts = place.Attempts + 1;
            var retryAt = Now() + Backoff(attempts);
            await SaveFailureAsync(place.Id, attempts, retryAt, ct);
            logger.LogWarning(ex, "Nominatim could not name place {PlaceId} (attempt {Attempts}); trying again after {RetryAt:o}", place.Id, attempts, retryAt);
            return null;
        }

        await SaveNameAsync(place.Id, result, ct);
        if (result is null)
        {
            logger.LogInformation("Nominatim knows nothing about place {PlaceId}", place.Id);
            return null;
        }

        // The cache only saves later requests, so failing to fill it must not undo or repeat this one.
        try
        {
            await SaveCacheAsync(place, result.RawJson, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Could not cache the Nominatim answer for place {PlaceId}", place.Id);
        }

        logger.LogInformation("Named place {PlaceId} from Nominatim", place.Id);
        return null;
    }

    /// <summary>
    /// The oldest place that is waiting for a name and due. Only places in use: not merged into another and shown on the
    /// timeline by at least one segment. Orphans (left behind by a reprocessing that moved a stay) would cost public
    /// requests for nothing.
    /// </summary>
    private async Task<PlaceRow?> FindDueAsync(DateTime nowUtc, CancellationToken ct)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        return await connection.QueryFirstOrDefaultAsync<PlaceRow>(new CommandDefinition(
            """
            select p.id as Id, p.latitude as Latitude, p.longitude as Longitude, p.geocode_attempts as Attempts
            from place p
            where p.geocode_state in ('pending', 'failed')
              and p.merged_into_id is null
              and (p.geocode_next_attempt_at is null or p.geocode_next_attempt_at <= @Now)
              and exists (select 1 from segment s where s.place_id = p.id)
            order by p.id
            limit 1
            """,
            new { Now = nowUtc }, cancellationToken: ct));
    }

    /// <summary>The cached answer for the 4-decimal key of <paramref name="place"/> (about 11 m), if there is a usable one.</summary>
    private async Task<NominatimResult?> FindCachedAsync(PlaceRow place, CancellationToken ct)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var json = await connection.ExecuteScalarAsync<string?>(new CommandDefinition(
            "select response::text from geocode_cache where lat_key = round(@Latitude::numeric, 4) and lon_key = round(@Longitude::numeric, 4)",
            new { place.Latitude, place.Longitude }, cancellationToken: ct));
        if (json is null)
            return null;

        try
        {
            return NominatimClient.Parse(json);
        }
        catch (NominatimUnavailableException ex)
        {
            logger.LogWarning(ex, "Ignoring an unusable geocode_cache row for place {PlaceId}", place.Id);
            return null; // asked again, and the row is replaced
        }
    }

    private async Task SaveCacheAsync(PlaceRow place, string rawJson, CancellationToken ct)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            """
            insert into geocode_cache (lat_key, lon_key, response, fetched_at)
            values (round(@Latitude::numeric, 4), round(@Longitude::numeric, 4), @Response::jsonb, @FetchedAt)
            on conflict (lat_key, lon_key) do update set response = excluded.response, fetched_at = excluded.fetched_at
            """,
            new { place.Latitude, place.Longitude, Response = rawJson, FetchedAt = Now() }, cancellationToken: ct));
    }

    /// <summary>Stores the names and marks the place done. With no <paramref name="result"/> (nothing known there) it is done without names.</summary>
    private async Task SaveNameAsync(long placeId, NominatimResult? result, CancellationToken ct)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            """
            update place
            set osm_name = @Name, address = @Address, city = @City, country = @Country,
                geocode_state = 'done', geocode_next_attempt_at = null
            where id = @Id
            """,
            new { Id = placeId, result?.Name, result?.Address, result?.City, result?.Country }, cancellationToken: ct));
    }

    private async Task SaveFailureAsync(long placeId, int attempts, DateTime retryAtUtc, CancellationToken ct)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "update place set geocode_state = 'failed', geocode_attempts = @Attempts, geocode_next_attempt_at = @RetryAt where id = @Id",
            new { Id = placeId, Attempts = attempts, RetryAt = retryAtUtc }, cancellationToken: ct));
    }

    private DateTime Now() => time.GetUtcNow().UtcDateTime;

    private static TimeSpan Clamp(TimeSpan wait) => wait < MinWait ? MinWait : wait > MaxWait ? MaxWait : wait;

    // A class with setters rather than a record: Dapper matches a record's constructor by exact column types.
    private sealed class PlaceRow
    {
        public long Id { get; set; }
        public double Latitude { get; set; }
        public double Longitude { get; set; }
        public int Attempts { get; set; }
    }
}
