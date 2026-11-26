using System.Diagnostics.CodeAnalysis;

namespace Sporer.Timeline;

/// <summary>
/// The lines of one tile of one kind (railways or bus routes), each a polyline of positions, as they are cached. A tile that
/// was fetched and holds no line is <see cref="Empty"/>: cached, with nothing near.
/// <para>
/// The lines are kept in a grid so that the distance from a position to the nearest of them can be found by looking at a few
/// cells. Each straight piece between two vertices is cut into pieces no longer than a cell, and each piece is filed in the
/// cells its bounding box covers (at most four), so a long straight line costs no more than a curvy one. Distances are measured
/// on a local flat-earth projection around the position asked about (equirectangular metres), which is exact to centimetres at
/// the few hundred metres the rules look at. Built once, it is read-only and safe to share between threads.
/// </para>
/// <para>
/// Positions are kept as given (a vertex outside the tile, as Overpass sends the first one past its edge, is kept). A vertex that
/// is not a position on the globe is left out, and splits its line there. Longitudes are wrapped into [-180, 180): a line that
/// crosses the antimeridian is not found from the other side of it, which is wrong but harmless there.
/// </para>
/// </summary>
public sealed class TransitLines
{
    /// <summary>The side of a grid cell, and the longest piece a line is cut into, in metres.</summary>
    private const double CellMeters = 50;

    private const double MetersPerDegree = Geo.EarthRadiusMeters * Math.PI / 180;

    /// <summary>
    /// Relative slack on the search reach, so that rounding at the edge of a cell can never make the grid skip a piece that the
    /// distance check would accept. It only widens the candidate set, by micrometres.
    /// </summary>
    private const double SearchSlack = 1e-6;

    private readonly double _cellLat; // degrees
    private readonly double _cellLon; // degrees
    private readonly double[] _pieces; // 4 per piece: lat1, lon1, lat2, lon2
    private readonly Dictionary<long, int[]> _cells;

    /// <summary>A tile that is cached and has no lines.</summary>
    public static TransitLines Empty { get; } = new([]);

    /// <param name="lines">The tile's lines, each a polyline in order. A line of one point is a point; a line of none is ignored.</param>
    public TransitLines(IEnumerable<IReadOnlyList<GeoPoint>> lines)
    {
        ArgumentNullException.ThrowIfNull(lines);

        Lines = [.. lines.Select(line => (IReadOnlyList<GeoPoint>)[.. line ?? throw new ArgumentException("A line is null.", nameof(lines))])];

        // The longitude width of a cell follows the latitude of the first vertex, so cells are about square in metres; the tile
        // spans a tenth of a degree, over which the width hardly changes.
        var reference = Lines.SelectMany(l => l).Where(TransitTile.IsPosition).Select(p => (double?)p.Latitude).FirstOrDefault() ?? 0;
        _cellLat = CellMeters / MetersPerDegree;
        _cellLon = _cellLat / Math.Max(Math.Cos(double.DegreesToRadians(Math.Min(Math.Abs(reference), 89))), 0.01);

        var pieces = new List<double>();
        foreach (var line in Lines)
            AddLine(line, pieces);
        _pieces = [.. pieces];

        var cells = new Dictionary<long, List<int>>();
        for (var piece = 0; piece < _pieces.Length / 4; piece++)
        {
            var at = piece * 4;
            var (rowFrom, rowTo) = Ordered(Row(_pieces[at]), Row(_pieces[at + 2]));
            var (colFrom, colTo) = Ordered(Col(_pieces[at + 1]), Col(_pieces[at + 3]));
            for (var row = rowFrom; row <= rowTo; row++)
            {
                for (var col = colFrom; col <= colTo; col++)
                {
                    var key = Key(row, col);
                    if (!cells.TryGetValue(key, out var list)) cells[key] = list = [];
                    list.Add(piece);
                }
            }
        }
        _cells = cells.ToDictionary(c => c.Key, c => c.Value.ToArray());
    }

