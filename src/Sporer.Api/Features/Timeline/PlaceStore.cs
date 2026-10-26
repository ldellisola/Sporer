using System.Data;
using Dapper;
using Npgsql;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

/// <summary>
/// How many places there are, over those in use (see <see cref="PlaceStore.InUse"/>): <paramref name="Unnamed"/> still wait
/// for a name (the geocoding state is <c>pending</c>), <paramref name="Failed"/> could not be named (the state is <c>failed</c>).
/// </summary>
public sealed record PlaceCounts(long Total, long Unnamed, long Failed);

/// <summary>
/// One stay at a place, as the place's detail lists it: all times UTC, <paramref name="Date"/> the local date the stay starts on
/// (<c>yyyy-MM-dd</c>) and <paramref name="TimeZone"/> the zone it starts in.
/// </summary>
public sealed record PlaceVisit(DateTime StartUtc, DateTime EndUtc, string Date, string TimeZone);

/// <summary>
/// A place in use and everything that was spent at it (see <see cref="PlaceStore.FindDetailAsync"/>). <paramref name="Id"/> is the
/// surviving place's, <paramref name="Name"/> the owner's name, else OpenStreetMap's, else null. <paramref name="TotalSeconds"/>
/// and <paramref name="Visits"/> are over all of its stays, <paramref name="FirstVisit"/> and <paramref name="LastVisit"/> the
/// starts of the earliest and the latest; <paramref name="RecentVisits"/> are the latest stays, newest first.
/// </summary>
public sealed record PlaceDetail(
    long Id, string? Name, string? Address, string? City, string? Country, double Latitude, double Longitude,
    long TotalSeconds, int Visits, DateTime FirstVisit, DateTime LastVisit, IReadOnlyList<PlaceVisit> RecentVisits);

/// <summary>
/// The places stays are matched to. A place keeps its id (and the name its owner gave it) however often the
/// timeline is reprocessed: processing only ever adds places.
/// </summary>
public sealed class PlaceStore(NpgsqlDataSource dataSource)
{
    /// <summary>
    /// The SQL condition, for <c>place</c> aliased <c>p</c>, for a place that is in use: not merged into another, and shown
    /// by at least one segment. A reprocessing that moves a stay leaves its old place behind with no segment; such an
    /// orphan is not on the timeline and is never named. What names places and what counts them both use this, so that
    /// they cannot disagree about which places there are. (The place view, <see cref="FindDetailAsync"/>, asks a little more
    /// of the places merged into another: it serves the survivor when any place merged into it has a segment, which is
    /// what the day and range views show, whether or not the survivor has one of its own.)
    /// </summary>
    internal const string InUse = "p.merged_into_id is null and exists (select 1 from segment s where s.place_id = p.id)";

    /// <summary>The most stays <see cref="FindDetailAsync"/> lists.</summary>
    public const int RecentVisitCount = 50;

    /// <summary>
    /// The SQL, to start a <c>with recursive</c> list that goes on with more tables, for the place <c>@Id</c> stands for and the
    /// places that are one with it. <c>resolved</c> follows <c>merged_into_id</c> from <c>@Id</c>, up to 32 links, as the day
    /// and range views do, and <c>root</c> is the place it ends at: a cycle, which the app does not write but the schema allows,
    /// has no end, so no root. <c>members</c> are the root and every place merged into it, however indirectly, within the same
    /// 32 links: a stay keeps the place id it was given, so the time spent at a place is that of the stays of all of them.
    /// (Followed from the root, which has no merge of its own, the list cannot run in a circle; the bound is for the sake of it.)
    /// <c>survivor</c> is the root when it is in use, which here is when a segment names it or any of its members: the day and
    /// range views show the root for such a stay, so it is a place of the timeline though it has no segment of its own.
    /// </summary>
    private const string SurvivorAndMembers =
        """
        with recursive
        resolved as (
            select id, merged_into_id, 0 as depth
            from place
            where id = @Id
            union all
            select next.id, next.merged_into_id, resolved.depth + 1
            from resolved join place next on next.id = resolved.merged_into_id
            where resolved.depth < 32
        ),
        root as (
            select id from resolved where merged_into_id is null
        ),
        members as (
            select id, 0 as depth from root
            union all
            select merged.id, members.depth + 1
            from members join place merged on merged.merged_into_id = members.id
            where members.depth < 32
        ),
        survivor as (
            select id
            from root
            where exists (select 1 from segment s where s.place_id in (select id from members))
        )
        """;

