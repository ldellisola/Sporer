using System.Data;
using System.Globalization;
using Dapper;
using Npgsql;
using Sporer.Api.Features.Range;
using Sporer.Api.Features.Timeline;
using Sporer.Timeline;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// A stored trip with what a list of trips is drawn from. <paramref name="Nights"/> are its nights with a known position, in
/// date order, each with the city and country of its surviving place (see <see cref="TripStore.ListAsync"/>);
/// <paramref name="HomeAtStart"/> and <paramref name="HomeAtEnd"/> are the home in effect on its first night and on the night after its last,
/// null where no home period covers the night: the home it left from and the one it came back to, which is another when the person moved
/// house while away (a new home is in effect from the night after the trip, as <see cref="TripDetector"/> measures the return). The
/// trip's own fields are those the detector found, with the dates of the owner's edit where it has given it any, and its id is its
/// first night. <paramref name="Name"/> is the owner's name for it, null for the automatic one, and <paramref name="Edited"/> says that
/// the trip has an edit (see <see cref="TripStore.ListAsync"/>).
/// </summary>
public sealed record StoredTrip(
    DetectedTrip Trip, IReadOnlyList<TripNight> Nights, GeoPoint? HomeAtStart, GeoPoint? HomeAtEnd, string? Name = null, bool Edited = false);

/// <summary>
/// The home in effect on a date: the place that survives merges (the id the day and range views give a stay at it) and that
/// place's position. <paramref name="NightPlaceIds"/> are the surviving places that were the night location on at least one
/// night of that home period, the home place among them when it was: the places home detection counted for it, and so the
/// only ones near the home that are the home too (a café next door is never the 03:00 location).
/// </summary>
public sealed record HomeInEffect(long PlaceId, GeoPoint Position, IReadOnlySet<long> NightPlaceIds);

/// <summary>
/// A stay inside a trip, as the trip's days are made from it: <paramref name="StartUtc"/> and <paramref name="EndUtc"/> are the
/// stay's own (not clipped to the trip), and the local dates are the ones it was stored with. The place is the one that survives
/// merges; <paramref name="PlaceId"/> is null for a stay that matched no place, or whose merges never end, and
/// <paramref name="PlaceName"/> is the owner's name for the place, else OpenStreetMap's, else null.
/// </summary>
public sealed record TripStay(
    DateTime StartUtc, DateTime EndUtc, DateOnly LocalStartDate, DateOnly LocalEndDate,
    long? PlaceId, string? PlaceName, string? City, string? Country);

/// <summary>
/// A move inside a trip: <paramref name="Line"/> is the stored coarse line (empty for a move that has none), and
/// <paramref name="Mode"/> is null for one whose mode could not be told. A move with no distance has none: 0.
/// </summary>
public sealed record TripMove(
    long Id, string? Mode, DateOnly LocalStartDate, DateOnly LocalEndDate, double DistanceM, IReadOnlyList<GeoPoint> Line);

/// <summary>
/// One trip and what its detail is made from (see <see cref="TripStore.FindAsync"/>). <paramref name="SpanEndUtc"/> is where the
/// trip's span ends: when it ended, or for an ongoing trip the end of the latest segment stored. <paramref name="Nights"/> are the
/// nights of the trip that have a position, as in <see cref="StoredTrip"/>. <paramref name="SleepPlaces"/> says, for the nights
/// from the one before the trip's first day to the one of its last, the surviving place each was spent at (a night that has
/// none is not in it). <paramref name="Stays"/> and <paramref name="Moves"/> are those that overlap the span, earliest first.
/// <paramref name="Name"/> and <paramref name="Edited"/> are as in <see cref="StoredTrip"/>.
/// </summary>
public sealed record TripDetail(
    DetectedTrip Trip, DateTime SpanEndUtc, IReadOnlyList<TripNight> Nights, IReadOnlyDictionary<DateOnly, long> SleepPlaces,
    IReadOnlyList<TripStay> Stays, IReadOnlyList<TripMove> Moves, string? Name = null, bool Edited = false);

