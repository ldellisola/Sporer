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

/// <summary>A place that was merged directly into another one: its id, and its name (the owner's, else OpenStreetMap's, else null).</summary>
public sealed record MergedPlace(long Id, string? Name);

/// <summary>
/// A place in use and everything that was spent at it (see <see cref="PlaceStore.FindDetailAsync"/>). <paramref name="Id"/> is the
/// surviving place's, <paramref name="Name"/> the owner's name, else OpenStreetMap's, else null. <paramref name="TotalSeconds"/>
/// and <paramref name="Visits"/> are over all of its stays, <paramref name="FirstVisit"/> and <paramref name="LastVisit"/> the
/// starts of the earliest and the latest; <paramref name="RecentVisits"/> are the latest stays, newest first, and
/// <paramref name="Merged"/> the places merged directly into it, by name (ignoring case; those with none last), then by id.
/// </summary>
public sealed record PlaceDetail(
    long Id, string? Name, string? Address, string? City, string? Country, double Latitude, double Longitude,
    long TotalSeconds, int Visits, DateTime FirstVisit, DateTime LastVisit, IReadOnlyList<PlaceVisit> RecentVisits,
    IReadOnlyList<MergedPlace> Merged);

/// <summary>
/// A place a place can be merged with (see <see cref="PlaceStore.FindCandidatesAsync"/>): <paramref name="DistanceM"/> is how far its
/// centre is from the other's, <paramref name="Visits"/> how many stays there were at it and the places merged into it.
/// </summary>
public sealed record PlaceCandidate(long Id, string? Name, string? Address, double DistanceM, int Visits);

/// <summary>How a merge ended (see <see cref="PlaceStore.MergeAsync"/>).</summary>
public enum MergeOutcome
{
    /// <summary>The place was merged: <see cref="MergeResult.SurvivorId"/> is the place it was merged into.</summary>
    Merged,

    /// <summary>One of the two is no place of the timeline.</summary>
    NotFound,

    /// <summary>Both are the same place once their merges are followed.</summary>
    Conflict,
}

/// <summary>What <see cref="PlaceStore.MergeAsync"/> did; <paramref name="SurvivorId"/> is the place that survives, when it merged.</summary>
public readonly record struct MergeResult(MergeOutcome Outcome, long SurvivorId = 0);

/// <summary>
/// The places stays are matched to. A place keeps its id (and the name its owner gave it) however often the
/// timeline is reprocessed: processing only ever adds places.
/// </summary>
public sealed class PlaceStore(NpgsqlDataSource dataSource)
{
    /// <summary>
    /// The SQL condition, for <c>place</c> aliased <c>p</c>, for a place that is in use: not merged into another, and shown by
    /// at least one segment, its own or that of a place merged into it, however indirectly (a stay keeps the place it was given,
    /// and the views show it at the place that survives). A reprocessing that moves a stay leaves its old place behind with no
    /// segment; such an orphan is not on the timeline and is never named, while a survivor that has lost its own segments but has
    /// a merged place that still has one is. What names places and what counts them both use this, so that they cannot disagree
    /// about which places there are. (The place view, <see cref="FindDetailAsync"/>, asks the same of the group, and that a stay
    /// shows it.)
    /// </summary>
    /// <remarks>
    /// The places that have a segment are followed up the merges, to every place they reach, up to 32 links as the views do, once
    /// for the whole query; a survivor is in use when it is among them. (Looking down from each survivor instead would read the
    /// segments once for every place.)
    /// </remarks>
    internal const string InUse =
        """
        p.merged_into_id is null and p.id in (
            with recursive up as (
                select s.place_id as id, 0 as depth
                from segment s
                where s.place_id is not null
                group by s.place_id
                union all
                select link.merged_into_id, up.depth + 1
                from up join place link on link.id = up.id
                where link.merged_into_id is not null and up.depth < 32
            )
            select id from up)
        """;