    /// <summary>The lines as given (a copy).</summary>
    public IReadOnlyList<IReadOnlyList<GeoPoint>> Lines { get; }

    /// <summary>Whether the tile has no line to be near.</summary>
    public bool IsEmpty => _pieces.Length == 0;

    /// <summary>
    /// The distance in metres from <paramref name="p"/> to the nearest line, when one is at most <paramref name="meters"/> away;
    /// null when none is, or when <paramref name="p"/> is not a position on the globe.
    /// </summary>
    public double? DistanceWithin(GeoPoint p, double meters)
    {
        var bestSquared = double.PositiveInfinity;
        return Search(p, meters, stopAtFirst: false, ref bestSquared) ? Math.Sqrt(bestSquared) : null;
    }

    /// <summary>Whether a line comes within <paramref name="meters"/> of <paramref name="p"/>. Stops at the first one found.</summary>
    public bool IsWithin(GeoPoint p, double meters)
    {
        var bestSquared = double.PositiveInfinity;
        return Search(p, meters, stopAtFirst: true, ref bestSquared);
    }

    /// <summary>
    /// Whether a piece lies within <paramref name="meters"/> of <paramref name="p"/>, lowering <paramref name="bestSquared"/> to
    /// the squared distance of the nearest such piece when that is nearer than it already is. With
    /// <paramref name="stopAtFirst"/>, stops at the first piece within reach. The test is on squared distances, so a position
    /// is within reach or not whichever way it is asked.
    /// </summary>
    internal bool Search(GeoPoint p, double meters, bool stopAtFirst, ref double bestSquared)
    {
        if (_pieces.Length == 0 || !TransitTile.IsPosition(p) || !(meters >= 0))
            return false;

        var lat = p.Latitude;
        var lon = Geo.NormalizeLongitude(p.Longitude);
        var eastPerDegree = MetersPerDegree * Math.Cos(double.DegreesToRadians(lat));
        var reach = meters * (1 + SearchSlack);
        var latReach = reach / MetersPerDegree;
        var lonReach = eastPerDegree > reach / 180 ? Math.Min(180, reach / eastPerDegree) : 180;

        var rowFrom = Row(lat - latReach);
        var rowTo = Row(lat + latReach);
        var colFrom = Col(lon - lonReach);
        var colTo = Col(lon + lonReach);
        var limit = meters * meters;
        var found = false;

        for (var row = rowFrom; row <= rowTo; row++)
        {
            for (var col = colFrom; col <= colTo; col++)
            {
                if (!_cells.TryGetValue(Key(row, col), out var pieces))
                    continue;

                foreach (var piece in pieces)
                {
                    var at = piece * 4;
                    var squared = SquaredDistance(
                        (_pieces[at] - lat) * MetersPerDegree, East(_pieces[at + 1] - lon) * eastPerDegree,
                        (_pieces[at + 2] - lat) * MetersPerDegree, East(_pieces[at + 3] - lon) * eastPerDegree);
                    if (squared > limit)
                        continue;

                    found = true;
                    if (squared < bestSquared)
                        bestSquared = squared;
                    if (stopAtFirst)
                        return true;
                }
            }
        }
        return found;
    }

