using Sporer.Timeline;

namespace Sporer.SyntheticData;

/// <summary>A named spot of the fictional world. Names are unique: roads are remembered by them.</summary>
internal sealed record Place(string Name, GeoPoint Position);

/// <summary>
/// How a kind of travel moves: its cruising speed (m/s) and how much that varies, how often it stops (a light, a crossing,
/// a station) and for how long (seconds), and what Overland's motion sensor reports while doing it.
/// </summary>
internal sealed record Gait(string Name, double Speed, double Spread, double StopChance, double StopMin, double StopMax, string Motion)
{
    public static readonly Gait Walk = new("walk", 1.40, 0.12, 0.04, 6, 20, "walking");
    public static readonly Gait Run = new("run", 2.90, 0.10, 0.02, 5, 15, "running");
    public static readonly Gait Cycle = new("cycle", 5.30, 0.15, 0.12, 6, 30, "cycling");
    public static readonly Gait Drive = new("drive", 11.5, 0.30, 0.22, 8, 45, "driving");
    public static readonly Gait Highway = new("highway", 23.0, 0.12, 0.05, 5, 20, "driving");
    /// <summary>Metro, train, taxi: fast, with a stop every minute or so.</summary>
    public static readonly Gait Transit = new("transit", 13.0, 0.25, 0.35, 20, 40, "driving");
}

/// <summary>
/// The roads of the fictional world: the line between two places, made up the first time it is asked for and the same
/// afterwards (a commute is the same road every day). A line wanders a little either side of the straight one.
/// </summary>
internal sealed class Roads(Rng rng)
{
    private const double MetersPerDegree = 111_194.93;

    private readonly Dictionary<(string From, string To), GeoPoint[]> _lines = [];

    public IReadOnlyList<GeoPoint> Between(Place from, Place to)
    {
        if (_lines.TryGetValue((from.Name, to.Name), out var known))
            return known;

        var line = Build(from.Position, to.Position);
        _lines[(from.Name, to.Name)] = line;
        return line;
    }

    private GeoPoint[] Build(GeoPoint a, GeoPoint b)
    {
        var distance = Geo.DistanceMeters(a, b);
        var count = Math.Clamp((int)(distance / 500), 1, 60);
        var north = (b.Latitude - a.Latitude) * MetersPerDegree;
        var east = (b.Longitude - a.Longitude) * MetersPerDegree * Math.Cos((a.Latitude + b.Latitude) / 2 * Math.PI / 180);
        var length = Math.Max(1, Math.Sqrt(north * north + east * east));
        var (perpendicularNorth, perpendicularEast) = (-east / length, north / length);

        var limit = Math.Min(0.08 * distance, 700);
        var line = new GeoPoint[count + 2];
        line[0] = a;
        line[^1] = b;
        var offset = 0.0;
        for (var i = 1; i <= count; i++)
        {
            var along = i / (count + 1.0);
            offset = Math.Clamp(offset * 0.75 + rng.Gauss() * limit * 0.35, -limit, limit);
            line[i] = Geo.Offset(a, north * along + perpendicularNorth * offset, east * along + perpendicularEast * offset);
        }
        return line;
    }
}

/// <summary>Where the person lives, and the places around that home that they use.</summary>
internal sealed record Residence(
    Place Home, Place Gym, Place Shop, Place Hub, Place HubCafe, Place Park, Place ParkFar,
    IReadOnlyList<Place> RunVias, IReadOnlyList<Place> RideCafes)
{
    public static Residence Around(string name, GeoPoint home, Rng rng)
    {
        Place At(string what, double north, double east) => new($"{name}:{what}", Geo.Offset(home, north, east));

        var hub = At("hub", 1500, -1600);
        var park = At("park", 1800, -300);
        // The bearings of the run and ride turning points are spread round the compass, so the loops differ.
        var bearing = rng.Uniform(0, 2 * Math.PI);
        Place Out(string what, int index, int of, double minKm, double maxKm)
        {
            var angle = bearing + index * 2 * Math.PI / of + rng.Uniform(-0.3, 0.3);
            var distance = rng.Uniform(minKm, maxKm) * 1000;
            return At(what + index, distance * Math.Cos(angle), distance * Math.Sin(angle));
        }

        return new Residence(
            At("home", 0, 0), At("gym", 1100, 900), At("shop", -700, 500), hub,
            new Place($"{name}:hubcafe", Geo.Offset(hub.Position, 300, -250)), park,
            new Place($"{name}:parkfar", Geo.Offset(park.Position, 1500, 1200)),
            [Out("runvia", 0, 3, 2.5, 3.6), Out("runvia", 1, 3, 2.5, 3.6), Out("runvia", 2, 3, 2.5, 3.6)],
            [Out("ridecafe", 0, 4, 14, 24), Out("ridecafe", 1, 4, 14, 24), Out("ridecafe", 2, 4, 14, 24), Out("ridecafe", 3, 4, 14, 24)]);
    }
}