    /// <summary>
    /// The SQL for the place each of some places stands for, to follow <c>with recursive</c> and a list of CTEs that includes
    /// <c>named</c> (its <c>place_id</c> column holds the places a query needs) and to be followed by more of them.
    /// <c>survivor</c> maps each of those places (<c>origin</c>) to the place it stands for (<c>id</c>): a place merged into
    /// another is followed through <c>merged_into_id</c>, up to 32 links, as the day view does, to the one that is not merged
    /// into any. A chain that never ends (a cycle, which the app does not write but the schema allows) has no survivor, so an
    /// inner join on <c>survivor</c> drops the places on it and a left join finds nothing for them. The range and trip views
    /// share this, so that they cannot disagree with each other about which place a stay is at.
    /// </summary>
    internal const string Survivors =
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

    /// <summary>
    /// Every place, the merged ones too, with its centre and the place it stands for (its own id when it was not merged), which is
    /// what a stay near its centre is matched to (see <see cref="PlaceMatcher"/>). The merges are followed as the views do, up to 32
    /// links; a place whose merges lead nowhere (a cycle, which the app does not write but the schema allows) stands for none, and is
    /// left out.
    /// </summary>
    public async Task<List<(long Id, GeoPoint Centre, long SurvivorId)>> LoadMatchableAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<MatchableRow>(new CommandDefinition(
            $"""
            with recursive
            named as (
                select id as place_id from place
            ),
            {Survivors}
            select p.id as Id, p.latitude as Latitude, p.longitude as Longitude, survivor.id as SurvivorId
            from place p join survivor on survivor.origin = p.id
            order by p.id
            """,
            cancellationToken: ct));
        return rows.Select(r => (r.Id, new GeoPoint(r.Latitude, r.Longitude), r.SurvivorId)).ToList();
    }

    /// <summary>
    /// For each place that was merged into another, the place it ends up at: the merges are followed from it to the one that
    /// was not merged itself, up to 32 links, as the day and range views do. A stay keeps the place id it was given, so this is
    /// how the id of a stay's place is turned into the id of the place that stands for it. A place that was not merged is not
    /// in the result (it is its own survivor), and neither is one whose merges lead nowhere: a cycle, which the app does not
    /// write but the schema allows, or a chain of more than 32 links.
    /// </summary>
    public async Task<IReadOnlyDictionary<long, long>> LoadSurvivorsAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<SurvivorRow>(new CommandDefinition(
            """
            with recursive chain as (
                select id as merged, merged_into_id as reached, 1 as depth
                from place
                where merged_into_id is not null
                union all
                select chain.merged, step.merged_into_id, chain.depth + 1
                from chain join place step on step.id = chain.reached
                where step.merged_into_id is not null and chain.depth < 32
            )
            select chain.merged as Merged, chain.reached as Survivor
            from chain join place ending on ending.id = chain.reached
            where ending.merged_into_id is null
            """,
            cancellationToken: ct));
        return rows.ToDictionary(r => r.Merged, r => r.Survivor);
    }

    /// <summary>The centre of each of the places <paramref name="ids"/> that exists, merged ones included.</summary>
    public async Task<IReadOnlyDictionary<long, GeoPoint>> LoadPositionsAsync(IEnumerable<long> ids, CancellationToken ct = default)
    {
        var wanted = ids.Distinct().ToArray();
        if (wanted.Length == 0) return new Dictionary<long, GeoPoint>();

        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<PlaceRow>(new CommandDefinition(
            "select id as Id, latitude as Latitude, longitude as Longitude from place where id = any(@Ids)",
            new { Ids = wanted }, cancellationToken: ct));
        return rows.ToDictionary(r => r.Id, r => new GeoPoint(r.Latitude, r.Longitude));
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
    /// <c>RecentVisits</c> are the latest <see cref="RecentVisitCount"/> stays by start, newest first, and <c>Merged</c> the places
    /// merged directly into the place (all of them, whether or not a segment still shows them), ordered by the name that shows,
    /// whatever the case, then by id; a place with no name comes last. The totals and the lists are
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

        var merged = await connection.QueryAsync<MergedRow>(new CommandDefinition(
            """
            select id as Id, coalesce(user_name, osm_name) as Name
            from place
            where merged_into_id = @Id
            order by lower(coalesce(user_name, osm_name)), id
            """,
            new { place.Id }, transaction, cancellationToken: ct));

        await transaction.CommitAsync(ct);

        return new PlaceDetail(
            place.Id, place.Name, place.Address, place.City, place.Country, place.Latitude, place.Longitude,
            (long)Math.Round(place.TotalSeconds), (int)place.Visits, AsUtc(first), AsUtc(last),
            [.. visits.Select(v => new PlaceVisit(AsUtc(v.StartUtc), AsUtc(v.EndUtc), v.Date, v.TimeZone))],
            [.. merged.Select(m => new MergedPlace(m.Id, m.Name))]);
    }

    /// <summary>
    /// How often <see cref="RenameAsync"/> asks again: it is more than once only when a merge lands while it runs, and one such merge
    /// does not come twice.
    /// </summary>
    private const int RenameAttempts = 3;

    /// <summary>
    /// Names the place <paramref name="id"/> stands for (see <see cref="FindDetailAsync"/>) <paramref name="name"/>, which is the owner's
    /// and is shown in place of OpenStreetMap's wherever the place is; null takes it back, and OpenStreetMap's shows again. The name is
    /// set on the one place that survives merges, and nothing else is touched: the views read it from there, so there is nothing to
    /// rebuild, and processing never writes it. Returns the place as it is now, or null, with nothing changed, when there is no such place
    /// (the same ones <see cref="FindDetailAsync"/> finds none for).
    /// </summary>
    /// <remarks>
    /// <para>
    /// It writes first and reads after: the name is set in one statement and the detail is read back in another, so a rebuild that removes
    /// the group's segments between the two leaves the name written and gives null (a 404) for a place that was found a moment before.
    /// </para>
    /// <para>
    /// The survivor is found and named in one statement, so that a merge cannot land between the two. One that is not yet committed when
    /// the statement finds its survivor but is when it gets to name it has made the place no survivor: the update only names a place
    /// that is not merged into another (checked on the row as it is then), so it names none, and the next attempt finds the place
    /// the merge led to. The name is read back with the detail, so that it is what the views show.
    /// </para>
    /// </remarks>
    public async Task<PlaceDetail?> RenameAsync(long id, string? name, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);

        for (var attempt = 0; attempt < RenameAttempts; attempt++)
        {
            var named = await connection.ExecuteScalarAsync<long?>(new CommandDefinition(
                SurvivorAndMembers +
                """
                update place set user_name = @Name
                where id = (select id from survivor) and merged_into_id is null
                returning id
                """,
                new { Id = id, Name = name }, cancellationToken: ct));

            if (named is { } survivor)
                return await FindDetailAsync(survivor, ct);
        }

        return null; // no such place; or, which is not to be expected, one that was merged on and on while this tried
    }

    /// <summary>
    /// The place <paramref name="id"/> stands for and its centre, when it is on the timeline: what <see cref="FindDetailAsync"/> serves,
    /// which is a place that a stay shows, or a stay of a place merged into it. Null for an unknown place, one no stay shows, and one
    /// whose merges never end.
    /// </summary>
    private static async Task<PlaceRow?> FindOnTimelineAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, long id, CancellationToken ct)
        => await connection.QuerySingleOrDefaultAsync<PlaceRow>(new CommandDefinition(
            SurvivorAndMembers +
            """
            select p.id as Id, p.latitude as Latitude, p.longitude as Longitude
            from place p
            where p.id = (select id from survivor)
              and exists (select 1 from segment s where s.kind = 'stay' and s.place_id in (select id from members))
            """,
            new { Id = id }, transaction, cancellationToken: ct));

    /// <summary>
    /// How often <see cref="MergeAsync"/> resolves the two places again: it is more than once only when a merge lands while it runs
    /// (one that makes one of them a place that is merged), and one such merge does not come twice.
    /// </summary>
    private const int MergeAttempts = 5;

    /// <summary>
    /// Merges the place <paramref name="other"/> stands for into the place <paramref name="id"/> stands for (see
    /// <see cref="FindDetailAsync"/>): the one is set to be merged into the other, and nothing else of it is touched. A stay keeps the
    /// place it was given, and what is read follows the merges. A <paramref name="name"/> that is not null becomes the survivor's
    /// name, as <see cref="RenameAsync"/> takes one, with the merge or not at all (an empty one takes it back); null leaves the
    /// survivor's name as it is. The result is <see cref="MergeOutcome.NotFound"/>, with nothing changed, when either is no place of
    /// the timeline, and <see cref="MergeOutcome.Conflict"/> when both are the same place.
    /// </summary>
    /// <remarks>
    /// Both are places that no merge has moved on, and the merge is written under a lock on both rows, taken in the order of their ids,
    /// and checked again once held (<c>merged_into_id is null</c>, on the rows as they are then). Two merges in opposite directions
    /// (A into B, and B into A) each find two places that are their own survivors, ask for the same two rows in the same order, and
    /// the second waits for the first. When the first commits, the row it merged is no longer one that has not been merged, so
    /// the second does not get its two: it resolves the places again, finds one survivor on both sides and is a conflict. Without
    /// this it would make a cycle, which no view could read.
    /// </remarks>
    public async Task<MergeResult> MergeAsync(long id, long other, string? name, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        for (var attempt = 0; attempt < MergeAttempts; attempt++)
        {
            var survivor = await FindOnTimelineAsync(connection, transaction, id, ct);
            var absorbed = await FindOnTimelineAsync(connection, transaction, other, ct);
            if (survivor is null || absorbed is null)
                return new MergeResult(MergeOutcome.NotFound);
            if (survivor.Id == absorbed.Id)
                return new MergeResult(MergeOutcome.Conflict);

            // Both rows, the lower id first, and only if neither has been merged on since they were found.
            var locked = await connection.QueryAsync<long>(new CommandDefinition(
                "select id from place where id = any(@Ids) and merged_into_id is null order by id for update",
                new { Ids = new[] { survivor.Id, absorbed.Id } }, transaction, cancellationToken: ct));
            if (locked.Count() != 2)
                continue;

            await connection.ExecuteAsync(new CommandDefinition(
                "update place set merged_into_id = @Survivor where id = @Absorbed",
                new { Survivor = survivor.Id, Absorbed = absorbed.Id }, transaction, cancellationToken: ct));
            if (name is not null)
            {
                await connection.ExecuteAsync(new CommandDefinition(
                    "update place set user_name = nullif(@Name, '') where id = @Survivor",
                    new { Name = name, Survivor = survivor.Id }, transaction, cancellationToken: ct));
            }

            await transaction.CommitAsync(ct);
            return new MergeResult(MergeOutcome.Merged, survivor.Id);
        }

        return new MergeResult(MergeOutcome.Conflict); // not to be expected: the places were merged on and on while this tried
    }

    /// <summary>
    /// Separates <paramref name="other"/> from <paramref name="id"/>: when <paramref name="other"/> was merged directly into
    /// <paramref name="id"/>, it is no longer merged into any place, and what was merged into it stays with it. Returns whether it was
    /// (false for a place that is not merged into <paramref name="id"/>, whether it exists or not, and for one merged into it only
    /// through another). The place is the one that was named, not the one it stands for. One statement, so that two separations of
    /// the same place cannot both succeed.
    /// </summary>
    public async Task<bool> SeparateAsync(long id, long other, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var changed = await connection.ExecuteAsync(new CommandDefinition(
            "update place set merged_into_id = null where id = @Other and merged_into_id = @Id",
            new { Id = id, Other = other }, cancellationToken: ct));
        return changed > 0;
    }

    /// <summary>The most places <see cref="FindCandidatesAsync"/> lists.</summary>
    public const int CandidateLimit = 20;

    /// <summary>
    /// The places that <paramref name="id"/> can be merged with, the nearest first: the places that are on the timeline (see
    /// <see cref="FindDetailAsync"/>) and survive merges, other than the one <paramref name="id"/> stands for (so nothing that is merged
    /// into that one is in it either), at most <see cref="CandidateLimit"/>. With a <paramref name="query"/>, only those whose name, as
    /// the views show it (the owner's, else OpenStreetMap's), or whose address contains it, whatever the case. The query is trimmed, and
    /// is text, not a pattern. Null when <paramref name="id"/> is no place of the timeline.
    /// </summary>
    /// <remarks>
    /// The distance is that between the two centres, worked out as <see cref="Geo.DistanceMeters"/> does, and the visits are the stays
    /// at the place and at the places merged into it (as <see cref="PlaceDetail.Visits"/>). The places are read in one snapshot.
    /// A few thousand places are read and sorted here: the sort is by a distance the database does not know.
    /// </remarks>
    public async Task<IReadOnlyList<PlaceCandidate>?> FindCandidatesAsync(long id, string? query, CancellationToken ct = default)
    {
        var needle = string.IsNullOrWhiteSpace(query) ? null : query.Trim();

        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);

        var self = await FindOnTimelineAsync(connection, transaction, id, ct);
        if (self is null)
        {
            await transaction.CommitAsync(ct);
            return null;
        }

        var rows = await connection.QueryAsync<CandidateRow>(new CommandDefinition(
            $"""
            with recursive
            stays as (
                select place_id, count(*) as visits
                from segment
                where kind = 'stay' and place_id is not null
                group by place_id
            ),
            named as (
                select place_id from stays
            ),
            {Survivors}
            select p.id as Id, coalesce(p.user_name, p.osm_name) as Name, p.address as Address,
                   p.latitude as Latitude, p.longitude as Longitude, sum(stays.visits)::bigint as Visits
            from stays
            join survivor on survivor.origin = stays.place_id
            join place p on p.id = survivor.id
            where p.id <> @Self
              and (@Query::text is null
                   or strpos(lower(coalesce(p.user_name, p.osm_name, '')), lower(@Query::text)) > 0
                   or strpos(lower(coalesce(p.address, '')), lower(@Query::text)) > 0)
            group by p.id
            """,
            new { Self = self.Id, Query = needle }, transaction, cancellationToken: ct));

        await transaction.CommitAsync(ct);

        var from = new GeoPoint(self.Latitude, self.Longitude);
        return
        [
            .. rows
                .Select(r => new PlaceCandidate(r.Id, r.Name, r.Address, Geo.DistanceMeters(from, new GeoPoint(r.Latitude, r.Longitude)), (int)r.Visits))
                .OrderBy(c => c.DistanceM)
                .ThenBy(c => c.Id)
                .Take(CandidateLimit),
        ];
    }

    private static DateTime AsUtc(DateTime value) => DateTime.SpecifyKind(value, DateTimeKind.Utc);

    private sealed record PlaceRow(long Id, double Latitude, double Longitude);

    private sealed record SurvivorRow(long Merged, long Survivor);

    private sealed record MatchableRow(long Id, double Latitude, double Longitude, long SurvivorId);

    private sealed record MergedRow(long Id, string? Name);

    private sealed record CandidateRow(long Id, string? Name, string? Address, double Latitude, double Longitude, long Visits);

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