    /// <summary>Cuts a line into pieces no longer than a cell and appends them. A run of one vertex is a piece of no length.</summary>
    private static void AddLine(IReadOnlyList<GeoPoint> line, List<double> pieces)
    {
        var previous = default(GeoPoint);
        var run = 0; // vertices in the current run of good ones
        foreach (var raw in line)
        {
            if (!TransitTile.IsPosition(raw))
            {
                if (run == 1)
                    pieces.AddRange([previous.Latitude, previous.Longitude, previous.Latitude, previous.Longitude]);
                run = 0; // a bad vertex splits the line
                continue;
            }

            var p = raw with { Longitude = Geo.NormalizeLongitude(raw.Longitude) };
            run++;
            if (run == 1)
            {
                previous = p;
                continue;
            }
            var a = previous;

            // A step across the antimeridian is taken the short way, and its pieces are not wrapped: they run on past 180 (or -180),
            // where the grid files them beyond its last (or first) column, so no piece spans the whole width of the grid.
            var dLat = p.Latitude - a.Latitude;
            var dLon = East(p.Longitude - a.Longitude);
            var meters = Math.Sqrt(Math.Pow(dLat * MetersPerDegree, 2) + Math.Pow(dLon * MetersPerDegree * Math.Cos(double.DegreesToRadians(a.Latitude)), 2));
            var count = Math.Max(1, (int)Math.Ceiling(meters / CellMeters));
            for (var k = 0; k < count; k++)
            {
                var from = k / (double)count;
                var to = (k + 1) / (double)count;
                pieces.Add(a.Latitude + dLat * from);
                pieces.Add(a.Longitude + dLon * from);
                pieces.Add(k + 1 == count ? p.Latitude : a.Latitude + dLat * to);
                pieces.Add(k + 1 == count ? a.Longitude + dLon : a.Longitude + dLon * to);
            }
            previous = p;
        }
        if (run == 1)
            pieces.AddRange([previous.Latitude, previous.Longitude, previous.Latitude, previous.Longitude]);
    }

    /// <summary>A longitude difference taken the short way round, in (-180, 180].</summary>
    private static double East(double degrees) => degrees > 180 ? degrees - 360 : degrees <= -180 ? degrees + 360 : degrees;

    /// <summary>
    /// Squared distance from the origin to the segment from (ay, ax) to (by, bx), in metres north and east; to the point a when
    /// the segment has no length.
    /// </summary>
    private static double SquaredDistance(double ay, double ax, double by, double bx)
    {
        var dx = bx - ax;
        var dy = by - ay;
        var lengthSquared = dx * dx + dy * dy;
        var t = lengthSquared == 0 ? 0 : Math.Clamp(-(ax * dx + ay * dy) / lengthSquared, 0, 1);
        var ex = ax + t * dx;
        var ey = ay + t * dy;
        return ex * ex + ey * ey;
    }

    private long Row(double latitude) => (long)Math.Floor((latitude + 90) / _cellLat);

    private long Col(double longitude) => (long)Math.Floor((longitude + 180) / _cellLon);

    private static long Key(long row, long col) => (row << 32) ^ (col & 0xFFFF_FFFF);

    private static (long From, long To) Ordered(long a, long b) => a <= b ? (a, b) : (b, a);
}

/// <summary>Where the classifier gets the cached lines of a tile from. It never fetches anything.</summary>
public interface ITransitLineSource
{
    /// <summary>
    /// The lines of <paramref name="tile"/> when the tile is cached (<see cref="TransitLines.Empty"/> or another tile with no
    /// lines when it was fetched and holds none), or false when it is not cached yet.
    /// </summary>
    bool TryGetLines(TransitTile tile, [NotNullWhen(true)] out TransitLines? lines);
}

/// <summary>
/// An <see cref="ITransitLineSource"/> over the tiles it is given: any other tile is not cached. Reading is safe from several
/// threads only while nothing is being set.
/// </summary>
public sealed class TransitLineCache : ITransitLineSource
{
    private readonly Dictionary<TransitTile, TransitLines> _tiles = [];

    public TransitLineCache()
    {
    }

    public TransitLineCache(IEnumerable<KeyValuePair<TransitTile, TransitLines>> tiles)
    {
        ArgumentNullException.ThrowIfNull(tiles);
        foreach (var (tile, lines) in tiles)
            Set(tile, lines);
    }

    /// <summary>How many tiles are cached.</summary>
    public int Count => _tiles.Count;

    /// <summary>Caches <paramref name="lines"/> as the lines of <paramref name="tile"/>, replacing what was there.</summary>
    public void Set(TransitTile tile, TransitLines lines)
    {
        ArgumentNullException.ThrowIfNull(lines);
        _tiles[tile] = lines;
    }

    public bool TryGetLines(TransitTile tile, [NotNullWhen(true)] out TransitLines? lines) => _tiles.TryGetValue(tile, out lines);
}

