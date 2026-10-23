using Dapper;
using Npgsql;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

/// <summary>
/// How many places there are, over the active ones (not merged into another): <paramref name="Unnamed"/> still wait for a
/// name (the geocoding state is <c>pending</c>), <paramref name="Failed"/> could not be named (the state is <c>failed</c>).
/// </summary>
public sealed record PlaceCounts(long Total, long Unnamed, long Failed);

/// <summary>
/// The places stays are matched to. A place keeps its id (and the name its owner gave it) however often the
/// timeline is reprocessed: processing only ever adds places.
/// </summary>
public sealed class PlaceStore(NpgsqlDataSource dataSource)
{
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

    /// <summary>The counts of the places that have not been merged into another one.</summary>
    public async Task<PlaceCounts> CountActiveAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var row = await connection.QuerySingleAsync<CountRow>(new CommandDefinition(
            """
            select count(*) as Total,
                   count(*) filter (where geocode_state = 'pending') as Unnamed,
                   count(*) filter (where geocode_state = 'failed') as Failed
            from place
            where merged_into_id is null
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
