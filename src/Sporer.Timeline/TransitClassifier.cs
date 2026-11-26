namespace Sporer.Timeline;

/// <summary>
/// What the transit rules made of a move: its <paramref name="Mode"/>, the <paramref name="BaseMode"/> that
/// <see cref="ModeClassifier"/> gave it, and the tiles whose lines were needed but are not cached yet
/// (<paramref name="Missing"/>, ordered, each carrying its kind). Only tiles whose lines could change the mode are listed: once
/// they are cached, classifying the move again may give another mode. <paramref name="RailShare"/> and
/// <paramref name="BusShare"/> are the shares of the path found near a railway and near a bus route (0 to 1), or null when they
/// were not worked out (not needed, or the tiles are missing).
/// </summary>
public sealed record TransitResult(
    TravelMode Mode,
    TravelMode BaseMode,
    IReadOnlyList<TransitTile> Missing,
    double? RailShare,
    double? BusShare);

/// <summary>
/// The train and bus rules (transit spec sections 2 and 2.1): the mode of a move once the railways and bus routes around it are
/// known. The base mode comes from <see cref="ModeClassifier.Classify"/>; these rules only ever change it:
/// <list type="bullet">
/// <item>A drive is a train when at least <see cref="DetectionOptions.TransitMinShare"/> of its path, and at least
/// <see cref="DetectionOptions.TrainMinDistanceKm"/>, is near a railway.</item>
/// <item>A flight is a train when it looks like ground travel (at least one point per 2 km of its path, and nine hops in ten no
/// faster than <see cref="DetectionOptions.TrainMaxKmh"/>) and the share of its path near a railway is reached.</item>
/// <item>A walk or a ride is a train only through a tunnel: tunnel hops make at least half of its path, and the share of its path
/// near a railway is reached.</item>
/// <item>A drive that is not a train is a bus when it is shorter than <see cref="DetectionOptions.BusMaxKm"/>, or when the share
/// of its path near a bus route is reached; otherwise it stays a drive.</item>
/// </list>
/// <para>
/// Lines are read through an <see cref="ITransitLineSource"/>, a tile at a time, and only for a kind whose answer could change the
/// mode: railways for a drive of <see cref="DetectionOptions.TrainMinDistanceKm"/> or more, a flight that looks like ground
/// travel, or a walk or a ride with enough tunnel-length hops; bus routes for a drive of <see cref="DetectionOptions.BusMaxKm"/>
/// or more that the railways did not make a train. A kind's matching is used only when every tile of that kind the move needs is
/// cached; otherwise the move falls through to the next rule, and the tiles are listed in <see cref="TransitResult.Missing"/>.
/// Bus tiles are listed only once the rail tiles are cached (or were not needed). An owner's choice of mode is not seen here: the
/// caller puts it over the result.
/// </para>
/// <para>
/// Pure and deterministic: the same points and the same cached lines give the same result.
/// </para>
/// </summary>
public static class TransitClassifier
{
    /// <summary>Each hop of the path is sampled every this many metres, both ends included.</summary>
    public const double SampleMeters = 25;

    /// <summary>A hop's reported accuracy widens what counts as near a line, up to this many metres.</summary>
    public const double AccuracyCapMeters = 75;

    /// <summary>A tunnel hop is at least this fast (and at most <see cref="DetectionOptions.TrainMaxKmh"/>).</summary>
    public const double TunnelMinKmh = 15;

    /// <summary>A flight that looks like ground travel has at least one point per this many metres of its path.</summary>
    public const double GroundMetersPerPoint = 2000;

    /// <summary>Tunnel hops must make at least this share of a walk's or a ride's path for it to be a train.</summary>
    private const double TunnelMinPathShare = 0.5;

    /// <summary>The percentile of a flight's hop speeds that must be no faster than a train.</summary>
    private const double GroundSpeedPercentile = 0.9;

    private const double KmhPerMps = 3.6;

    /// <summary>
    /// How far around each sample of a move the tiles are needed: the largest distance any rule looks at
    /// (<see cref="DetectionOptions.TunnelEndMeters"/>, 150 m by default).
    /// </summary>
    public static double SearchMeters(DetectionOptions o)
    {
        ArgumentNullException.ThrowIfNull(o);
        return Math.Max(o.TunnelEndMeters, Math.Max(o.TransitNearMeters, AccuracyCapMeters));
    }

