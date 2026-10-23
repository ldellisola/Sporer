using Dapper;
using Npgsql;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

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

    private sealed record PlaceRow(long Id, double Latitude, double Longitude);
}
