using Sporer.Timeline;

namespace Sporer.Testing;

/// <summary>Synthetic places shared by the tests. Not real addresses.</summary>
public static class Spots
{
    public static readonly GeoPoint Home = new(59.9200, 10.7500);
    public static readonly GeoPoint Cafe = Geo.Offset(Home, 900, 500);
    public static readonly GeoPoint Office = Geo.Offset(Home, 2500, 3000);
    public static readonly GeoPoint Gym = Geo.Offset(Home, 1200, 2600);
    public static readonly GeoPoint Lisbon = new(38.7223, -9.1393);
    public static readonly GeoPoint Tokyo = new(35.5494, 139.7798);
    public static readonly GeoPoint SanFrancisco = new(37.6213, -122.3790);
}
