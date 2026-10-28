using Dapper;
using Npgsql;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

/// <summary>
/// One row of <c>segment</c>. <paramref name="GeometryDetailJson"/> and <paramref name="GeometryCoarseJson"/> are
/// <c>[[lon,lat],...]</c> with coordinates rounded to 6 decimals; all times are UTC. <paramref name="LocalStartDate"/> and
/// <paramref name="LocalEndDate"/> are the first and last local calendar day the segment touches: the dates of its two
/// ends in their own zones, the earlier one first (a westward flight can land on an earlier date than it left on).
/// </summary>
public sealed record StoredSegment(
    string Kind,
    DateTime StartUtc,
    DateTime EndUtc,
    string StartTz,
    string EndTz,
    DateOnly LocalStartDate,
    DateOnly LocalEndDate,
    long? PlaceId,
    double? Latitude,
    double? Longitude,
    string? Mode,
    double? DistanceM,
    string? GeometryDetailJson,
    string? GeometryCoarseJson,
    int PointCount);

/// <summary>
/// A segment as the day view needs it. <paramref name="Place"/> is the surviving place of a stay (never a merged-away one),
/// null for other kinds and for a stay without a place. <paramref name="GeometryDetailJson"/> is the stored
/// <c>[[lon,lat],...]</c> text of a move, or the two end positions of a gap.
/// </summary>
public sealed record DaySegment(
    long Id,
    string Kind,
    DateTime StartUtc,
    DateTime EndUtc,
    string StartTz,
    string EndTz,
    string? Mode,
    double? DistanceM,
    string? GeometryDetailJson,
    DayPlace? Place);

/// <summary>A place as shown on a stay: <see cref="Name"/> is the owner's name, else the one from OpenStreetMap, else null.</summary>
public sealed record DayPlace(long Id, string? Name, string? City, string? Country, double Latitude, double Longitude);

/// <summary>Reads and rewrites the derived timeline in <c>segment</c>.</summary>
public sealed class SegmentStore(NpgsqlDataSource dataSource)
{
    /// <summary>
    /// How far beyond a window <see cref="FindCoveringAsync"/> reaches, which is as far as a night's time zone is looked for
    /// from the segments around it: a night with no segment of its own takes the zone of the nearest one within this long.
    /// </summary>
    public static readonly TimeSpan CoveringMargin = TimeSpan.FromHours(36);

    /// <summary>
    /// The edges of the range that has to be rebuilt to reprocess <paramref name="fromUtc"/> to <paramref name="toUtc"/>.
    /// Stays are fixed points of the timeline (they start at a logged point and are found greedily from it), so the
    /// rebuild starts at a stay and stops at the end of one: <c>T0</c> is the start of the last stored stay that starts
    /// before <paramref name="fromUtc"/> (or <paramref name="fromUtc"/> itself when there is none), <c>T1</c> the end of the
    /// first stored stay that starts after <paramref name="toUtc"/> (or null when there is none: the processor then
    /// bounds the rebuild itself, see <see cref="FindLastEndAsync"/>).
    /// <para>
    /// <c>T0</c> is then raised, never past <paramref name="fromUtc"/>, so that the rebuild does not reach back across a
    /// stretch that was <em>set aside</em>: a dirty range with <see cref="ProcessingQueue.SetAsideAfterAttempts"/> or more
    /// attempts, whose rebuild keeps failing (loading the same data again would fail again, and every range after it with it).
    /// The stretch is read from the table each time, so it holds across restarts and for every rebuild, backfill chunks and
    /// live ranges alike; when its range is retried and succeeds the row is deleted and the floor is gone.
    /// </para>
    /// <para>
    /// Only a set-aside range that began after <c>T0</c> and before <paramref name="fromUtc"/> counts, and <c>T0</c> goes up
    /// to the smaller of its end and <paramref name="fromUtc"/>. One that began at or before <c>T0</c> has the stay inside
    /// it or behind it, and a stay there is not in what failed but in what was rebuilt since: the chunk after a set-aside
    /// one (its range runs on over that chunk, so that the retry rebuilds the edge between them), or an earlier piece of the
    /// retry itself, which rebuilds a long range piece by piece. Reaching back to that stay is right, and flooring at the
    /// range's end instead would cut the stay that crosses it. A range that starts where the rebuild does (its own retry) never counts.
    /// </para>
    /// </summary>
    public async Task<(DateTime T0, DateTime? T1)> FindAnchorsAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var anchors = await connection.QuerySingleAsync<AnchorRow>(new CommandDefinition(
            """
            select
              (select start_utc from segment where kind = 'stay' and start_utc < @FromUtc order by start_utc desc limit 1) as T0,
              (select end_utc   from segment where kind = 'stay' and start_utc > @ToUtc   order by start_utc       limit 1) as T1
            """,
            new { FromUtc = fromUtc, ToUtc = toUtc }, cancellationToken: ct));

