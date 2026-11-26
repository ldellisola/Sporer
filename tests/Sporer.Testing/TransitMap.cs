using System.Diagnostics.CodeAnalysis;
using Sporer.Timeline;

namespace Sporer.Testing;

/// <summary>
/// A made-up cache of railway and bus-route tiles for tests, holding the lines a test draws. Each line is filed in every tile it
/// passes through, cut where it leaves one, as Overpass sends a tile. Unless told otherwise every tile of both kinds is cached,
/// and a tile no line passes through is cached and empty; <see cref="NotCached(TransitKind)"/> and
/// <see cref="NotCached(TransitTile)"/> take tiles out. It records the tiles it was asked for. Not real railways.
/// </summary>
public sealed class TransitMap : ITransitLineSource
{
    private readonly Dictionary<TransitTile, List<IReadOnlyList<GeoPoint>>> _lines = [];
    private readonly Dictionary<TransitTile, TransitLines> _built = [];
    private readonly HashSet<TransitKind> _uncachedKinds = [];
    private readonly HashSet<TransitTile> _uncached = [];
    private readonly List<TransitTile> _asked = [];

    /// <summary>The tiles asked for so far, in the order they were asked (a tile asked twice is listed twice).</summary>
    public IReadOnlyList<TransitTile> Asked => _asked;

    /// <summary>Draws a railway through <paramref name="line"/>.</summary>
    public TransitMap Rail(IReadOnlyList<GeoPoint> line) => Add(TransitKind.Rail, line);

    /// <summary>Draws a bus route through <paramref name="line"/>.</summary>
    public TransitMap Bus(IReadOnlyList<GeoPoint> line) => Add(TransitKind.Bus, line);

    /// <summary>Draws a line of <paramref name="kind"/>, filed in each tile it passes through (each straight step in every tile its box touches).</summary>
    public TransitMap Add(TransitKind kind, IReadOnlyList<GeoPoint> line)
    {
        ArgumentNullException.ThrowIfNull(line);
        if (line.Count == 1)
            Lines(TransitTile.At(kind, line[0])).Add([line[0]]);

        var open = new SortedDictionary<TransitTile, List<GeoPoint>>();
        for (var k = 1; k < line.Count; k++)
        {
            var (a, b) = (line[k - 1], line[k]);
            var touched = new HashSet<TransitTile>();
            for (var lat = TileIndex(Math.Min(a.Latitude, b.Latitude)); lat <= TileIndex(Math.Max(a.Latitude, b.Latitude)); lat++)
            {
                for (var lon = TileIndex(Math.Min(a.Longitude, b.Longitude)); lon <= TileIndex(Math.Max(a.Longitude, b.Longitude)); lon++)
                    touched.Add(new TransitTile(kind, lat, lon));
            }

            foreach (var tile in open.Keys.Where(t => !touched.Contains(t)).ToList())
            {
                Lines(tile).Add(open[tile]);
                open.Remove(tile);
            }
            foreach (var tile in touched)
            {
                if (open.TryGetValue(tile, out var running))
                    running.Add(b);
                else
                    open[tile] = [a, b];
            }
        }
        foreach (var (tile, running) in open)
            Lines(tile).Add(running);
        return this;
    }

    /// <summary>No tile of <paramref name="kind"/> is cached.</summary>
    public TransitMap NotCached(TransitKind kind)
    {
        _uncachedKinds.Add(kind);
        return this;
    }

    /// <summary><paramref name="tile"/> is not cached.</summary>
    public TransitMap NotCached(TransitTile tile)
    {
        _uncached.Add(tile);
        return this;
    }

    /// <summary>The tiles that hold a line of <paramref name="kind"/>, with their lines.</summary>
    public IReadOnlyList<KeyValuePair<TransitTile, TransitLines>> Tiles(TransitKind kind)
        => [.. _lines.Keys.Where(t => t.Kind == kind).Order().Select(t => new KeyValuePair<TransitTile, TransitLines>(t, Built(t)))];

    public bool TryGetLines(TransitTile tile, [NotNullWhen(true)] out TransitLines? lines)
    {
        _asked.Add(tile);
        if (_uncachedKinds.Contains(tile.Kind) || _uncached.Contains(tile))
        {
            lines = null;
            return false;
        }
        lines = Built(tile);
        return true;
    }

    /// <summary>
    /// Points every <paramref name="stepMeters"/> (or closer, to end on <paramref name="to"/>) along the great circle from
    /// <paramref name="from"/> to <paramref name="to"/>, which is the way <see cref="TrackBuilder.Travel"/> goes, each moved
    /// <paramref name="northMeters"/> north and <paramref name="eastMeters"/> east: a line beside a track.
    /// </summary>
    public static GeoPoint[] Along(GeoPoint from, GeoPoint to, double northMeters = 0, double eastMeters = 0, double stepMeters = 100)
    {
        var steps = Math.Max(1, (int)Math.Ceiling(Geo.DistanceMeters(from, to) / stepMeters));
        return [.. Enumerable.Range(0, steps + 1).Select(k => Geo.Offset(Geo.Interpolate(from, to, k / (double)steps), northMeters, eastMeters))];
    }

    private List<IReadOnlyList<GeoPoint>> Lines(TransitTile tile)
    {
        _built.Remove(tile);
        if (!_lines.TryGetValue(tile, out var lines))
            _lines[tile] = lines = [];
        return lines;
    }

    private TransitLines Built(TransitTile tile)
    {
        if (!_built.TryGetValue(tile, out var built))
            _built[tile] = built = _lines.TryGetValue(tile, out var lines) ? new TransitLines(lines) : TransitLines.Empty;
        return built;
    }

    private static int TileIndex(double degrees) => (int)Math.Floor(degrees * TransitTile.PerDegree);
}
