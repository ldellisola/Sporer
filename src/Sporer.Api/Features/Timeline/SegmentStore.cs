using Dapper;
using Npgsql;

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
    /// live ranges alike; when its range is retried and succeeds the row is deleted and the floor is gone. For each set-aside
    /// range that began before <paramref name="fromUtc"/> and ends after <c>T0</c>:
    /// </para>
    /// <list type="bullet">
    /// <item>It ends at or before <paramref name="fromUtc"/>: <c>T0</c> goes up to its end.</item>
    /// <item>
    /// It ends after <paramref name="fromUtc"/> (a set-aside chunk's range runs on over the chunk after it, so that the retry
    /// rebuilds the edge between them): <c>T0</c> goes up to <paramref name="fromUtc"/>, but only if the stay found lies before
    /// the range began, which means that nothing of it is stored. A stay inside it is the retry's own earlier piece (a
    /// retry rebuilds a long range one piece after another): the rebuild goes back to it.
    /// </item>
    /// </list>
    /// <para>A set-aside range that starts where the rebuild does, as its own retry does, never raises <c>T0</c>.</para>
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
            where attempts >= @SetAside and from_utc < @FromUtc and to_utc > @T0
              and (to_utc <= @FromUtc or from_utc > @T0)
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
            where s.local_start_date <= @Date and s.local_end_date >= @Date
            order by s.start_utc, s.id
            """,
            new { Date = date }, cancellationToken: ct));

        return rows.Select(r => new DaySegment(
            r.Id, r.Kind, AsUtc(r.StartUtc), AsUtc(r.EndUtc), r.StartTz, r.EndTz, r.Mode, r.DistanceM, r.GeometryDetailJson,
            r.PlaceId is { } id && r.PlaceLatitude is { } lat && r.PlaceLongitude is { } lon
                ? new DayPlace(id, r.PlaceName, r.PlaceCity, r.PlaceCountry, lat, lon)
                : null)).ToList();
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

    private sealed record AnchorRow(DateTime? T0, DateTime? T1);

    private sealed record DayRow(
        long Id, string Kind, DateTime StartUtc, DateTime EndUtc, string StartTz, string EndTz,
        string? Mode, double? DistanceM, string? GeometryDetailJson,
        long? PlaceId, string? PlaceName, string? PlaceCity, string? PlaceCountry, double? PlaceLatitude, double? PlaceLongitude);
}
