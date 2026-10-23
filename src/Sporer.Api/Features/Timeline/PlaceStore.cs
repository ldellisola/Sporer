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
/// The places stays are matched to. A place keeps its id (and the name its owner gave it) however often the
/// timeline is reprocessed: processing only ever adds places.
/// </summary>
public sealed class PlaceStore(NpgsqlDataSource dataSource)
{
    /// <summary>
    /// The SQL condition, for <c>place</c> aliased <c>p</c>, for a place that is in use: not merged into another, and shown
    /// by at least one segment. A reprocessing that moves a stay leaves its old place behind with no segment; such an
    /// orphan is not on the timeline and is never named. What names places and what counts them both use this, so that
    /// they cannot disagree about which places there are.
    /// </summary>
    internal const string InUse = "p.merged_into_id is null and exists (select 1 from segment s where s.place_id = p.id)";

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

    private sealed record PlaceRow(long Id, double Latitude, double Longitude);

    // A class with setters rather than a record: Dapper matches a record's constructor by exact column types.
    private sealed class CountRow
    {
        public long Total { get; set; }
        public long Unnamed { get; set; }
        public long Failed { get; set; }
    }
}