    /// <summary>
    /// Every tile of <paramref name="kind"/> that <see cref="Classify"/> could ask for about <paramref name="move"/>: those within
    /// <see cref="SearchMeters"/> of a sample of its path, in order. <see cref="Classify"/> asks for them only when their lines
    /// could change the mode (see the class); this is for a caller that loads the cached tiles before classifying.
    /// </summary>
    public static IReadOnlyList<TransitTile> TilesNear(MoveSegment move, TransitKind kind, DetectionOptions o)
    {
        ArgumentNullException.ThrowIfNull(move);
        ArgumentNullException.ThrowIfNull(o);

        return [.. new TransitPath(move.Points).Tiles(SearchMeters(o)).Select(t => new TransitTile(kind, t.Lat, t.Lon))];
    }

    /// <summary>
    /// The mode of <paramref name="move"/> by the base classifier and the train and bus rules, with the lines of
    /// <paramref name="lines"/>. See the class for the rules.
    /// </summary>
    public static TransitResult Classify(MoveSegment move, DetectionOptions o, ITransitLineSource lines)
    {
        ArgumentNullException.ThrowIfNull(move);
        ArgumentNullException.ThrowIfNull(o);
        ArgumentNullException.ThrowIfNull(lines);

        var baseMode = ModeClassifier.Classify(move, o);
        var path = new TransitPath(move.Points);
        return baseMode switch
        {
            TravelMode.Drive => Drive(path, o, lines),
            TravelMode.Flight => Flight(path, o, lines),
            TravelMode.Walk or TravelMode.Cycle => OnFoot(baseMode, path, o, lines),
            _ => new TransitResult(baseMode, baseMode, [], null, null),
        };
    }

    // ---- the rules -----------------------------------------------------------------------------------------------

    private static TransitResult Drive(TransitPath path, DetectionOptions o, ITransitLineSource source)
    {
        var missing = new List<TransitTile>();
        double? railShare = null;
        var railKnown = true; // the railways could not change the mode, or their tiles are all cached

        if (path.Meters >= o.TrainMinDistanceKm * 1000)
        {
            var rail = Lines(path, TransitKind.Rail, o, source, missing);
            if (rail is null)
            {
                railKnown = false;
            }
            else
            {
                var match = MatchLines(path, rail, o, tunnels: true);
                railShare = match.Share;
                if (match.Share >= o.TransitMinShare && match.Meters >= o.TrainMinDistanceKm * 1000)
                    return new TransitResult(TravelMode.Train, TravelMode.Drive, missing, railShare, null);
            }
        }

        if (path.Meters < o.BusMaxKm * 1000)
            return new TransitResult(TravelMode.Bus, TravelMode.Drive, missing, railShare, null);

        // Bus tiles are asked for only once the railways are known not to make it a train; until then a long drive stays a drive,
        // unless its bus tiles happen to be cached already.
        var busMissing = new List<TransitTile>();
        var bus = Lines(path, TransitKind.Bus, o, source, busMissing);
        if (bus is null)
        {
            if (railKnown)
                missing.AddRange(busMissing);
            return new TransitResult(TravelMode.Drive, TravelMode.Drive, missing, railShare, null);
        }

        var busShare = MatchLines(path, bus, o, tunnels: false).Share;
        return new TransitResult(busShare >= o.TransitMinShare ? TravelMode.Bus : TravelMode.Drive, TravelMode.Drive, missing, railShare, busShare);
    }

    private static TransitResult Flight(TransitPath path, DetectionOptions o, ITransitLineSource source)
    {
        if (!LooksLikeGroundTravel(path, o))
            return new TransitResult(TravelMode.Flight, TravelMode.Flight, [], null, null);

        var missing = new List<TransitTile>();
        var rail = Lines(path, TransitKind.Rail, o, source, missing);
        if (rail is null)
            return new TransitResult(TravelMode.Flight, TravelMode.Flight, missing, null, null);

        var share = MatchLines(path, rail, o, tunnels: true).Share;
        return new TransitResult(share >= o.TransitMinShare ? TravelMode.Train : TravelMode.Flight, TravelMode.Flight, missing, share, null);
    }

