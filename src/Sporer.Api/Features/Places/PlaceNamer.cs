using Dapper;
using Npgsql;
using Sporer.Api.Configuration;
using Sporer.Api.Features.Timeline;
using Sporer.Timeline;

namespace Sporer.Api.Features.Places;

/// <summary>
/// Names the places that processing creates, from Nominatim (the public OpenStreetMap service, in English). It follows
/// the service's usage policy (a request at most every <see cref="NominatimOptions.MinInterval"/>, a descriptive
/// <c>User-Agent</c>, answers cached in <c>geocode_cache</c>) and can neither hold up nor break processing or ingest:
/// it only reads <c>place</c> and <c>segment</c>, writes the name fields and geocoding state of <c>place</c> and
/// <c>geocode_cache</c>, and a failing or misbehaving Nominatim only leaves a place unnamed, to be tried again later
/// with a growing delay (per place), while all requests pause for a cool-down (<see cref="CoolDown"/>) so that a service
/// that is down or rate limiting us is not asked for every other place in turn. No exception leaves its loop.
/// </summary>
public sealed class PlaceNamer(
    NpgsqlDataSource dataSource,
    NominatimClient client,
    NominatimOptions options,
    TimeProvider time,
    ILogger<PlaceNamer> logger) : BackgroundService
{
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromHours(24);
    private static readonly TimeSpan FirstCoolDown = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan MaxCoolDown = TimeSpan.FromHours(1);

    /// <summary>The no-answer returned and cached for a spot Nominatim knows nothing about (a 200 without a result has no JSON of its own to keep).</summary>
    private const string NoResultJson = """{"error":"Unable to geocode"}""";

    /// <summary>The loop never sleeps less than this, nor more than <see cref="MaxWait"/>, however <see cref="NominatimOptions.MinInterval"/> is set.</summary>
    private static readonly TimeSpan MinWait = TimeSpan.FromMilliseconds(50);
    private static readonly TimeSpan MaxWait = TimeSpan.FromSeconds(5);

    // In memory: after a restart the first request needs no wait. Only touched by the pass that is running.
    private DateTimeOffset? _lastRequestAt;
    private DateTimeOffset? _coolDownUntil;
    private int _consecutiveFailures;

    /// <summary>How long to wait before asking again after a place's <paramref name="attempts"/>-th failure: 2, 4, 8, ... minutes, at most 24 hours.</summary>
    public static TimeSpan Backoff(int attempts)
    {
        // Capped before the power so that a huge count cannot overflow.
        var wait = TimeSpan.FromMinutes(Math.Pow(2, Math.Clamp(attempts, 0, 20)));
        return wait < MaxBackoff ? wait : MaxBackoff;
    }

    /// <summary>
    /// How long all requests pause after the <paramref name="consecutiveFailures"/>-th failure in a row (of any place):
    /// 5, 10, 20, ... minutes, at most 1 hour. A success resets the count.
    /// </summary>
    public static TimeSpan CoolDown(int consecutiveFailures)
    {
        // Capped before the power so that a huge count cannot overflow.
        var wait = FirstCoolDown * Math.Pow(2, Math.Clamp(consecutiveFailures - 1, 0, 20));
        return wait < MaxCoolDown ? wait : MaxCoolDown;
    }

    /// <summary>
    /// One pass: names the first place that is due, from the cache if it is there, else from one Nominatim request,
    /// and returns whether it did anything. Returns <c>false</c> without any request when naming is disabled
    /// (<see cref="NominatimOptions.NamingEnabled"/>), when no place is due, and when a request is needed but less than
    /// <see cref="NominatimOptions.MinInterval"/> has passed since the last one or a cool-down after a failure is on
    /// (all measured with the injected <see cref="TimeProvider"/>; a cache hit counts toward neither and is served
    /// regardless). Whatever goes wrong with a request (Nominatim refusing or unreachable, junk in the answer, an
    /// unexpected exception) is recorded on the place and is not thrown, so the place is not picked again at once; a
    /// database failure is thrown, and so is an <see cref="OperationCanceledException"/> when <paramref name="ct"/>
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
            await SaveNameAsync(place.Id, cached.Result, ct);
            logger.LogInformation("Named place {PlaceId} from the cache", place.Id);
            return null;
        }

        var now = Now();
        if (_coolDownUntil is { } until && now < until)
            return Clamp(until - now);
        if (_lastRequestAt is { } last && now - last < options.MinInterval)
            return Clamp(options.MinInterval - (now - last));

        _lastRequestAt = now; // a request that fails counts as well
        NominatimResult? result;
        try
        {
            result = await client.ReverseAsync(new GeoPoint(place.Latitude, place.Longitude), ct);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            // Nominatim being unavailable, or anything unexpected (a bug, a base URL that cannot be requested): in every
            // case the place must not be due again at once, or the same request would repeat as fast as the interval allows.
            var attempts = place.Attempts + 1;
            var failedAt = Now();
            var retryAt = failedAt + Backoff(attempts);
            await SaveFailureAsync(place.Id, attempts, retryAt, ct);

            _consecutiveFailures++;
            _coolDownUntil = failedAt + CoolDown(_consecutiveFailures);
            if (ex is NominatimUnavailableException)
                logger.LogWarning(ex, "Nominatim could not name place {PlaceId} (attempt {Attempts}); this place waits until {RetryAt:o}, all requests until {CoolDownUntil:o}", place.Id, attempts, retryAt, _coolDownUntil);
            else
                logger.LogError(ex, "Asking Nominatim about place {PlaceId} failed unexpectedly (attempt {Attempts}); this place waits until {RetryAt:o}, all requests until {CoolDownUntil:o}", place.Id, attempts, retryAt, _coolDownUntil);
            return null;
        }

        (_consecutiveFailures, _coolDownUntil) = (0, null);
        await SaveNameAsync(place.Id, result, ct);

        // The cache only saves later requests, so failing to fill it must not undo or repeat this one. A spot Nominatim
        // knows nothing about is cached as well, so that no other place there asks again.
        try
        {
            await SaveCacheAsync(place, result?.RawJson ?? NoResultJson, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Could not cache the Nominatim answer for place {PlaceId}", place.Id);
        }

        if (result is null)
            logger.LogInformation("Nominatim knows nothing about place {PlaceId}", place.Id);
        else
            logger.LogInformation("Named place {PlaceId} from Nominatim", place.Id);
        return null;
    }

    /// <summary>
    /// The oldest place that is waiting for a name and due. Only places in use (<see cref="PlaceStore.InUse"/>: not merged
    /// into another and shown on the timeline by at least one segment, the same places the status counts). Orphans (left
    /// behind by a reprocessing that moved a stay) would cost public requests for nothing.
    /// </summary>
    private async Task<PlaceRow?> FindDueAsync(DateTime nowUtc, CancellationToken ct)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        return await connection.QueryFirstOrDefaultAsync<PlaceRow>(new CommandDefinition(
            $"""
            select p.id as Id, p.latitude as Latitude, p.longitude as Longitude, p.geocode_attempts as Attempts
            from place p
            where p.geocode_state in ('pending', 'failed')
              and {PlaceStore.InUse}
              and (p.geocode_next_attempt_at is null or p.geocode_next_attempt_at <= @Now)
            order by p.id
            limit 1
            """,
            new { Now = nowUtc }, cancellationToken: ct));
    }

    /// <summary>
    /// The cached answer for the 4-decimal key of <paramref name="place"/> (about 11 m), if there is a usable one: a
    /// cached "nothing here" is a hit with no <see cref="Cached.Result"/>, an unusable row is a miss.
    /// </summary>
    private async Task<Cached?> FindCachedAsync(PlaceRow place, CancellationToken ct)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var json = await connection.ExecuteScalarAsync<string?>(new CommandDefinition(
            "select response::text from geocode_cache where lat_key = round(@Latitude::numeric, 4) and lon_key = round(@Longitude::numeric, 4)",
            new { place.Latitude, place.Longitude }, cancellationToken: ct));
        if (json is null)
            return null;

        try
        {
            return new Cached(NominatimClient.Parse(json));
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

    private sealed record Cached(NominatimResult? Result);

    // A class with setters rather than a record: Dapper matches a record's constructor by exact column types.
    private sealed class PlaceRow
    {
        public long Id { get; set; }
        public double Latitude { get; set; }
        public double Longitude { get; set; }
        public int Attempts { get; set; }
    }
}