    /// <summary>Every place that has not been merged into another one, with its centre.</summary>
    public async Task<List<(long Id, GeoPoint Centre)>> LoadActiveAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<PlaceRow>(new CommandDefinition(
            "select id as Id, latitude as Latitude, longitude as Longitude from place where merged_into_id is null order by id",
            cancellationToken: ct));
        return rows.Select(r => (r.Id, new GeoPoint(r.Latitude, r.Longitude))).ToList();
    }

    /// <summary>Adds a place at <paramref name="centre"/>, still unnamed and waiting to be geocoded, and returns its id.</summary>
    public async Task<long> CreateAsync(GeoPoint centre, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        return await connection.ExecuteScalarAsync<long>(new CommandDefinition(
            "insert into place (latitude, longitude) values (@Latitude, @Longitude) returning id",
            new { centre.Latitude, centre.Longitude }, cancellationToken: ct));
    }

    /// <summary>The counts of the places in use (see <see cref="InUse"/>).</summary>
    public async Task<PlaceCounts> CountInUseAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var row = await connection.QuerySingleAsync<CountRow>(new CommandDefinition(
            $"""
            select count(*) as Total,
                   count(*) filter (where p.geocode_state = 'pending') as Unnamed,
                   count(*) filter (where p.geocode_state = 'failed') as Failed
            from place p
            where {InUse}
            """, cancellationToken: ct));
        return new PlaceCounts(row.Total, row.Unnamed, row.Failed);
    }

    /// <summary>
    /// The place <paramref name="id"/> stands for, with the time spent there, or null when there is no such place: the id is
    /// unknown, or it leads (through merges) to a place that no segment names, nor any place merged into it (so that it is not
    /// on the timeline), or to none at all (a merge cycle). A place merged into another stands for the one at the end of the
    /// merges, and is in use when that one or any place merged into it has a segment, as the day and range views show it: this
    /// is not <see cref="InUse"/>, which asks the place itself to have one.
    /// </summary>
    /// <remarks>
    /// The totals are over every stay of the place and of every place merged into it, all of the time there is and not a range of
    /// it: <c>TotalSeconds</c> is the stays' durations added up, <c>Visits</c> their number, <c>FirstVisit</c> and
    /// <c>LastVisit</c> when the earliest and the latest began (as the date of a visit is that of its start).
    /// <c>RecentVisits</c> are the latest <see cref="RecentVisitCount"/> stays by start, newest first. The totals and the list are
    /// read from one snapshot, so that a rewrite of the timeline that lands in the middle cannot leave them disagreeing.
    /// </remarks>
    public async Task<PlaceDetail?> FindDetailAsync(long id, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);

        // An aggregate with no group makes a row of its own when there are no stays, so a place with none has Visits 0 and null times.
        var place = await connection.QuerySingleOrDefaultAsync<DetailRow>(new CommandDefinition(
            SurvivorAndMembers +
            """
            select p.id as Id, coalesce(p.user_name, p.osm_name) as Name, p.address as Address, p.city as City, p.country as Country,
                   p.latitude as Latitude, p.longitude as Longitude,
                   totals.seconds as TotalSeconds, totals.visits as Visits, totals.first_visit as FirstVisit, totals.last_visit as LastVisit
            from place p
            cross join lateral (
                select coalesce(sum(extract(epoch from s.end_utc - s.start_utc)), 0)::double precision as seconds,
                       count(*) as visits, min(s.start_utc) as first_visit, max(s.start_utc) as last_visit
                from segment s
                where s.kind = 'stay' and s.place_id in (select id from members)
            ) totals
            where p.id = (select id from survivor)
            """,
            new { Id = id }, transaction, cancellationToken: ct));

        // A group whose segments are not stays (the app writes a place on stays only) has no visit to show: not a place of the timeline.
        if (place is not { FirstVisit: { } first, LastVisit: { } last })
        {
            await transaction.CommitAsync(ct);
            return null;
        }

        var visits = await connection.QueryAsync<VisitRow>(new CommandDefinition(
            SurvivorAndMembers +
            """
            select s.start_utc as StartUtc, s.end_utc as EndUtc, to_char(s.local_start_date, 'YYYY-MM-DD') as Date, s.start_tz as TimeZone
            from segment s
            where s.kind = 'stay' and s.place_id in (select id from members)
            order by s.start_utc desc, s.id desc
            limit @Limit
            """,
            new { Id = id, Limit = RecentVisitCount }, transaction, cancellationToken: ct));

        await transaction.CommitAsync(ct);

        return new PlaceDetail(
            place.Id, place.Name, place.Address, place.City, place.Country, place.Latitude, place.Longitude,
            (long)Math.Round(place.TotalSeconds), (int)place.Visits, AsUtc(first), AsUtc(last),
            [.. visits.Select(v => new PlaceVisit(AsUtc(v.StartUtc), AsUtc(v.EndUtc), v.Date, v.TimeZone))]);
    }

    private static DateTime AsUtc(DateTime value) => DateTime.SpecifyKind(value, DateTimeKind.Utc);

    private sealed record PlaceRow(long Id, double Latitude, double Longitude);

    private sealed record DetailRow(
        long Id, string? Name, string? Address, string? City, string? Country, double Latitude, double Longitude,
        double TotalSeconds, long Visits, DateTime? FirstVisit, DateTime? LastVisit);

    private sealed record VisitRow(DateTime StartUtc, DateTime EndUtc, string Date, string TimeZone);

    // A class with setters rather than a record: Dapper matches a record's constructor by exact column types.
    private sealed class CountRow
    {
        public long Total { get; set; }
        public long Unnamed { get; set; }
        public long Failed { get; set; }
    }
}
