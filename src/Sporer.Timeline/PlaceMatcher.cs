namespace Sporer.Timeline;

/// <summary>
/// In-memory place matching: the nearest known place within a radius of a position (spec section 6, 75 m by default),
/// or none. One matcher is built per reprocessing run; <see cref="Add"/> registers places created during the run so
/// later stays in the same run match them.
/// <para>
/// Matching is deterministic: the nearest place wins and an exact tie in distance goes to the lower id, whatever
/// order the places were added in. A place exactly <c>radiusMeters</c> away still matches.
/// </para>
/// <para>
/// Places are kept in a grid only to narrow the candidates; the haversine distance (<see cref="Geo.DistanceMeters"/>)
/// is the sole test of whether a place matches. The grid is built in latitude bands <c>radiusMeters</c> tall, and each
/// band is cut into as many longitude cells as fit a full circle of latitude at least <c>radiusMeters</c> wide, so
/// cells stay roughly radius-sized at Tromsø as at the equator. A lookup covers the whole latitude and longitude extent
/// of the circle around the query (every longitude when the circle reaches a pole, wrapping across the antimeridian),
/// so it touches a handful of cells (about nine) and cannot miss a place at a cell border. Not thread-safe.
/// </para>
/// </summary>
public sealed class PlaceMatcher
{
    /// <summary>
    /// Relative slack on the angular search radius, so floating-point rounding right at the edge of the circle (or of
    /// a cell) can never make the grid reject a place that the distance check would accept. It only widens the
    /// candidate set, by micrometres.
    /// </summary>
    private const double SearchSlack = 1e-6;

    private readonly double _radiusMeters;
    private readonly double _cellDegrees;
    private readonly Dictionary<(long Band, long Cell), List<Entry>> _cells = [];
    private readonly HashSet<long> _ids = [];

    /// <param name="places">The places known at the start, by id. Ids must be unique.</param>
    /// <param name="radiusMeters">A position matches a place whose centre is at most this far away.</param>
    public PlaceMatcher(IEnumerable<(long Id, GeoPoint Centre)> places, double radiusMeters)
    {
        ArgumentNullException.ThrowIfNull(places);
        if (!double.IsFinite(radiusMeters) || radiusMeters <= 0)
            throw new ArgumentOutOfRangeException(nameof(radiusMeters), radiusMeters, "The match radius must be positive and finite.");

        _radiusMeters = radiusMeters;
        _cellDegrees = double.RadiansToDegrees(radiusMeters / Geo.EarthRadiusMeters);
        foreach (var (id, centre) in places) Add(id, centre);
    }

    /// <summary>Registers a place so that later calls to <see cref="Match"/> can return it.</summary>
    /// <exception cref="ArgumentException">A place with this id was already added.</exception>
    /// <exception cref="ArgumentOutOfRangeException"><paramref name="centre"/> is not a position on the globe.</exception>
    public void Add(long id, GeoPoint centre)
    {
        if (!IsPosition(centre))
            throw new ArgumentOutOfRangeException(nameof(centre), centre, "A place centre needs a finite latitude within +-90 and a finite longitude.");
        if (!_ids.Add(id))
            throw new ArgumentException($"A place with id {id} was already added.", nameof(id));

        var normalised = centre with { Longitude = Geo.NormalizeLongitude(centre.Longitude) };
        var band = BandOf(normalised.Latitude);
        var key = (band, LongitudeCell(normalised.Longitude, LongitudeCellCount(band)));
        if (!_cells.TryGetValue(key, out var entries)) _cells[key] = entries = [];
        entries.Add(new Entry(id, normalised));
    }

    /// <summary>
    /// The id of the nearest place within the radius of <paramref name="p"/> (the lower id on an exact tie), or null
    /// when there is none, including when <paramref name="p"/> is not a valid position.
    /// </summary>
    public long? Match(GeoPoint p)
    {
        if (!IsPosition(p)) return null;

        var query = p with { Longitude = Geo.NormalizeLongitude(p.Longitude) };
        var angle = _radiusMeters / Geo.EarthRadiusMeters * (1 + SearchSlack); // angular radius, radians
        var angleDegrees = double.RadiansToDegrees(angle);

        // Latitude extent of the circle: exactly +-angle.
        var bandFrom = BandOf(Math.Max(-90, query.Latitude - angleDegrees));
        var bandTo = BandOf(Math.Min(90, query.Latitude + angleDegrees));

        // Longitude extent: asin(sin(angle) / cos(latitude)), or everything when the circle reaches a pole.
        var reachesPole = Math.Abs(query.Latitude) + angleDegrees >= 90;
        var lonReach = reachesPole
            ? 360
            : double.RadiansToDegrees(Math.Asin(Math.Min(1, Math.Sin(angle) / Math.Cos(double.DegreesToRadians(query.Latitude)))));

        long? bestId = null;
        var bestDistance = double.MaxValue;

        for (var band = bandFrom; band <= bandTo; band++)
        {
            var cellCount = LongitudeCellCount(band);
            var first = RawLongitudeCell(query.Longitude - lonReach, cellCount);
            var last = RawLongitudeCell(query.Longitude + lonReach, cellCount);
            if (last - first + 1 >= cellCount) (first, last) = (0, cellCount - 1); // the whole ring; never visit a cell twice

            for (var raw = first; raw <= last; raw++)
            {
                if (!_cells.TryGetValue((band, Wrap(raw, cellCount)), out var entries)) continue;

                foreach (var entry in entries)
                {
                    var distance = Geo.DistanceMeters(query, entry.Centre);
                    if (distance > _radiusMeters) continue;
                    if (distance < bestDistance || (distance == bestDistance && entry.Id < bestId))
                    {
                        bestDistance = distance;
                        bestId = entry.Id;
                    }
                }
            }
        }

        return bestId;
    }

    private static bool IsPosition(GeoPoint p)
        => double.IsFinite(p.Latitude) && double.IsFinite(p.Longitude) && p.Latitude is >= -90 and <= 90;

    /// <summary>The latitude band (counted from the south pole) holding <paramref name="latitude"/>.</summary>
    private long BandOf(double latitude) => (long)Math.Floor((latitude + 90) / _cellDegrees);

    /// <summary>
    /// How many longitude cells a band is cut into: as many as fit a full circle of latitude with each at least one
    /// radius wide at the band's narrowest (poleward) edge, never fewer than one. Depends only on the band, so a place
    /// and a query agree on it.
    /// </summary>
    private long LongitudeCellCount(long band)
    {
        var south = band * _cellDegrees - 90;
        var poleward = Math.Min(90, Math.Max(Math.Abs(south), Math.Abs(south + _cellDegrees)));
        var circumference = 2 * Math.PI * Geo.EarthRadiusMeters * Math.Cos(double.DegreesToRadians(poleward));
        return Math.Max(1, (long)Math.Floor(circumference / _radiusMeters));
    }

    /// <summary>The cell of a longitude in [-180, 180) within its band (never outside 0..cellCount-1).</summary>
    private static long LongitudeCell(double longitude, long cellCount) => Wrap(RawLongitudeCell(longitude, cellCount), cellCount);

    /// <summary>The cell index of a longitude counted from -180, not yet wrapped (negative west of -180, past the end east of 180).</summary>
    private static long RawLongitudeCell(double longitude, long cellCount) => (long)Math.Floor((longitude + 180) * cellCount / 360);

    private static long Wrap(long cell, long cellCount) => ((cell % cellCount) + cellCount) % cellCount;

    private readonly record struct Entry(long Id, GeoPoint Centre);
}