/// <summary>
/// The homes and trips (<c>home_period</c>, <c>trip</c>) and the window of the timeline that has been rebuilt since they were
/// last worked out (<c>night_refresh</c>). Everything in them is derived, and is rewritten as a whole from the nights, and from the
/// owner's edits of the trips (<see cref="TripEditStore"/>), by <see cref="TripRefresher"/>; this class writes them and reads them back.
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
    /// failure leaves the old ones. Internal: the app writes them in the transaction of <see cref="TripRefresher"/>, with the nights
    /// (<see cref="ReplaceAllAsync(NpgsqlConnection, NpgsqlTransaction, DateOnly, DateOnly, IReadOnlyList{ValueTuple{Night, string}}, IReadOnlyList{HomePeriod}, IReadOnlyList{DetectedTrip}, CancellationToken)"/>)
    /// or without them (<see cref="ReplaceDetectedAsync(NpgsqlConnection, NpgsqlTransaction, IReadOnlyList{HomePeriod}, IReadOnlyList{DetectedTrip}, CancellationToken)"/>);
    /// this is for the tests, which pin what the homes and trips tables hold without a refresh.
    /// </summary>
    internal async Task ReplaceDetectedAsync(
        IReadOnlyList<HomePeriod> homes, IReadOnlyList<DetectedTrip> trips, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        await ReplaceDetectedAsync(connection, transaction, homes, [.. trips.Select(EditedTrip.Unedited)], ct);

        await transaction.CommitAsync(ct);
    }

    /// <summary>
    /// Replaces the nights dated <paramref name="from"/> to <paramref name="to"/> by <paramref name="nights"/> (as
    /// <see cref="NightStore"/> does) and every detected home period and trip by <paramref name="homes"/> and
    /// <paramref name="trips"/>, all in one transaction. The homes and trips are worked out from the nights, so a reader must
    /// never find new nights with the old trips, which two transactions would allow for as long as it took the second to run
    /// or, after a failure between them, for good: a failure leaves all of it as it was. The app writes them through the overload that
    /// takes the caller's transaction (<see cref="TripRefresher"/>, whose transaction holds the lock that serializes whatever writes them);
    /// this one takes no lock, and is internal, for the tests, which pin what the tables hold without a refresh.
    /// </summary>
    internal async Task ReplaceAllAsync(
        DateOnly from, DateOnly to, IReadOnlyList<(Night Night, string Source)> nights,
        IReadOnlyList<HomePeriod> homes, IReadOnlyList<DetectedTrip> trips, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        await ReplaceAllAsync(connection, transaction, from, to, nights, homes, [.. trips.Select(EditedTrip.Unedited)], ct);

        await transaction.CommitAsync(ct);
    }

    /// <summary>
    /// The same, in the caller's transaction, which commits it or not: it is how <see cref="TripRefresher"/> writes after it has taken
    /// its lock, in the transaction that holds it.
    /// </summary>
    internal async Task ReplaceAllAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, DateOnly from, DateOnly to,
        IReadOnlyList<(Night Night, string Source)> nights, IReadOnlyList<HomePeriod> homes, IReadOnlyList<EditedTrip> trips,
        CancellationToken ct = default)
    {
        await nightStore.ReplaceAsync(connection, transaction, from, to, nights, ct);
        await ReplaceDetectedAsync(connection, transaction, homes, trips, ct);
    }

    /// <summary>
    /// The same as <see cref="ReplaceDetectedAsync(IReadOnlyList{HomePeriod}, IReadOnlyList{DetectedTrip}, CancellationToken)"/>, in the
    /// caller's transaction: it is how the homes and trips are written without the nights (<see cref="ITripRefresher.RecomputeAsync"/>).
    /// The trips are those detected with the owner's edits put on them (<see cref="TripEdits.Apply"/>): a trip is stored with the owner's
    /// name (<c>name</c>), if it has one, and with the first night its edit is keyed by (<c>detected_id</c>) where that is not its own.
    /// </summary>
    internal static async Task ReplaceDetectedAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction,
        IReadOnlyList<HomePeriod> homes, IReadOnlyList<EditedTrip> trips, CancellationToken ct)
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
                insert into trip (id, last_night, nights, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date, name, detected_id)
                values (@Id, @LastNight, @Nights, @StartUtc, @EndUtc, @StartZone, @EndZone, @LocalStartDate, @LocalEndDate, @Name, @DetectedId)
                """,
                trips.Select(e => new
                {
                    Id = e.Trip.FirstNight,
                    e.Trip.LastNight,
                    e.Trip.Nights,
                    StartUtc = AsUtc(e.Trip.StartUtc),
                    EndUtc = e.Trip.EndUtc is { } end ? AsUtc(end) : (DateTime?)null,
                    e.Trip.StartZone,
                    e.Trip.EndZone,
                    e.Trip.LocalStartDate,
                    e.Trip.LocalEndDate,
                    e.Name,
                    DetectedId = e.DetectedId == e.Trip.FirstNight ? (DateOnly?)null : e.DetectedId,
                }).ToList(),
                transaction, cancellationToken: ct));
        }
    }

    /// <summary>The columns of a trip row, as <see cref="TripRow"/> reads them.</summary>
    private const string TripColumns =
        """
        to_char(id, 'YYYY-MM-DD') as FirstNight, to_char(last_night, 'YYYY-MM-DD') as LastNight, nights as Nights,
        start_utc as StartUtc, end_utc as EndUtc, start_tz as StartZone, end_tz as EndZone,
        to_char(local_start_date, 'YYYY-MM-DD') as LocalStartDate, to_char(local_end_date, 'YYYY-MM-DD') as LocalEndDate,
        name as Name,
        (name is not null or detected_id is not null
         or exists (select 1 from trip_edit e where e.detected_id = coalesce(trip.detected_id, trip.id) and not e.deleted)) as Edited
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
    /// <para>
    /// <c>Name</c> is the owner's name for the trip (<c>trip.name</c>), null for the automatic one. A trip is <c>Edited</c> when it has an
    /// edit: it has the owner's name, or the first night its edit is keyed by is not its own (<c>detected_id</c>), or a stored edit
    /// is keyed by it (<c>trip_edit</c>). The last is the only thing that says that the dates were changed, because the trip row does not
    /// keep the dates it was detected with. The edit of a deleted trip is the edit of no trip.
    /// </para>
    /// </remarks>
    public async Task<IReadOnlyList<StoredTrip>> ListAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);

        var trips = await connection.QueryAsync<TripRow>(new CommandDefinition(
            $"select {TripColumns} from trip order by id desc", transaction: transaction, cancellationToken: ct));

        var nights = await connection.QueryAsync<TripNightRow>(new CommandDefinition(
            $"""
            with recursive
            named as (
                select t.id as trip_id, n.date, n.place_id, n.latitude, n.longitude
                from trip t
                join night n on n.date between t.id and t.last_night
                where n.latitude is not null and n.longitude is not null
            ),
            {PlaceStore.Survivors}
            select to_char(named.trip_id, 'YYYY-MM-DD') as TripId, to_char(named.date, 'YYYY-MM-DD') as Date,
                   p.city as City, p.country as Country, named.latitude as Latitude, named.longitude as Longitude
            from named
            left join survivor on survivor.origin = named.place_id
            left join place p on p.id = survivor.id
            order by named.trip_id, named.date
            """,
            transaction: transaction, cancellationToken: ct));

        var homeList = await LoadHomesAsync(connection, transaction, ct);

        await transaction.CommitAsync(ct);

        var nightsOf = nights.ToLookup(n => n.TripId);

        return
        [
            .. trips.Select(t =>
            {
                var trip = ToTrip(t);
                var known = nightsOf[t.FirstNight]
                    .Select(n => new TripNight(ParseDate(n.Date), n.City, n.Country, new GeoPoint(n.Latitude, n.Longitude)));

                return new StoredTrip(
                    trip, [.. known], HomeOn(trip.FirstNight, homeList)?.Position, HomeOn(trip.LastNight.AddDays(1), homeList)?.Position, t.Name, t.Edited);
            }),
        ];
    }

    /// <summary>
    /// A home period with the surviving place it is of (<paramref name="PlaceId"/>) and that place's position, both ends of the
    /// period included; a null end is open.
    /// </summary>
    private sealed record HomeAt(DateOnly From, DateOnly? To, long PlaceId, GeoPoint Position);

    /// <summary>
    /// Every home period, resolved to its surviving place, in order of precedence: the owner's (<c>user</c>) before a detected
    /// one, then the one that began later, then the later row. Where periods overlap the first that covers a date is the home on
    /// it, which <see cref="HomeOn"/> picks; the trips list and the day view both read their homes this way, so that they cannot
    /// disagree. A period whose place's merges never end has no survivor and is not in it. There are only a few periods (a home
    /// is lived in for months), so all of them are read.
    /// </summary>
    private static async Task<IReadOnlyList<HomeAt>> LoadHomesAsync(
        NpgsqlConnection connection, NpgsqlTransaction? transaction, CancellationToken ct)
    {
        var homes = await connection.QueryAsync<HomeRow>(new CommandDefinition(
            $"""
            with recursive
            named as (
                select place_id from home_period
            ),
            {PlaceStore.Survivors}
            select to_char(h.from_date, 'YYYY-MM-DD') as FromDate, to_char(h.to_date, 'YYYY-MM-DD') as ToDate,
                   p.id as PlaceId, p.latitude as Latitude, p.longitude as Longitude
            from home_period h
            join survivor on survivor.origin = h.place_id
            join place p on p.id = survivor.id
            order by (h.source = 'user') desc, h.from_date desc, h.id desc
            """,
            transaction: transaction, cancellationToken: ct));

        return
        [
            .. homes.Select(h => new HomeAt(
                ParseDate(h.FromDate), h.ToDate is null ? null : ParseDate(h.ToDate), h.PlaceId, new GeoPoint(h.Latitude, h.Longitude))),
        ];
    }

    /// <summary>The first of <paramref name="homes"/> (they are in order of precedence) that covers <paramref name="date"/>, or null.</summary>
    private static HomeAt? HomeOn(DateOnly date, IReadOnlyList<HomeAt> homes)
    {
        foreach (var home in homes)
            if (home.From <= date && (home.To is null || date <= home.To))
                return home;

        return null;
    }

    /// <summary>
    /// The place that was home on <paramref name="date"/>, the one that survives merges (the id the day and range views give a
    /// stay at it), with its position and the places that were the night location during that home period (see
    /// <see cref="HomeInEffect"/>), or null when no home period covers the date. Both ends of a period are days it covers.
    /// Where periods overlap, the one the trips list would take for the date is taken (see <see cref="LoadHomesAsync"/>): the
    /// home in effect is the one of the day looked at, not of today.
    /// </summary>
    /// <remarks>
    /// The night places are those of the nights dated from the period's first to its last day (an open period has no last),
    /// each resolved to its surviving place with <see cref="PlaceStore.Survivors"/> as the other reads are, and a night with no
    /// place or whose merges never end has none. They are what <c>HomeDetector</c> counted to make the period, which is why a
    /// place near the home is part of it only if it is among them. The homes and the nights are read in one snapshot, so that a
    /// refresh that lands in the middle (it replaces nights and homes together) cannot give a home the nights of another.
    /// </remarks>
    public async Task<HomeInEffect?> FindHomeOnAsync(DateOnly date, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);

        var homes = await LoadHomesAsync(connection, transaction, ct);
        if (HomeOn(date, homes) is not { } home)
            return null;

        var nightPlaces = await connection.QueryAsync<long>(new CommandDefinition(
            $"""
            with recursive
            named as (
                select place_id from night where date >= @From and (@To::date is null or date <= @To::date) and place_id is not null
            ),
            {PlaceStore.Survivors}
            select distinct survivor.id
            from night n
            join survivor on survivor.origin = n.place_id
            where n.date >= @From and (@To::date is null or n.date <= @To::date)
            """,
            new { From = home.From, To = home.To }, transaction, cancellationToken: ct));

        await transaction.CommitAsync(ct);

        return new HomeInEffect(home.PlaceId, home.Position, nightPlaces.ToHashSet());
    }

    /// <summary>
    /// The trip whose id is <paramref name="id"/> (the date of its first night), with what its detail is made from, or null when
    /// there is none. Read in one snapshot and in a constant number of queries, however long the trip: the trip, the latest
    /// segment's end if the trip is ongoing, its nights, and its stays and moves. As in <see cref="ListAsync"/>, a refresh that
    /// lands in the middle (it replaces nights and trips together) cannot leave the trip with the nights of another.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The span of the trip is from its start to its end. An ongoing trip has no end, and its span runs to the end of the latest
    /// segment stored: all the timeline knows of it so far. A stay or move is in the trip when it overlaps the span, so the stays
    /// at home on either side of it (which end at its start and begin at its end) are not, and one that begins before the start
    /// or ends after the end is in as a whole. Gaps are not in it: a day with only a gap is a day with no data. A move or
    /// stay keeps the local dates it was stored with.
    /// </para>
    /// <para>
    /// Segments do not overlap (see <see cref="SegmentStore.FindLastEndAsync"/>), so the only one that can overlap the span and
    /// start before it is the last one that starts at or before its start: the read begins there, on <c>ix_segment_start</c>,
    /// as <see cref="SegmentStore.FindCoveringAsync"/> does, and does not go through the history behind it. A stay of three
    /// weeks that began long before the trip is found that way.
    /// </para>
    /// <para>
    /// The place of a stay and of a night is resolved to the place that survives merges, as in the list, and its name, city and
    /// country are read now. <see cref="TripDetail.SleepPlaces"/> covers the nights from the one before the trip's first local
    /// day to the one of its last: the days of the trip each look at the night before and the night of their date. A place
    /// whose merges never end counts as no place.
    /// </para>
    /// </remarks>
    public async Task<TripDetail?> FindAsync(DateOnly id, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);

        var row = await connection.QuerySingleOrDefaultAsync<TripRow>(new CommandDefinition(
            $"select {TripColumns} from trip where id = @Id", new { Id = id }, transaction, cancellationToken: ct));
        if (row is null)
            return null;

        var trip = ToTrip(row);

        // Segments do not overlap, so the one that starts last ends last (as SegmentStore.FindLastEndAsync has it), here in the
        // same snapshot as the rest. With nothing stored after the start, the span is empty.
        var spanEnd = trip.EndUtc;
        if (spanEnd is null)
        {
            var latest = await connection.QuerySingleOrDefaultAsync<DateTime?>(new CommandDefinition(
                "select end_utc from segment order by start_utc desc limit 1", transaction: transaction, cancellationToken: ct));
            spanEnd = latest is { } last && AsUtc(last) > trip.StartUtc ? AsUtc(last) : trip.StartUtc;
        }

        // The nights of the trip itself, and those the days around it look at: the night before its first day to the night of its last.
        var before = trip.LocalStartDate.AddDays(-1);
        var firstNight = before < trip.FirstNight ? before : trip.FirstNight;
        var lastNight = trip.LocalEndDate > trip.LastNight ? trip.LocalEndDate : trip.LastNight;
        var nights = await connection.QueryAsync<DetailNightRow>(new CommandDefinition(
            $"""
            with recursive
            named as (
                select place_id from night where date between @From and @To and place_id is not null
            ),
            {PlaceStore.Survivors}
            select to_char(n.date, 'YYYY-MM-DD') as Date, p.id as PlaceId, p.city as City, p.country as Country,
                   n.latitude as Latitude, n.longitude as Longitude
            from night n
            left join survivor on survivor.origin = n.place_id
            left join place p on p.id = survivor.id
            where n.date between @From and @To
            order by n.date
            """,
            new { From = firstNight, To = lastNight }, transaction, cancellationToken: ct));

        var segments = await connection.QueryAsync<DetailSegmentRow>(new CommandDefinition(
            $"""
            with recursive
            spanned as (
                select id, kind, start_utc, end_utc, local_start_date, local_end_date, place_id, mode, distance_m,
                       case when kind = 'move' then geometry_coarse::text end as geometry
                from segment
                where kind in ('stay', 'move') and start_utc < @SpanEnd and end_utc > @SpanStart
                  and start_utc >= coalesce((select max(start_utc) from segment where start_utc <= @SpanStart), @SpanStart)
            ),
            named as (
                select place_id from spanned where place_id is not null
            ),
            {PlaceStore.Survivors}
            select s.id as Id, s.kind as Kind, s.start_utc as StartUtc, s.end_utc as EndUtc,
                   to_char(s.local_start_date, 'YYYY-MM-DD') as LocalStartDate, to_char(s.local_end_date, 'YYYY-MM-DD') as LocalEndDate,
                   p.id as PlaceId, coalesce(p.user_name, p.osm_name) as PlaceName, p.city as City, p.country as Country,
                   s.mode as Mode, s.distance_m as DistanceM, s.geometry as GeometryCoarseJson
            from spanned s
            left join survivor on survivor.origin = s.place_id
            left join place p on p.id = survivor.id
            order by s.start_utc, s.id
            """,
            new { SpanStart = AsUtc(trip.StartUtc), SpanEnd = spanEnd.Value }, transaction, cancellationToken: ct));

        await transaction.CommitAsync(ct);

        var nightList = nights.Select(n => (Row: n, Date: ParseDate(n.Date))).ToList();
        return new TripDetail(
            trip,
            spanEnd.Value,
            [
                .. nightList
                    .Where(n => n.Date >= trip.FirstNight && n.Date <= trip.LastNight && n.Row.Latitude is not null && n.Row.Longitude is not null)
                    .Select(n => new TripNight(n.Date, n.Row.City, n.Row.Country, new GeoPoint(n.Row.Latitude!.Value, n.Row.Longitude!.Value))),
            ],
            nightList.Where(n => n.Row.PlaceId is not null).ToDictionary(n => n.Date, n => n.Row.PlaceId!.Value),
            [
                .. segments.Where(s => s.Kind == "stay").Select(s => new TripStay(
                    AsUtc(s.StartUtc), AsUtc(s.EndUtc), ParseDate(s.LocalStartDate), ParseDate(s.LocalEndDate),
                    s.PlaceId, s.PlaceName, s.City, s.Country)),
            ],
            [
                .. segments.Where(s => s.Kind == "move").Select(s => new TripMove(
                    s.Id, s.Mode, ParseDate(s.LocalStartDate), ParseDate(s.LocalEndDate), s.DistanceM ?? 0,
                    RangeStore.ParseLine(s.GeometryCoarseJson))),
            ],
            row.Name,
            row.Edited);
    }

    private static DetectedTrip ToTrip(TripRow row) => new(
        ParseDate(row.FirstNight),
        ParseDate(row.LastNight),
        row.Nights,
        AsUtc(row.StartUtc),
        row.EndUtc is { } end ? AsUtc(end) : null,
        row.StartZone,
        row.EndZone,
        ParseDate(row.LocalStartDate),
        ParseDate(row.LocalEndDate));

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
        public string? Name { get; set; }
        public bool Edited { get; set; }
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

    private sealed class DetailNightRow
    {
        public string Date { get; set; } = string.Empty;
        public long? PlaceId { get; set; }
        public string? City { get; set; }
        public string? Country { get; set; }
        public double? Latitude { get; set; }
        public double? Longitude { get; set; }
    }

    private sealed class DetailSegmentRow
    {
        public long Id { get; set; }
        public string Kind { get; set; } = string.Empty;
        public DateTime StartUtc { get; set; }
        public DateTime EndUtc { get; set; }
        public string LocalStartDate { get; set; } = string.Empty;
        public string LocalEndDate { get; set; } = string.Empty;
        public long? PlaceId { get; set; }
        public string? PlaceName { get; set; }
        public string? City { get; set; }
        public string? Country { get; set; }
        public string? Mode { get; set; }
        public double? DistanceM { get; set; }
        public string? GeometryCoarseJson { get; set; }
    }

    private sealed class HomeRow
    {
        public string FromDate { get; set; } = string.Empty;
        public string? ToDate { get; set; }
        public long PlaceId { get; set; }
        public double Latitude { get; set; }
        public double Longitude { get; set; }
    }
}
