using System.Data;
using System.Text.Json;
using Dapper;
using Npgsql;
using Sporer.Timeline;

namespace Sporer.Api.Features.Range;

/// <summary>
/// A move of a range. <paramref name="Line"/> is the stored coarse line, vertex by vertex (empty for a move that has none);
/// all times are UTC.
/// </summary>
public sealed record RangeMove(long Id, string? Mode, DateTime StartUtc, DateTime EndUtc, double? DistanceM, IReadOnlyList<GeoPoint> Line);

/// <summary>
/// A place that was visited in a range: <paramref name="Seconds"/> is the time spent there inside the range (see
/// <see cref="RangeStore.FindAsync"/>), <paramref name="Visits"/> the number of stays it was spent in.
/// </summary>
public sealed record RangePlace(
    long Id, string? Name, string? City, string? Country, double Latitude, double Longitude, long Seconds, int Visits);

/// <summary>
/// A cell of the heat grid: <paramref name="Latitude"/> and <paramref name="Longitude"/> are its centre, <paramref name="Seconds"/>
/// the time spent in it inside the range.
/// </summary>
public sealed record HeatCell(double Latitude, double Longitude, long Seconds);

/// <summary>One local day of a range that has a segment starting on it, with what the moves that start on it add up to.</summary>
public sealed record RangeDay(DateOnly Date, double DistanceM, long MovingSeconds, int Places);

/// <summary>Everything a range response is made of that is read from the database.</summary>
public sealed record RangeData(IReadOnlyList<RangeMove> Moves, IReadOnlyList<RangePlace> Places, IReadOnlyList<RangeDay> Days);