    /// <summary>A walk or a ride: a train only through a tunnel (a metro ride underground with a short walk at each end).</summary>
    private static TransitResult OnFoot(TravelMode baseMode, TransitPath path, DetectionOptions o, ITransitLineSource source)
    {
        // Unless hops long and fast enough to be tunnels could make half the path, no railway can change the mode.
        var candidates = 0.0;
        for (var h = 0; h < path.Hops.Count; h++)
        {
            if (IsTunnelLength(path.Hops[h], o))
                candidates += path.Hops[h].Meters;
        }
        if (path.Meters <= 0 || candidates < TunnelMinPathShare * path.Meters)
            return new TransitResult(baseMode, baseMode, [], null, null);

        var missing = new List<TransitTile>();
        var rail = Lines(path, TransitKind.Rail, o, source, missing);
        if (rail is null)
            return new TransitResult(baseMode, baseMode, missing, null, null);

        var match = MatchLines(path, rail, o, tunnels: true);
        var train = match.TunnelMeters >= TunnelMinPathShare * path.Meters && match.Share >= o.TransitMinShare;
        return new TransitResult(train ? TravelMode.Train : baseMode, baseMode, missing, match.Share, null);
    }

    /// <summary>
    /// At least one point per <see cref="GroundMetersPerPoint"/> of path, and the 90th percentile of the hop speeds (nearest rank,
    /// over the hops that have a length) no faster than <see cref="DetectionOptions.TrainMaxKmh"/>.
    /// </summary>
    private static bool LooksLikeGroundTravel(TransitPath path, DetectionOptions o)
    {
        if (path.Hops.Count == 0 || path.PointCount * GroundMetersPerPoint < path.Meters)
            return false;

        var speeds = path.Hops.Select(h => h.Kmh).ToList();
        speeds.Sort();
        var rank = (int)Math.Ceiling(GroundSpeedPercentile * speeds.Count) - 1;
        return speeds[Math.Clamp(rank, 0, speeds.Count - 1)] <= o.TrainMaxKmh;
    }

    // ---- matching --------------------------------------------------------------------------------------------------

    /// <summary>
    /// The lines of <paramref name="kind"/> within <see cref="SearchMeters"/> of every sample of the path, or null when a tile of
    /// them is not cached; the tiles that are not are then added to <paramref name="missing"/>.
    /// </summary>
    private static TransitLineIndex? Lines(TransitPath path, TransitKind kind, DetectionOptions o, ITransitLineSource source, List<TransitTile> missing)
    {
        var found = new List<KeyValuePair<TransitTile, TransitLines>>();
        var notCached = new List<TransitTile>();
        foreach (var (lat, lon) in path.Tiles(SearchMeters(o)))
        {
            var tile = new TransitTile(kind, lat, lon);
            if (source.TryGetLines(tile, out var lines))
                found.Add(new(tile, lines));
            else
                notCached.Add(tile);
        }

        if (notCached.Count > 0)
        {
            missing.AddRange(notCached);
            return null;
        }
        return new TransitLineIndex(kind, found);
    }

    /// <summary>
    /// How much of the path is near the lines: each hop counts its length times the share of its samples within
    /// <c>max(TransitNearMeters, min(accuracy, 75 m))</c> of a line, where the accuracy is the worse one the hop's two points report
    /// (none counts as 0). With <paramref name="tunnels"/>, a tunnel hop counts in full.
    /// </summary>
    private static LineMatch MatchLines(TransitPath path, TransitLineIndex lines, DetectionOptions o, bool tunnels)
    {
        var matched = 0.0;
        var tunnelMeters = 0.0;
        var samples = path.Samples;
        for (var h = 0; h < path.Hops.Count; h++)
        {
            var hop = path.Hops[h];
            if (tunnels && IsTunnelLength(hop, o)
                && lines.IsWithin(samples[hop.FirstSample], o.TunnelEndMeters)
                && lines.IsWithin(samples[hop.FirstSample + hop.SampleCount - 1], o.TunnelEndMeters))
            {
                matched += hop.Meters;
                tunnelMeters += hop.Meters;
                continue;
            }

            var near = Math.Max(o.TransitNearMeters, Math.Min(hop.AccuracyMeters, AccuracyCapMeters));
            var count = 0;
            for (var s = hop.FirstSample; s < hop.FirstSample + hop.SampleCount; s++)
            {
                if (lines.IsWithin(samples[s], near))
                    count++;
            }
            matched += hop.Meters * count / hop.SampleCount;
        }
        return new LineMatch(matched, tunnelMeters, path.Meters > 0 ? matched / path.Meters : 0);
    }

