namespace Sporer.Timeline;

/// <summary>
/// The two kinds of line a move is matched against (transit spec section 3). Stored and sent as the member's name in lower
/// case: <c>rail</c>, <c>bus</c>.
/// </summary>
public enum TransitKind
{
    /// <summary>Railways of every kind: mainline and local trains, the metro, trams, light rail, funiculars.</summary>
    Rail,

    /// <summary>The ways that bus, trolleybus and coach routes run on.</summary>
    Bus,
}

/// <summary>
/// One tile of the lines of one kind: the world is cut into tiles of 0.1 by 0.1 degrees (about 11 km by 6 km in Oslo), and the
/// lines of a tile are fetched once and kept (transit spec section 3). <paramref name="LatIndex"/> is
/// <c>floor(latitude * 10)</c>, from -900 to 899, and <paramref name="LonIndex"/> is <c>floor(longitude * 10)</c> of the
/// longitude wrapped into [-180, 180), from -1800 to 1799. The tile covers <see cref="South"/> to <see cref="North"/> and
/// <see cref="West"/> to <see cref="East"/>. Tiles order by kind, then latitude, then longitude.
/// </summary>
public readonly record struct TransitTile(TransitKind Kind, int LatIndex, int LonIndex) : IComparable<TransitTile>
{
    /// <summary>How many tiles a degree is cut into, along either axis.</summary>
    public const int PerDegree = 10;

    private const int MinLatIndex = -90 * PerDegree;
    private const int MaxLatIndex = 90 * PerDegree - 1; // the north pole itself falls in the last row
    private const int LonIndexCount = 360 * PerDegree;
    private const double MetersPerDegree = Geo.EarthRadiusMeters * Math.PI / 180;

    /// <summary>
    /// Relative slack on <see cref="Near"/>'s distance, so that floating-point rounding right at a tile's edge can never leave out
    /// a tile that a line within the distance lies in. It only adds tiles, by micrometres.
    /// </summary>
    private const double NearSlack = 1e-6;

    /// <summary>The southern edge, in degrees.</summary>
    public double South => LatIndex / (double)PerDegree;

    /// <summary>The northern edge, in degrees.</summary>
    public double North => (LatIndex + 1) / (double)PerDegree;

    /// <summary>The western edge, in degrees.</summary>
    public double West => LonIndex / (double)PerDegree;

    /// <summary>The eastern edge, in degrees (180 for the last column).</summary>
    public double East => (LonIndex + 1) / (double)PerDegree;

    /// <summary>The tile of <paramref name="kind"/> that <paramref name="p"/> lies in.</summary>
    /// <exception cref="ArgumentOutOfRangeException"><paramref name="p"/> is not a position on the globe.</exception>
    public static TransitTile At(TransitKind kind, GeoPoint p)
    {
        if (!IsPosition(p))
            throw new ArgumentOutOfRangeException(nameof(p), p, "A tile needs a finite latitude within +-90 and a finite longitude.");
        return new TransitTile(kind, LatIndexOf(p.Latitude), WrapLon(RawLonIndex(Geo.NormalizeLongitude(p.Longitude))));
    }

    /// <summary>
    /// The tiles of <paramref name="kind"/> that come within <paramref name="meters"/> of any of <paramref name="points"/>, each
    /// once, in order. A point that is not a position on the globe is left out. The distance to a tile is measured to the
    /// nearest point of its rectangle on a local flat-earth projection, which is exact enough at a few hundred metres.
    /// </summary>
    public static IReadOnlyList<TransitTile> Near(TransitKind kind, IEnumerable<GeoPoint> points, double meters)
    {
        ArgumentNullException.ThrowIfNull(points);
        if (!double.IsFinite(meters) || meters < 0)
            throw new ArgumentOutOfRangeException(nameof(meters), meters, "The distance must be zero or more and finite.");

        var tiles = new HashSet<TransitTile>();
        foreach (var p in points)
            AddNear(kind, p, meters, tiles);

        var sorted = tiles.ToList();
        sorted.Sort();
        return sorted;
    }

    /// <summary>Adds the tiles within <paramref name="meters"/> of <paramref name="p"/> to <paramref name="tiles"/>.</summary>
    internal static void AddNear(TransitKind kind, GeoPoint p, double meters, HashSet<TransitTile> tiles)
    {
        if (!IsPosition(p))
            return;

        var lon = Geo.NormalizeLongitude(p.Longitude);
        var reach = meters * (1 + NearSlack);
        var latReach = reach / MetersPerDegree;
        var cos = Math.Cos(double.DegreesToRadians(p.Latitude));
        var lonReach = cos * MetersPerDegree * 360 <= 2 * reach ? 360 : Math.Min(360, reach / (MetersPerDegree * cos));

        var latFrom = LatIndexOf(Math.Max(-90, p.Latitude - latReach));
        var latTo = LatIndexOf(Math.Min(90, p.Latitude + latReach));
        var lonFrom = RawLonIndex(lon - lonReach);
        var lonTo = RawLonIndex(lon + lonReach);
        if (lonTo - lonFrom + 1 >= LonIndexCount)
            (lonFrom, lonTo) = (RawLonIndex(-180), RawLonIndex(-180) + LonIndexCount - 1); // the whole ring, each column once

        // The common case: the circle lies inside one tile.
        if (latFrom == latTo && lonFrom == lonTo)
        {
            tiles.Add(new TransitTile(kind, latFrom, WrapLon(lonFrom)));
            return;
        }

        for (var lat = latFrom; lat <= latTo; lat++)
        {
            // How far north or south of the tile's rows the point is (zero inside them).
            var south = lat / (double)PerDegree;
            var north = (lat + 1) / (double)PerDegree;
            var dy = (p.Latitude < south ? south - p.Latitude : p.Latitude > north ? p.Latitude - north : 0) * MetersPerDegree;
            for (var raw = lonFrom; raw <= lonTo; raw++)
            {
                // Column edges unwrapped around the point's own longitude, so a tile across the antimeridian is measured the short way.
                var west = raw / (double)PerDegree;
                var east = (raw + 1) / (double)PerDegree;
                var dx = (lon < west ? west - lon : lon > east ? lon - east : 0) * MetersPerDegree * cos;
                if (dx * dx + dy * dy <= reach * reach)
                    tiles.Add(new TransitTile(kind, lat, WrapLon(raw)));
            }
        }
    }

    public int CompareTo(TransitTile other)
    {
        var byKind = Kind.CompareTo(other.Kind);
        if (byKind != 0) return byKind;
        var byLat = LatIndex.CompareTo(other.LatIndex);
        return byLat != 0 ? byLat : LonIndex.CompareTo(other.LonIndex);
    }

    internal static bool IsPosition(GeoPoint p)
        => double.IsFinite(p.Latitude) && double.IsFinite(p.Longitude) && p.Latitude is >= -90 and <= 90;

    internal static int LatIndexOf(double latitude)
        => Math.Clamp((int)Math.Floor(latitude * PerDegree), MinLatIndex, MaxLatIndex);

    /// <summary>The column of a longitude, not yet wrapped: below -1800 west of -180, 1800 and above east of 180.</summary>
    private static int RawLonIndex(double longitude) => (int)Math.Floor(longitude * PerDegree);

    private static int WrapLon(int raw) => ((raw + LonIndexCount / 2) % LonIndexCount + LonIndexCount) % LonIndexCount - LonIndexCount / 2;
}
