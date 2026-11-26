using Sporer.Api.Features.Transit;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// Writes railway and bus-route tiles straight into <c>transit_tile</c>, as if the fetcher had brought them from Overpass, so that a test
/// can process a track against lines it drew (with a <see cref="TransitMap"/>) without any request. Every call is cancelled with the running
/// test.
/// </summary>
public static class TransitSeeder
{
    private static readonly DateTime FetchedAt = new(2026, 11, 1, 0, 0, 0, DateTimeKind.Utc);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>
    /// Stores as fetched every tile of <paramref name="kind"/> that the box from <paramref name="a"/> to <paramref name="b"/> (in either
    /// order) touches, widened by <paramref name="marginTiles"/> tiles on each side, each with the lines <paramref name="map"/> has in it
    /// (none, where it has none). A tile stored already is replaced.
    /// </summary>
    public static async Task SeedAsync(string cs, TransitMap map, TransitKind kind, GeoPoint a, GeoPoint b, int marginTiles = 1)
    {
        var tiles = new List<TransitTile>();
        for (var lat = Index(Math.Min(a.Latitude, b.Latitude)) - marginTiles; lat <= Index(Math.Max(a.Latitude, b.Latitude)) + marginTiles; lat++)
        {
            for (var lon = Index(Math.Min(a.Longitude, b.Longitude)) - marginTiles; lon <= Index(Math.Max(a.Longitude, b.Longitude)) + marginTiles; lon++)
                tiles.Add(new TransitTile(kind, lat, lon));
        }

        foreach (var tile in tiles)
        {
            var lines = map.TryGetLines(tile, out var held) ? held.Lines : [];
            await StoreAsync(cs, tile, lines);
        }
    }

    /// <summary>Stores <paramref name="tile"/> as fetched, with <paramref name="lines"/>.</summary>
    public static Task StoreAsync(string cs, TransitTile tile, IEnumerable<IReadOnlyList<GeoPoint>> lines, DateTime? fetchedAt = null)
    {
        var blob = TransitLineBlob.Encode(lines);
        return Sql.ExecAsync(cs,
            """
            insert into transit_tile (kind, lat_index, lon_index, state, lines, line_count, fetched_at)
            values (@kind, @lat, @lon, 'done', @blob, @count, @fetchedAt)
            on conflict (kind, lat_index, lon_index) do update set
                state = 'done', lines = excluded.lines, line_count = excluded.line_count, fetched_at = excluded.fetched_at,
                attempts = 0, next_attempt_at = null, last_error = null, waiting_from = null, waiting_to = null
            """,
            new
            {
                kind = TransitTileStore.KindName(tile.Kind), lat = tile.LatIndex, lon = tile.LonIndex, blob,
                count = TransitLineBlob.CountLines(blob), fetchedAt = fetchedAt ?? FetchedAt,
            }, Ct);
    }

    /// <summary>A tile waiting to be fetched, for the stretch given, with the attempts and next attempt given.</summary>
    public static Task WaitingAsync(
        string cs, TransitTile tile, DateTime? from = null, DateTime? to = null, int attempts = 0, DateTime? nextAttemptAt = null,
        string state = "pending") => Sql.ExecAsync(cs,
        """
        insert into transit_tile (kind, lat_index, lon_index, state, attempts, next_attempt_at, waiting_from, waiting_to)
        values (@kind, @lat, @lon, @state, @attempts, @nextAttemptAt, @from, @to)
        """,
        new { kind = TransitTileStore.KindName(tile.Kind), lat = tile.LatIndex, lon = tile.LonIndex, state, attempts, nextAttemptAt, from, to }, Ct);

    /// <summary>One row of <c>transit_tile</c>, without its lines.</summary>
    public sealed record TileRow(
        string Kind, int LatIndex, int LonIndex, string State, int LineCount, int Attempts, DateTime? NextAttemptAt, string? LastError,
        DateTime? FetchedAt, DateTime? WaitingFrom, DateTime? WaitingTo);

    public static Task<IReadOnlyList<TileRow>> TilesAsync(string cs) => Sql.QueryAsync<TileRow>(cs,
        """
        select kind as Kind, lat_index as LatIndex, lon_index as LonIndex, state as State, line_count as LineCount, attempts as Attempts,
               next_attempt_at as NextAttemptAt, last_error as LastError, fetched_at as FetchedAt, waiting_from as WaitingFrom,
               waiting_to as WaitingTo
        from transit_tile order by kind desc, lat_index, lon_index
        """, ct: Ct);

    /// <summary>The stored lines of a tile, read back as the processor reads them; null when the tile has no row.</summary>
    public static async Task<IReadOnlyList<IReadOnlyList<GeoPoint>>?> LinesAsync(string cs, TransitTile tile)
    {
        var blob = await Sql.ScalarAsync<byte[]?>(cs,
            "select lines from transit_tile where kind = @kind and lat_index = @lat and lon_index = @lon",
            new { kind = TransitTileStore.KindName(tile.Kind), lat = tile.LatIndex, lon = tile.LonIndex }, Ct);
        return blob is null ? null : TransitLineBlob.Decode(blob);
    }

    private static int Index(double degrees) => (int)Math.Floor(degrees * TransitTile.PerDegree);
}
