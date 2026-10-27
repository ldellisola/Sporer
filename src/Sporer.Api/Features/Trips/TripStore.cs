using System.Data;
using System.Globalization;
using Dapper;
using Npgsql;
using Sporer.Timeline;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// A stored trip with what a list of trips is drawn from. <paramref name="Nights"/> are its nights with a known position, in
/// date order, each with the city and country of its surviving place (see <see cref="TripStore.ListAsync"/>);
/// <paramref name="HomeAtStart"/> and <paramref name="HomeAtEnd"/> are the home in effect on its first and on its last night,
/// null where no home period covers the night. The trip's own fields are those the detector found, and its id is its first
/// night.
/// </summary>
public sealed record StoredTrip(
    DetectedTrip Trip, IReadOnlyList<TripNight> Nights, GeoPoint? HomeAtStart, GeoPoint? HomeAtEnd);

/// <summary>
/// The homes and trips (<c>home_period</c>, <c>trip</c>) and the window of the timeline that has been rebuilt since they were
/// last worked out (<c>night_refresh</c>). Everything in them is derived, and is rewritten as a whole from the nights by
/// <see cref="TripRefresher"/>; this class writes them and reads them back.
/// </summary>
public sealed class TripStore(NpgsqlDataSource dataSource, NightStore nightStore)
{
    /// <summary>
    /// Adds <paramref name="fromUtc"/> to <paramref name="toUtc"/> to the window that waits to be refreshed: the window
    /// becomes the one stretch from the earliest start to the latest end of everything added since the last refresh, so what
    /// lies between two separate additions is refreshed too. It is stored, so that a restart does not lose it.
    /// </summary>
    public async Task ExtendPendingAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            // least and greatest skip a null, which is how an empty window takes the first one.
            """
            insert into night_refresh (id, from_utc, to_utc) values (1, @From, @To)
            on conflict (id) do update set
                from_utc = least(night_refresh.from_utc, excluded.from_utc),
                to_utc = greatest(night_refresh.to_utc, excluded.to_utc)
            """,
            new { From = AsUtc(fromUtc), To = AsUtc(toUtc) }, cancellationToken: ct));
    }

    /// <summary>The window that waits to be refreshed, or null when nothing does. It stays until <see cref="ClearPendingAsync"/>.</summary>
    public async Task<(DateTime From, DateTime To)?> TakePendingAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var row = await connection.QuerySingleOrDefaultAsync<PendingRow>(new CommandDefinition(
            "select from_utc as FromUtc, to_utc as ToUtc from night_refresh where id = 1", cancellationToken: ct));

        return row is { FromUtc: { } from, ToUtc: { } to } ? (AsUtc(from), AsUtc(to)) : null;
    }

    /// <summary>
    /// Empties the window, but only if it is still exactly <paramref name="fromUtc"/> to <paramref name="toUtc"/>, the one
    /// <see cref="TakePendingAsync"/> gave: whatever was added to it since has not been refreshed yet and must stay.
    /// </summary>
    public async Task ClearPendingAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "update night_refresh set from_utc = null, to_utc = null where id = 1 and from_utc = @From and to_utc = @To",
            new { From = AsUtc(fromUtc), To = AsUtc(toUtc) }, cancellationToken: ct));
    }

    /// <summary>
    /// Replaces every detected home period and every trip by <paramref name="homes"/> and <paramref name="trips"/>. The home
    /// periods the owner set (<c>user</c>) are not touched. One transaction: readers see the old rows or the new ones, and a
    /// failure leaves the old ones. Internal: the app writes them only together with the nights (<see cref="ReplaceAllAsync"/>);
    /// this is for the tests, which pin what the homes and trips tables hold without building nights first.
    /// </summary>
    internal async Task ReplaceDetectedAsync(
        IReadOnlyList<HomePeriod> homes, IReadOnlyList<DetectedTrip> trips, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        await ReplaceDetectedAsync(connection, transaction, homes, trips, ct);

        await transaction.CommitAsync(ct);
    }

    /// <summary>
    /// Replaces the nights dated <paramref name="from"/> to <paramref name="to"/> by <paramref name="nights"/> (as
    /// <see cref="NightStore"/> does) and every detected home period and trip by <paramref name="homes"/> and
    /// <paramref name="trips"/>, all in one transaction. The homes and trips are worked out from the nights, so a reader must
    /// never find new nights with the old trips, which two transactions would allow for as long as it took the second to run
    /// or, after a failure between them, for good: a failure leaves all of it as it was. This is the only way the app writes
    /// them.
    /// </summary>
    public async Task ReplaceAllAsync(
        DateOnly from, DateOnly to, IReadOnlyList<(Night Night, string Source)> nights,
        IReadOnlyList<HomePeriod> homes, IReadOnlyList<DetectedTrip> trips, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        await nightStore.ReplaceAsync(connection, transaction, from, to, nights, ct);
        await ReplaceDetectedAsync(connection, transaction, homes, trips, ct);

        await transaction.CommitAsync(ct);
    }

    private static async Task ReplaceDetectedAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction,
        IReadOnlyList<HomePeriod> homes, IReadOnlyList<DetectedTrip> trips, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition(
            "delete from home_period where source = 'detected'; delete from trip;", transaction: transaction, cancellationToken: ct));

        if (homes.Count > 0)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "insert into home_period (place_id, from_date, to_date, source) values (@PlaceId, @From, @To, 'detected')",
                homes.Select(h => new { h.PlaceId, h.From, h.To }).ToList(),
                transaction, cancellationToken: ct));
        }

        if (trips.Count > 0)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                """
                insert into trip (id, last_night, nights, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date)
                values (@Id, @LastNight, @Nights, @StartUtc, @EndUtc, @StartZone, @EndZone, @LocalStartDate, @LocalEndDate)
                """,
                trips.Select(t => new
                {
                    Id = t.FirstNight,
                    t.LastNight,
                    t.Nights,
                    StartUtc = AsUtc(t.StartUtc),
                    EndUtc = t.EndUtc is { } end ? AsUtc(end) : (DateTime?)null,
                    t.StartZone,
                    t.EndZone,
                    t.LocalStartDate,
                    t.LocalEndDate,
                }).ToList(),
                transaction, cancellationToken: ct));
        }
    }

    /// <summary>
    /// The SQL that follows <c>with recursive</c> and a <c>named</c> list (its <c>place_id</c> column holds the places a query
    /// needs), to go on with more tables. <c>survivor</c> maps each of those places (<c>origin</c>) to the place it stands for
    /// (<c>id</c>): a place merged into another is followed through <c>merged_into_id</c>, up to 32 links, as the day and range
    /// views do, to the one that is not merged into any. A chain that never ends (a cycle, which the app does not write but the
    /// schema allows) has no survivor.
    /// </summary>
    private const string Survivors =
        """
        chain as (
            select p.id as origin, p.id, p.merged_into_id, 0 as depth
            from place p
            where p.id in (select place_id from named)
            union all
            select chain.origin, next.id, next.merged_into_id, chain.depth + 1
            from chain join place next on next.id = chain.merged_into_id
            where chain.depth < 32
        ),
        survivor as (
            select origin, id from chain where merged_into_id is null
        )
        """;

    /// <summary>
    /// Every trip, newest first, with its nights and the homes it began and ended at. Trips, nights and home periods are read
    /// in one snapshot, so that a refresh that lands in the middle (it replaces all three together) cannot leave a trip with the
    /// nights of another; and in a constant number of queries, whatever the number of trips.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A trip's nights are the stored nights from its first to its last night that have a position. A night with none (unknown,
    /// or a date with no row) is left out here, and still counts in the trip's own <c>Nights</c>. The place of a night is
    /// resolved to the place that survives merges, and its city and country are that place's: they are read now, not when the
    /// night was stored, so a place geocoded since is named. A night whose place is missing, or whose merges lead nowhere, has
    /// neither.
    /// </para>
    /// <para>
    /// The home in effect on a night is the home period that covers it, resolved to its surviving place. Periods should not
    /// overlap; where they do, the one the owner set (<c>user</c>) wins over a detected one, and the one that began later wins
    /// over an earlier one.
    /// </para>
    /// </remarks>
    public async Task<IReadOnlyList<StoredTrip>> ListAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);

        var trips = await connection.QueryAsync<TripRow>(new CommandDefinition(
            """
            select to_char(id, 'YYYY-MM-DD') as FirstNight, to_char(last_night, 'YYYY-MM-DD') as LastNight, nights as Nights,
                   start_utc as StartUtc, end_utc as EndUtc, start_tz as StartZone, end_tz as EndZone,
                   to_char(local_start_date, 'YYYY-MM-DD') as LocalStartDate, to_char(local_end_date, 'YYYY-MM-DD') as LocalEndDate
            from trip
            order by id desc
            """,
            transaction: transaction, cancellationToken: ct));

        var nights = await connection.QueryAsync<TripNightRow>(new CommandDefinition(
            $"""
            with recursive
            named as (
                select t.id as trip_id, n.date, n.place_id, n.latitude, n.longitude
                from trip t
                join night n on n.date between t.id and t.last_night
                where n.latitude is not null and n.longitude is not null
            ),
            {Survivors}
            select to_char(named.trip_id, 'YYYY-MM-DD') as TripId, to_char(named.date, 'YYYY-MM-DD') as Date,
                   p.city as City, p.country as Country, named.latitude as Latitude, named.longitude as Longitude
            from named
            left join survivor on survivor.origin = named.place_id
            left join place p on p.id = survivor.id
            order by named.trip_id, named.date
            """,
            transaction: transaction, cancellationToken: ct));

        var homes = await connection.QueryAsync<HomeRow>(new CommandDefinition(
            $"""
            with recursive
            named as (
                select place_id from home_period
            ),
            {Survivors}
            select to_char(h.from_date, 'YYYY-MM-DD') as FromDate, to_char(h.to_date, 'YYYY-MM-DD') as ToDate,
                   p.latitude as Latitude, p.longitude as Longitude
            from home_period h
            join survivor on survivor.origin = h.place_id
            join place p on p.id = survivor.id
            order by (h.source = 'user') desc, h.from_date desc, h.id desc
            """,
            transaction: transaction, cancellationToken: ct));

        await transaction.CommitAsync(ct);

        var nightsOf = nights.ToLookup(n => n.TripId);
        var homeList = homes
            .Select(h => new HomeAt(
                ParseDate(h.FromDate), h.ToDate is null ? null : ParseDate(h.ToDate), new GeoPoint(h.Latitude, h.Longitude)))
            .ToList();

        return
        [
            .. trips.Select(t =>
            {
                var trip = new DetectedTrip(
                    ParseDate(t.FirstNight),
                    ParseDate(t.LastNight),
                    t.Nights,
                    AsUtc(t.StartUtc),
                    t.EndUtc is { } end ? AsUtc(end) : null,
                    t.StartZone,
                    t.EndZone,
                    ParseDate(t.LocalStartDate),
                    ParseDate(t.LocalEndDate));
                var known = nightsOf[t.FirstNight]
                    .Select(n => new TripNight(ParseDate(n.Date), n.City, n.Country, new GeoPoint(n.Latitude, n.Longitude)));

                return new StoredTrip(trip, [.. known], HomeOn(trip.FirstNight, homeList), HomeOn(trip.LastNight, homeList));
            }),
        ];
    }

    /// <summary>A home period with the position of its surviving place, both ends included; a null end is open.</summary>
    private sealed record HomeAt(DateOnly From, DateOnly? To, GeoPoint Position);

    /// <summary>
    /// The position of the first of <paramref name="homes"/> (they are in order of precedence) that covers <paramref name="date"/>,
    /// or null.
    /// </summary>
    private static GeoPoint? HomeOn(DateOnly date, IReadOnlyList<HomeAt> homes)
    {
        foreach (var home in homes)
            if (home.From <= date && (home.To is null || date <= home.To))
                return home.Position;

        return null;
    }

    private static DateOnly ParseDate(string text) => DateOnly.ParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>Npgsql writes only UTC values to timestamptz. Everything in the timeline is UTC; unspecified means UTC too.</summary>
    private static DateTime AsUtc(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
    };

    // Classes with setters rather than records: Dapper matches a record's constructor by exact column types.
    private sealed class PendingRow
    {
        public DateTime? FromUtc { get; set; }
        public DateTime? ToUtc { get; set; }
    }

    private sealed class TripRow
    {
        public string FirstNight { get; set; } = string.Empty;
        public string LastNight { get; set; } = string.Empty;
        public int Nights { get; set; }
        public DateTime StartUtc { get; set; }
        public DateTime? EndUtc { get; set; }
        public string StartZone { get; set; } = string.Empty;
        public string EndZone { get; set; } = string.Empty;
        public string LocalStartDate { get; set; } = string.Empty;
        public string LocalEndDate { get; set; } = string.Empty;
    }

    private sealed class TripNightRow
    {
        public string TripId { get; set; } = string.Empty;
        public string Date { get; set; } = string.Empty;
        public string? City { get; set; }
        public string? Country { get; set; }
        public double Latitude { get; set; }
        public double Longitude { get; set; }
    }

    private sealed class HomeRow
    {
        public string FromDate { get; set; } = string.Empty;
        public string? ToDate { get; set; }
        public double Latitude { get; set; }
        public double Longitude { get; set; }
    }
}