    /// <summary>A hop long enough for a tunnel, at a speed a train goes through one; whether its ends are at a railway is apart.</summary>
    private static bool IsTunnelLength(Hop hop, DetectionOptions o)
        => hop.Meters >= o.TunnelMinMeters && hop.Kmh >= TunnelMinKmh && hop.Kmh <= o.TrainMaxKmh;

    private readonly record struct LineMatch(double Meters, double TunnelMeters, double Share);

    /// <summary>
    /// One step of the path, between two consecutive points: its length, implied speed (infinite for a step that takes no time)
    /// and worse reported accuracy, and where its samples are in <see cref="TransitPath.Samples"/>.
    /// </summary>
    private readonly record struct Hop(GeoPoint From, GeoPoint To, double Meters, double Kmh, double AccuracyMeters, int FirstSample, int SampleCount);

    /// <summary>
    /// A move's path as the rules see it: the hops between its points in time order, leaving out those of no length, and their
    /// samples every <see cref="SampleMeters"/>, both ends included (a point between two hops is a sample of each). Samples are
    /// worked out when first needed.
    /// </summary>
    private sealed class TransitPath
    {
        private GeoPoint[]? _samples;
        private List<(int Lat, int Lon)>? _tiles;
        private double _tilesMeters = double.NaN;

        public TransitPath(IReadOnlyList<TrackPoint> points)
        {
            PointCount = points.Count;
            var hops = new List<Hop>(Math.Max(0, points.Count - 1));
            var first = 0;
            for (var k = 1; k < points.Count; k++)
            {
                var from = points[k - 1].Position;
                var to = points[k].Position;
                var meters = Geo.DistanceMeters(from, to);
                if (!(meters > 0))
                    continue; // no length (or not a position): left out

                var seconds = (points[k].TimeUtc - points[k - 1].TimeUtc).TotalSeconds;
                var kmh = seconds > 0 ? meters / seconds * KmhPerMps : double.PositiveInfinity;
                var accuracy = Math.Max(Accuracy(points[k - 1]), Accuracy(points[k]));
                var count = (int)Math.Ceiling(meters / SampleMeters) + 1;
                hops.Add(new Hop(from, to, meters, kmh, accuracy, first, count));
                first += count;
                Meters += meters;
            }
            Hops = hops;
            SampleTotal = first;
        }

        public int PointCount { get; }

        /// <summary>The length of the path: the sum of its hops.</summary>
        public double Meters { get; }

        public IReadOnlyList<Hop> Hops { get; }

        private int SampleTotal { get; }

        public GeoPoint[] Samples => _samples ??= Sample();

        /// <summary>The tiles (latitude and longitude index) within <paramref name="meters"/> of any sample, in order.</summary>
        public List<(int Lat, int Lon)> Tiles(double meters)
        {
            if (_tiles is null || _tilesMeters != meters)
            {
                _tiles = [.. TransitTile.Near(TransitKind.Rail, Samples, meters).Select(t => (t.LatIndex, t.LonIndex))];
                _tilesMeters = meters;
            }
            return _tiles;
        }

        private GeoPoint[] Sample()
        {
            var samples = new GeoPoint[SampleTotal];
            foreach (var hop in Hops)
            {
                // Straight in latitude and longitude, the short way round: at 25 m steps that is the great circle to millimetres.
                var dLat = hop.To.Latitude - hop.From.Latitude;
                var dLon = Math.IEEERemainder(hop.To.Longitude - hop.From.Longitude, 360);
                var steps = hop.SampleCount - 1;
                for (var j = 0; j <= steps; j++)
                {
                    samples[hop.FirstSample + j] = j == 0 ? hop.From : j == steps ? hop.To : new GeoPoint(
                        hop.From.Latitude + dLat * j / steps,
                        Geo.NormalizeLongitude(hop.From.Longitude + dLon * j / steps));
                }
            }
            return samples;
        }

        private static double Accuracy(TrackPoint p)
            => p.AccuracyMeters is { } m && double.IsFinite(m) && m > 0 ? m : 0;
    }
}
