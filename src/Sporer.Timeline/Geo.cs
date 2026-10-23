namespace Sporer.Timeline;

/// <summary>A WGS84 position in decimal degrees.</summary>
public readonly record struct GeoPoint(double Latitude, double Longitude);

/// <summary>Spherical geometry on a sphere of mean Earth radius. No PostGIS: everything is computed here.</summary>
public static class Geo
{
    /// <summary>Mean Earth radius in metres (IUGG).</summary>
    internal const double EarthRadiusMeters = 6_371_008.8;

    /// <summary>Haversine distance in metres.</summary>
    public static double DistanceMeters(GeoPoint a, GeoPoint b)
    {
        var dLat = ToRadians(b.Latitude - a.Latitude);
        var dLon = ToRadians(b.Longitude - a.Longitude);
        var h = Math.Pow(Math.Sin(dLat / 2), 2)
                + Math.Cos(ToRadians(a.Latitude)) * Math.Cos(ToRadians(b.Latitude)) * Math.Pow(Math.Sin(dLon / 2), 2);
        return 2 * EarthRadiusMeters * Math.Asin(Math.Min(1, Math.Sqrt(h)));
    }

    /// <summary>
    /// The point <paramref name="northMeters"/> north and <paramref name="eastMeters"/> east of <paramref name="from"/>
    /// (negative for south and west). A local flat-earth step, accurate to centimetres at city scale.
    /// </summary>
    public static GeoPoint Offset(GeoPoint from, double northMeters, double eastMeters)
    {
        var dLat = northMeters / EarthRadiusMeters;
        var midLat = ToRadians(from.Latitude) + dLat / 2;
        var dLon = eastMeters / (EarthRadiusMeters * Math.Cos(midLat));
        return new GeoPoint(from.Latitude + ToDegrees(dLat), NormalizeLongitude(from.Longitude + ToDegrees(dLon)));
    }

    /// <summary>
    /// <paramref name="points"/> evenly spaced points along the great circle from <paramref name="a"/> to
    /// <paramref name="b"/>, both included. Longitudes are unwrapped (they may leave ±180) so that consecutive
    /// points never differ by more than 180 degrees, which keeps an antimeridian crossing a continuous line.
    /// </summary>
    public static IReadOnlyList<GeoPoint> GreatCircle(GeoPoint a, GeoPoint b, int points = 64)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(points, 2);
        var result = new List<GeoPoint>(points) { a };
        var previousLon = a.Longitude;
        for (var i = 1; i < points; i++)
        {
            var p = Interpolate(a, b, i / (double)(points - 1));
            var lon = p.Longitude;
            while (lon - previousLon > 180) lon -= 360;
            while (lon - previousLon < -180) lon += 360;
            result.Add(p with { Longitude = lon });
            previousLon = lon;
        }
        return result;
    }

    /// <summary>The point <paramref name="fraction"/> (0 to 1) of the way along the great circle from a to b.</summary>
    public static GeoPoint Interpolate(GeoPoint a, GeoPoint b, double fraction)
    {
        if (fraction <= 0) return a;
        if (fraction >= 1) return b;

        var angle = DistanceMeters(a, b) / EarthRadiusMeters;
        var sinAngle = Math.Sin(angle);
        if (sinAngle < 1e-12) return fraction < 0.5 ? a : b; // coincident (or exactly antipodal: no unique route)

        var wa = Math.Sin((1 - fraction) * angle) / sinAngle;
        var wb = Math.Sin(fraction * angle) / sinAngle;
        var latA = ToRadians(a.Latitude);
        var latB = ToRadians(b.Latitude);
        var lonA = ToRadians(a.Longitude);
        var lonB = ToRadians(b.Longitude);
        var x = wa * Math.Cos(latA) * Math.Cos(lonA) + wb * Math.Cos(latB) * Math.Cos(lonB);
        var y = wa * Math.Cos(latA) * Math.Sin(lonA) + wb * Math.Cos(latB) * Math.Sin(lonB);
        var z = wa * Math.Sin(latA) + wb * Math.Sin(latB);
        return new GeoPoint(ToDegrees(Math.Atan2(z, Math.Sqrt(x * x + y * y))), ToDegrees(Math.Atan2(y, x)));
    }

    private static double NormalizeLongitude(double lon)
    {
        if (lon is >= -180 and < 180) return lon;
        var wrapped = (lon + 180) % 360;
        return (wrapped < 0 ? wrapped + 360 : wrapped) - 180;
    }

    private static double ToRadians(double degrees) => degrees * Math.PI / 180;

    private static double ToDegrees(double radians) => radians * 180 / Math.PI;
}