/// <summary>Reads the stored timeline over a range of local days.</summary>
public sealed class RangeStore(NpgsqlDataSource dataSource)
{
    /// <summary>
    /// The SQL for the stays that touch the range and the place each one is shown as, to start a <c>with recursive</c> list that
    /// goes on with more tables. <c>stays</c> are the stays with a place, selected as the day view selects its segments (the
    /// local dates overlap the range, which <c>ix_segment_local_dates</c> serves). <c>survivor</c> maps each place a stay
    /// names (<c>origin</c>) to the place it stands for (<c>id</c>): a place merged into another is followed through
    /// <c>merged_into_id</c>, up to 32 links, as the day view does, to the one that is not merged into any. A chain that never
    /// ends (a cycle, which the app does not write but the schema allows) has no survivor, so its stays are left out.
    /// </summary>
    private const string StaysWithSurvivors =
        """
        with recursive
        stays as (
            select place_id, start_utc, end_utc, start_tz, local_start_date
            from segment
            where kind = 'stay' and place_id is not null and local_start_date <= @To and local_end_date >= @From
        ),
        chain as (
            select p.id as origin, p.id, p.merged_into_id, 0 as depth
            from place p
            where p.id in (select place_id from stays)
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
    /// The moves, places and days of <paramref name="range"/>; all of it from one snapshot of the database, so that a rewrite of the
    /// timeline that lands in the middle cannot leave the three disagreeing.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A segment belongs to the range when its local dates overlap it (<c>local_start_date &lt;= to</c> and
    /// <c>local_end_date &gt;= from</c>), which is what makes a stay across midnight part of both days.
    /// </para>
    /// <para>
    /// <b>Moves</b> are the moves (flights too) in time order, with their stored coarse line. <b>Places</b> add up the time of
    /// each stay inside the range, per surviving place: a stay's time counts from the start of <c>from</c> to the start of the day
    /// after <c>to</c>, both read on the clock of the stay's own start zone (<c>(date::timestamp at time zone zone)</c>), so
    /// that a day of 23 or 25 hours is what it is there. A stay with none of its time inside (one that ends exactly at the
    /// range's first midnight) is not a visit. Most time first, then by id. <b>Days</b> hold, for each local date of the range
    /// on which some segment starts, the distance and the time of the moves that start on it, and the number of places its
    /// stays are at: a segment is counted once, on the date it starts on.
    /// </para>
    /// </remarks>
    public async Task<RangeData> FindAsync(DateRange range, CancellationToken ct = default)
    {
        var parameters = new { From = range.From, To = range.To };
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);

        var moves = await connection.QueryAsync<MoveRow>(new CommandDefinition(
            """
            select id as Id, mode as Mode, start_utc as StartUtc, end_utc as EndUtc, distance_m as DistanceM,
                   geometry_coarse::text as GeometryCoarseJson
            from segment
            where kind = 'move' and local_start_date <= @To and local_end_date >= @From
            order by start_utc, id
            """,
            parameters, transaction, cancellationToken: ct));

        var places = await connection.QueryAsync<PlaceRow>(new CommandDefinition(
            StaysWithSurvivors +
            """
            ,
            clipped as (
                select sv.id as place_id,
                       extract(epoch from least(st.end_utc, (@To::date + 1)::timestamp at time zone st.start_tz)
                                        - greatest(st.start_utc, @From::date::timestamp at time zone st.start_tz)) as seconds
                from stays st
                join survivor sv on sv.origin = st.place_id
            )
            select p.id as Id, coalesce(p.user_name, p.osm_name) as Name, p.city as City, p.country as Country,
                   p.latitude as Latitude, p.longitude as Longitude,
                   sum(c.seconds)::double precision as Seconds, count(*) as Visits
            from clipped c
            join place p on p.id = c.place_id
            where c.seconds > 0
            group by p.id
            """,
            parameters, transaction, cancellationToken: ct));

        var days = await connection.QueryAsync<DayRow>(new CommandDefinition(
            StaysWithSurvivors +
            """
            ,
            day_places as (
                select st.local_start_date as local_date, count(distinct sv.id) as places
                from stays st
                join survivor sv on sv.origin = st.place_id
                group by st.local_start_date
            ),
            day_moves as (
                select local_start_date as local_date,
                       coalesce(sum(distance_m) filter (where kind = 'move'), 0)::double precision as distance_m,
                       coalesce(sum(extract(epoch from end_utc - start_utc)) filter (where kind = 'move'), 0)::double precision as moving_seconds
                from segment
                where local_start_date between @From and @To
                group by local_start_date
            )
            select to_char(m.local_date, 'YYYY-MM-DD') as Date, m.distance_m as DistanceM, m.moving_seconds as MovingSeconds,
                   coalesce(p.places, 0) as Places
            from day_moves m
            left join day_places p on p.local_date = m.local_date
            order by m.local_date
            """,
            parameters, transaction, cancellationToken: ct));

        await transaction.CommitAsync(ct);

        return new RangeData(
            [.. moves.Select(m => new RangeMove(m.Id, m.Mode, AsUtc(m.StartUtc), AsUtc(m.EndUtc), m.DistanceM, ParseLine(m.GeometryCoarseJson)))],
            [.. places
                .Select(p => new RangePlace(p.Id, p.Name, p.City, p.Country, p.Latitude, p.Longitude, (long)Math.Round(p.Seconds), (int)p.Visits))
                .OrderByDescending(p => p.Seconds).ThenBy(p => p.Id)],
            [.. days.Select(d => new RangeDay(
                DateOnly.ParseExact(d.Date, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                d.DistanceM, (long)Math.Round(d.MovingSeconds), (int)d.Places))]);
    }

    /// <summary>
    /// Where the time of <paramref name="range"/> was spent: its stays, each at its own centre (the stay's position, not its
    /// place's), in a grid of cells a thousandth of a degree (about 110 m of latitude) on a side. A cell is named by its centre,
    /// the position rounded to three decimals, and weighs the seconds of the stays in it. The weight is time, not points: a
    /// night is heavier than a coffee however often either was logged. The most weight first; cells of equal weight by latitude,
    /// then longitude, so that the answer, and with it its tag, is the same each time.
    /// </summary>
    /// <remarks>
    /// A stay's seconds are clipped to the range as the places' are (see <see cref="FindAsync"/>): from the start of the first
    /// day to the start of the day after the last, on the clock of the stay's own start zone, and a stay with none of its time
    /// inside makes no cell. A stay with no place counts like any other. One without a position, or at a position that is not on
    /// the globe (ingest stores whatever a client sends, and a latitude of 95 would stop the map from drawing the rest), cannot
    /// be drawn and is left out. A merged place changes nothing: no place is looked at.
    /// </remarks>
    public async Task<IReadOnlyList<HeatCell>> FindHeatAsync(DateRange range, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);

        // One statement, so one snapshot: no transaction to hold the rest still. round() has no double precision form.
        var cells = await connection.QueryAsync<HeatRow>(new CommandDefinition(
            """
            with clipped as (
                select round(latitude::numeric, 3) as lat, round(longitude::numeric, 3) as lon,
                       extract(epoch from least(end_utc, (@To::date + 1)::timestamp at time zone start_tz)
                                        - greatest(start_utc, @From::date::timestamp at time zone start_tz)) as secs
                from segment
                where kind = 'stay' and local_start_date <= @To and local_end_date >= @From
                  and latitude between -90 and 90 and longitude between -180 and 180
            )
            select lat::double precision as Latitude, lon::double precision as Longitude, sum(secs)::double precision as Seconds
            from clipped
            where secs > 0
            group by lat, lon
            """,
            new { From = range.From, To = range.To }, cancellationToken: ct));

        return
        [
            .. cells
                .Select(c => new HeatCell(c.Latitude, c.Longitude, (long)Math.Round(c.Seconds)))
                .OrderByDescending(c => c.Seconds).ThenBy(c => c.Latitude).ThenBy(c => c.Longitude),
        ];
    }

    private static DateTime AsUtc(DateTime value) => DateTime.SpecifyKind(value, DateTimeKind.Utc);

    /// <summary>The stored <c>[[lon,lat],...]</c> as points. A move without a line has an empty one.</summary>
    private static GeoPoint[] ParseLine(string? json)
    {
        var pairs = string.IsNullOrEmpty(json) ? null : JsonSerializer.Deserialize<double[][]>(json);
        return pairs is null ? [] : [.. pairs.Where(p => p.Length >= 2).Select(p => new GeoPoint(Latitude: p[1], Longitude: p[0]))];
    }

    private sealed record MoveRow(long Id, string? Mode, DateTime StartUtc, DateTime EndUtc, double? DistanceM, string? GeometryCoarseJson);

    private sealed record PlaceRow(
        long Id, string? Name, string? City, string? Country, double Latitude, double Longitude, double Seconds, long Visits);

    private sealed record HeatRow(double Latitude, double Longitude, double Seconds);

    private sealed record DayRow(string Date, double DistanceM, double MovingSeconds, long Places);
}