        var start = anchors.T0 is { } t0 ? AsUtc(t0) : fromUtc;
        var floor = await connection.ExecuteScalarAsync<DateTime?>(new CommandDefinition(
            """
            select max(least(to_utc, @FromUtc))
            from dirty_range
            where attempts >= @SetAside and from_utc > @T0 and from_utc < @FromUtc
            """,
            new { FromUtc = fromUtc, T0 = start, SetAside = ProcessingQueue.SetAsideAfterAttempts }, cancellationToken: ct));
        if (floor is { } raised && AsUtc(raised) > start)
            start = AsUtc(raised);

        return (start, anchors.T1 is { } t1 ? AsUtc(t1) : null);
    }

    /// <summary>
    /// When the last stored segment ends, or null when nothing is stored. Segments do not overlap, so the one that starts
    /// last ends last.
    /// </summary>
    public async Task<DateTime?> FindLastEndAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var end = await connection.QuerySingleOrDefaultAsync<DateTime?>(new CommandDefinition(
            "select end_utc from segment order by start_utc desc limit 1", cancellationToken: ct));
        return end is { } value ? AsUtc(value) : null;
    }

    /// <summary>
    /// The segments that overlap the window from <paramref name="fromUtc"/> to <paramref name="toUtc"/> widened by
    /// <see cref="CoveringMargin"/> on both sides, in time order. A segment that only touches an edge is not in it. They come
    /// without their geometry, which is most of a segment and is of no use to a night: the times, zones, dates, place and
    /// centre are the stored ones.
    /// </summary>
    /// <remarks>
    /// Segments do not overlap (see <see cref="FindLastEndAsync"/>), so the only one that can overlap the window and start
    /// before it is the last one that starts at or before its edge: the lookup starts there, on <c>ix_segment_start</c>, and
    /// does not read the history behind it. A stay of three weeks that began long before the window is found that way.
    /// </remarks>
    public async Task<IReadOnlyList<StoredSegment>> FindCoveringAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<CoveringRow>(new CommandDefinition(
            """
            select kind as Kind, start_utc as StartUtc, end_utc as EndUtc, start_tz as StartTz, end_tz as EndTz,
                   to_char(local_start_date, 'YYYY-MM-DD') as LocalStartDate, to_char(local_end_date, 'YYYY-MM-DD') as LocalEndDate,
                   place_id as PlaceId, latitude as Latitude, longitude as Longitude, mode as Mode, distance_m as DistanceM,
                   point_count as PointCount
            from segment
            where start_utc < @To and end_utc > @From
              and start_utc >= coalesce((select max(start_utc) from segment where start_utc <= @From), @From)
            order by start_utc, id
            """,
            new { From = fromUtc - CoveringMargin, To = toUtc + CoveringMargin }, cancellationToken: ct));

        return rows.Select(r => new StoredSegment(
            r.Kind, AsUtc(r.StartUtc), AsUtc(r.EndUtc), r.StartTz, r.EndTz, ParseDate(r.LocalStartDate), ParseDate(r.LocalEndDate),
            r.PlaceId, r.Latitude, r.Longitude, r.Mode, r.DistanceM, GeometryDetailJson: null, GeometryCoarseJson: null, r.PointCount))
            .ToList();
    }

    /// <summary>
    /// Every stay that has a position, in time order: when it began and ended and where it was. Trip detection searches these
    /// for the stays near home on either side of a trip, so it needs all of them. Uses <c>ix_segment_stays</c>.
    /// </summary>
    public async Task<IReadOnlyList<StayPosition>> LoadStayPositionsAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<StayRow>(new CommandDefinition(
            """
            select start_utc as StartUtc, end_utc as EndUtc, latitude as Latitude, longitude as Longitude
            from segment
            where kind = 'stay' and latitude is not null and longitude is not null
            order by start_utc, id
            """,
            cancellationToken: ct));
        return rows.Select(r => new StayPosition(AsUtc(r.StartUtc), AsUtc(r.EndUtc), new GeoPoint(r.Latitude, r.Longitude))).ToList();
    }

    /// <summary>
    /// Replaces the segments that start at or after <paramref name="t0"/> and, unless <paramref name="t1"/> is null,
    /// before it, by <paramref name="segments"/>. One transaction: readers see the old rows or the new ones, and a
    /// failure leaves the old ones.
    /// </summary>
    public async Task ReplaceAsync(DateTime t0, DateTime? t1, IReadOnlyList<StoredSegment> segments, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        await connection.ExecuteAsync(t1 is { } upper
            ? new CommandDefinition("delete from segment where start_utc >= @T0 and start_utc < @T1",
                new { T0 = t0, T1 = upper }, transaction, cancellationToken: ct)
            : new CommandDefinition("delete from segment where start_utc >= @T0",
                new { T0 = t0 }, transaction, cancellationToken: ct));

        if (segments.Count > 0)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                """
                insert into segment (kind, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date, place_id,
                                     latitude, longitude, mode, distance_m, geometry_detail, geometry_coarse, point_count)
                values (@Kind, @StartUtc, @EndUtc, @StartTz, @EndTz, @LocalStartDate, @LocalEndDate, @PlaceId,
                        @Latitude, @Longitude, @Mode, @DistanceM, @GeometryDetailJson::jsonb, @GeometryCoarseJson::jsonb, @PointCount)
                """,
                segments, transaction, cancellationToken: ct));
        }

        await transaction.CommitAsync(ct);
    }

    /// <summary>The segments that touch the local day <c>@Date</c>, as <c>s</c>: those that start on or before it and end on or after it (uses <c>ix_segment_local_dates</c>).</summary>
    private const string DayFilter = "s.local_start_date <= @Date and s.local_end_date >= @Date";

    /// <summary>The order of a day's segments, which is what makes one of them its first.</summary>
    private const string DayOrder = "order by s.start_utc, s.id";

    /// <summary>
    /// The segments that touch the local calendar day <paramref name="date"/> (the one the segment's own zone says), in
    /// time order: those that start on or before it and end on or after it, so a stay that crosses midnight is on both
    /// days. Uses <c>ix_segment_local_dates</c>. A stay's place is resolved through <c>merged_into_id</c> to the place that
    /// survives (a merged place never shows its own identity); a chain is followed to its end, up to 32 links.
    /// </summary>
    public async Task<IReadOnlyList<DaySegment>> FindDayAsync(DateOnly date, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<DayRow>(new CommandDefinition(
            """
            select s.id as Id, s.kind as Kind, s.start_utc as StartUtc, s.end_utc as EndUtc, s.start_tz as StartTz, s.end_tz as EndTz,
                   s.mode as Mode, s.distance_m as DistanceM, s.geometry_detail::text as GeometryDetailJson,
                   p.id as PlaceId, coalesce(p.user_name, p.osm_name) as PlaceName, p.city as PlaceCity,
                   p.country as PlaceCountry, p.latitude as PlaceLatitude, p.longitude as PlaceLongitude
            from segment s
            left join lateral (
                with recursive chain as (
                    select id, merged_into_id, user_name, osm_name, city, country, latitude, longitude, 0 as depth
                    from place where id = s.place_id
                    union all
                    select next.id, next.merged_into_id, next.user_name, next.osm_name, next.city, next.country,
                           next.latitude, next.longitude, chain.depth + 1
                    from chain join place next on next.id = chain.merged_into_id
                    where chain.depth < 32
                )
                select * from chain where merged_into_id is null
            ) p on true
            where
            """ + " " + DayFilter + " " + DayOrder,
            new { Date = date }, cancellationToken: ct));

        return rows.Select(r => new DaySegment(
            r.Id, r.Kind, AsUtc(r.StartUtc), AsUtc(r.EndUtc), r.StartTz, r.EndTz, r.Mode, r.DistanceM, r.GeometryDetailJson,
            r.PlaceId is { } id && r.PlaceLatitude is { } lat && r.PlaceLongitude is { } lon
                ? new DayPlace(id, r.PlaceName, r.PlaceCity, r.PlaceCountry, lat, lon)
                : null)).ToList();
    }

    /// <summary>
    /// The zone the first segment of the local day <paramref name="date"/> starts in (the first as <see cref="FindDayAsync"/> orders them, and
    /// of the same segments), or null when the day has none. One row and one column: the day's segments carry their geometry, and the zone
    /// of the day (see <c>DayZone</c>) is all that some readers want of them.
    /// </summary>
    public async Task<string?> FindDayStartZoneAsync(DateOnly date, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "select s.start_tz from segment s where " + DayFilter + " " + DayOrder + " limit 1",
            new { Date = date }, cancellationToken: ct));
    }

    /// <summary>
    /// The time zone of the latest stay that ended before the local day <paramref name="date"/>, or null when there is
    /// none: where the person was when the day began, for a day without segments of its own.
    /// </summary>
    public async Task<string?> FindZoneBeforeAsync(DateOnly date, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        return await connection.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(
            "select end_tz from segment where kind = 'stay' and local_end_date < @Date order by start_utc desc limit 1",
            new { Date = date }, cancellationToken: ct));
    }

    private static DateTime AsUtc(DateTime value) => DateTime.SpecifyKind(value, DateTimeKind.Utc);

    private static DateOnly ParseDate(string text)
        => DateOnly.ParseExact(text, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);

    private sealed record AnchorRow(DateTime? T0, DateTime? T1);

    // Classes with setters rather than records: Dapper matches a record's constructor by exact column types.
    private sealed class CoveringRow
    {
        public string Kind { get; set; } = string.Empty;
        public DateTime StartUtc { get; set; }
        public DateTime EndUtc { get; set; }
        public string StartTz { get; set; } = string.Empty;
        public string EndTz { get; set; } = string.Empty;
        public string LocalStartDate { get; set; } = string.Empty;
        public string LocalEndDate { get; set; } = string.Empty;
        public long? PlaceId { get; set; }
        public double? Latitude { get; set; }
        public double? Longitude { get; set; }
        public string? Mode { get; set; }
        public double? DistanceM { get; set; }
        public int PointCount { get; set; }
    }

    private sealed class StayRow
    {
        public DateTime StartUtc { get; set; }
        public DateTime EndUtc { get; set; }
        public double Latitude { get; set; }
        public double Longitude { get; set; }
    }

    private sealed record DayRow(
        long Id, string Kind, DateTime StartUtc, DateTime EndUtc, string StartTz, string EndTz,
        string? Mode, double? DistanceM, string? GeometryDetailJson,
        long? PlaceId, string? PlaceName, string? PlaceCity, string? PlaceCountry, double? PlaceLatitude, double? PlaceLongitude);
}