/// <summary>
/// The lines of several tiles of one kind, asked as one: the nearest line to a position, whichever tile it is in. A position is
/// looked up in the tiles its search circle reaches; a tile it reaches that the index was not given counts as having no lines.
/// Read-only once built.
/// </summary>
public sealed class TransitLineIndex
{
    private const double MetersPerDegree = Geo.EarthRadiusMeters * Math.PI / 180;
    private const int LonColumns = 360 * TransitTile.PerDegree;

    private readonly Dictionary<TransitTile, TransitLines> _tiles = [];

    /// <exception cref="ArgumentException">A tile is not of <paramref name="kind"/>, or is given twice.</exception>
    public TransitLineIndex(TransitKind kind, IEnumerable<KeyValuePair<TransitTile, TransitLines>> tiles)
    {
        ArgumentNullException.ThrowIfNull(tiles);
        Kind = kind;
        foreach (var (tile, lines) in tiles)
        {
            ArgumentNullException.ThrowIfNull(lines);
            if (tile.Kind != kind)
                throw new ArgumentException($"Tile {tile} is not of kind {kind}.", nameof(tiles));
            if (!_tiles.TryAdd(tile, lines))
                throw new ArgumentException($"Tile {tile} is given twice.", nameof(tiles));
        }
    }

    /// <summary>The kind of line the index holds.</summary>
    public TransitKind Kind { get; }

    /// <summary>The distance in metres to the nearest line when one is at most <paramref name="meters"/> away, else null.</summary>
    public double? DistanceWithin(GeoPoint p, double meters)
    {
        var bestSquared = double.PositiveInfinity;
        return Search(p, meters, stopAtFirst: false, ref bestSquared) ? Math.Sqrt(bestSquared) : null;
    }

    /// <summary>Whether a line comes within <paramref name="meters"/> of <paramref name="p"/>. Stops at the first one found.</summary>
    public bool IsWithin(GeoPoint p, double meters)
    {
        var bestSquared = double.PositiveInfinity;
        return Search(p, meters, stopAtFirst: true, ref bestSquared);
    }

    private bool Search(GeoPoint p, double meters, bool stopAtFirst, ref double bestSquared)
    {
        if (_tiles.Count == 0 || !TransitTile.IsPosition(p) || !(meters >= 0))
            return false;

        // The tiles of the bounding box of the search circle (a few more than the circle reaches: those are cheap to ask). Near a
        // pole the box takes every column.
        var lon = Geo.NormalizeLongitude(p.Longitude);
        var latReach = meters / MetersPerDegree;
        var eastPerDegree = MetersPerDegree * Math.Cos(double.DegreesToRadians(p.Latitude));
        var lonReach = eastPerDegree > meters / 180 ? meters / eastPerDegree : 180;
        var latFrom = TransitTile.LatIndexOf(Math.Max(-90, p.Latitude - latReach));
        var latTo = TransitTile.LatIndexOf(Math.Min(90, p.Latitude + latReach));
        var lonFrom = (int)Math.Floor((lon - lonReach) * TransitTile.PerDegree);
        var lonTo = (int)Math.Floor((lon + lonReach) * TransitTile.PerDegree);
        if (lonTo - lonFrom + 1 >= LonColumns)
            (lonFrom, lonTo) = (-LonColumns / 2, LonColumns / 2 - 1);

        var found = false;
        for (var lat = latFrom; lat <= latTo; lat++)
        {
            for (var raw = lonFrom; raw <= lonTo; raw++)
            {
                var column = raw < -LonColumns / 2 ? raw + LonColumns : raw >= LonColumns / 2 ? raw - LonColumns : raw; // across the antimeridian
                if (!_tiles.TryGetValue(new TransitTile(Kind, lat, column), out var lines))
                    continue;
                if (lines.Search(p, meters, stopAtFirst, ref bestSquared))
                {
                    found = true;
                    if (stopAtFirst)
                        return true;
                }
            }
        }
        return found;
    }
}
