using Sporer.Timeline;

namespace Sporer.SyntheticData;

/// <summary>
/// A person carrying a phone: it knows where the person is and what time it is, moves them along a line or keeps them
/// still, and logs what Overland would log. While still it logs sparsely (a point on arrival, now and then a stray one,
/// then silence until they set off), while moving it logs every <c>--moving-interval</c>. GPS error drifts slowly (it
/// is correlated over about 25 s, so slow walking is not mistaken for fast), now and then a fix is far off (a spike),
/// and the phone can be off for a while (no fixes at all).
/// </summary>
internal sealed class Phone
{
    private const double MetersPerDegree = 111_194.93;
    private const double SpikeChance = 1.0 / 6000;
    private const double NoiseCorrelationSeconds = 25;

    private static readonly string[] Stationary = ["stationary"];
    private static readonly Dictionary<string, string[]> MotionArrays =
        new[] { "walking", "running", "cycling", "driving" }.ToDictionary(m => m, m => new[] { m });

    private enum Kind { Still, Move, Air }

    private readonly Rng _rng;
    private readonly Action<Fix> _sink;
    private readonly TimeSpan _step;
    private readonly long _granule;
    private readonly DateTime _end;
    private readonly DateTime _accuracyFrom;
    private readonly List<(DateTime From, DateTime To)> _off = [];

    private DateTime _last = DateTime.MinValue;
    private DateTime _noiseAt = DateTime.MinValue;
    private double _noiseNorth;
    private double _noiseEast;

    public Phone(Rng rng, Action<Fix> sink, TimeSpan movingInterval, DateTime endUtc)
    {
        _rng = rng;
        _sink = sink;
        _step = movingInterval;
        // Times are whole seconds, like Overland's, unless the interval is finer than that.
        _granule = movingInterval.Ticks % TimeSpan.TicksPerSecond == 0 ? TimeSpan.TicksPerSecond : TimeSpan.TicksPerMillisecond;
        _end = endUtc;
        _accuracyFrom = endUtc - SimulatorOptions.AccuracyWindow;
    }

    /// <summary>The time now. Moves only forward; set it to make time pass.</summary>
    public DateTime Now { get; set; }

    /// <summary>Where the person is (the true position, without GPS error).</summary>
    public GeoPoint Here { get; set; }

    /// <summary>True once the end of the history is reached: nothing more is logged.</summary>
    public bool Finished { get; private set; }

    /// <summary>The phone logs nothing from <paramref name="from"/> to <paramref name="to"/>.</summary>
    public void SwitchOff(DateTime from, DateTime to) => _off.Add((from, to));

    /// <summary>A spot near <paramref name="place"/>: nobody parks or stands in exactly the same place twice.</summary>
    public GeoPoint Spot(GeoPoint place, double sigmaMeters = 8)
    {
        var (n, e) = _rng.Gauss2();
        return Offset(place, n * sigmaMeters, e * sigmaMeters);
    }

    /// <summary>A fix where the person is, at the current time.</summary>
    public void LogHere() => Emit(Kind.Still, Here, 0, null);

    // ---- keeping still -----------------------------------------------------------------------------------------

    /// <summary>
    /// Time passes until <paramref name="until"/> with the person where they are. Mostly nothing is logged; some long
    /// stays log a stray fix now and then, and a few have a spell of bad GPS some 50-95 m off (inside the stay radius).
    /// </summary>
    public void StayUntil(DateTime until)
    {
        if (Finished || until <= Now)
            return;

        var span = until - Now;
        var strays = new List<DateTime>();
        if (span >= TimeSpan.FromMinutes(90) && _rng.Chance(0.35))
        {
            for (var t = Now + Minutes(25, 80); t < until - TimeSpan.FromMinutes(15); t += Minutes(25, 80))
                strays.Add(t);
        }

        DateTime? drift = span >= TimeSpan.FromHours(3) && _rng.Chance(0.05)
            ? Now + TimeSpan.FromMinutes(_rng.Uniform(60, span.TotalMinutes - 60))
            : null;

        foreach (var t in strays)
        {
            if (drift is { } at && at < t)
            {
                Drift(at);
                drift = null;
            }
            Now = t;
            LogHere();
        }
        if (drift is { } last)
            Drift(last);

        Now = until;
    }

    /// <summary>The person stays where they are for <paramref name="duration"/>.</summary>
    public void StayFor(TimeSpan duration) => StayUntil(Now + duration);

    private void Drift(DateTime at)
    {
        var angle = _rng.Uniform(0, 2 * Math.PI);
        var distance = _rng.Uniform(50, 95);
        var away = Offset(Here, distance * Math.Cos(angle), distance * Math.Sin(angle));
        var fixes = 8 + _rng.Next(8);
        for (var k = 0; k < fixes; k++)
        {
            Now = at + TimeSpan.FromSeconds(12 * k);
            Emit(Kind.Still, away, 0, null);
        }
    }

    // ---- moving ------------------------------------------------------------------------------------------------

    /// <summary>
    /// The person walks, rides or drives along <paramref name="route"/> from its first point to its last, in the way
    /// <paramref name="gait"/> says, and a fix is logged every <c>--moving-interval</c> (and on arrival). Speed settles
    /// towards a target that changes every 20-60 s; some targets are a stop.
    /// </summary>
    public void Travel(IReadOnlyList<GeoPoint> route, Gait gait)
    {
        var cumulative = new double[route.Count];
        for (var k = 1; k < route.Count; k++)
            cumulative[k] = cumulative[k - 1] + Geo.DistanceMeters(route[k - 1], route[k]);
        var length = cumulative[^1];
        Here = route[0];
        if (length < 1 || Finished)
        {
            Here = route[^1];
            return;
        }

        var seconds = _step.TotalSeconds;
        double travelled = 0, speed = 0, elapsed = 0, phaseEnds = 0, target = 0;
        var segment = 0;

        Emit(Kind.Move, route[0], 0, gait.Motion);
        while (!Finished)
        {
            if (elapsed >= phaseEnds)
            {
                var nearEnds = travelled < 30 || length - travelled < 60;
                if (!nearEnds && _rng.Chance(gait.StopChance))
                {
                    target = 0;
                    phaseEnds = elapsed + _rng.Uniform(gait.StopMin, gait.StopMax);
                }
                else
                {
                    target = gait.Speed * _rng.Uniform(1 - gait.Spread, 1 + gait.Spread / 2);
                    phaseEnds = elapsed + _rng.Uniform(20, 60);
                }
            }

            speed += (target - speed) * (1 - Math.Exp(-seconds / (target >= speed ? 4.0 : 2.0)));
            var advance = speed * seconds;
            if (travelled + advance >= length)
            {
                // Arrived between two steps: the last fix is on the spot, when the person gets there.
                Now += TimeSpan.FromSeconds((length - travelled) / Math.Max(speed, 0.6));
                Emit(Kind.Move, route[^1], speed, gait.Motion);
                break;
            }

            travelled += advance;
            elapsed += seconds;
            Now += _step;
            while (segment < route.Count - 2 && cumulative[segment + 1] < travelled)
                segment++;
            var share = (travelled - cumulative[segment]) / Math.Max(1e-9, cumulative[segment + 1] - cumulative[segment]);
            var from = route[segment];
            var to = route[segment + 1];
            Emit(Kind.Move, new GeoPoint(from.Latitude + (to.Latitude - from.Latitude) * share, from.Longitude + (to.Longitude - from.Longitude) * share),
                speed, gait.Motion);
        }

        Here = route[^1];
    }

    /// <summary>
    /// A flight from where the person is to <paramref name="to"/> at <paramref name="cruiseMetersPerSecond"/>, plus
    /// 40 minutes for taxiing and climbing. A phone in flight mode logs little: when <paramref name="logInFlight"/> is
    /// set it still gets a fix now and then on the great circle, otherwise nothing between take-off and landing.
    /// </summary>
    public void Fly(GeoPoint to, double cruiseMetersPerSecond, bool logInFlight)
    {
        if (Finished)
            return;

        var from = Here;
        var distance = Geo.DistanceMeters(from, to);
        var total = TimeSpan.FromSeconds(distance / cruiseMetersPerSecond + 40 * 60);
        var takeOff = Now;
        var airborne = total - TimeSpan.FromMinutes(40);

        Emit(Kind.Still, from, 0, null);
        if (logInFlight)
        {
            for (var t = takeOff + Minutes(10, 25); t < takeOff + total - TimeSpan.FromMinutes(10); t += Minutes(10, 25))
            {
                var share = Math.Clamp((t - takeOff - TimeSpan.FromMinutes(20)) / airborne, 0, 1);
                Now = t;
                Emit(Kind.Air, Geo.Interpolate(from, to, share), cruiseMetersPerSecond, "driving");
            }
        }

        Now = takeOff + total;
        Here = to;
        Emit(Kind.Still, to, 0, null);
    }

    // ---- the fix -----------------------------------------------------------------------------------------------

    private void Emit(Kind kind, GeoPoint truth, double speed, string? motion)
    {
        var time = new DateTime(Now.Ticks / _granule * _granule, DateTimeKind.Utc);
        if (time >= _end)
        {
            Finished = true;
            return;
        }
        if (time <= _last)
            return;
        _last = time;
        if (IsOff(time))
            return;

        // GPS error: an Ornstein-Uhlenbeck drift in metres north and east.
        var sigma = kind switch { Kind.Move => 3.5, Kind.Air => 25.0, _ => 9.0 };
        var decay = Math.Exp(-(time - _noiseAt).TotalSeconds / NoiseCorrelationSeconds);
        var amplitude = sigma * Math.Sqrt(1 - decay * decay);
        var (gaussNorth, gaussEast) = _rng.Gauss2();
        _noiseNorth = _noiseNorth * decay + amplitude * gaussNorth;
        _noiseEast = _noiseEast * decay + amplitude * gaussEast;
        _noiseAt = time;
        double north = _noiseNorth, east = _noiseEast;

        // A spike: one fix far from where the person is, 1.5 to 15 km, which the next fix is not.
        if (kind == Kind.Move && _rng.Chance(SpikeChance))
        {
            var angle = _rng.Uniform(0, 2 * Math.PI);
            var distance = _rng.Uniform(1500, 15000);
            north += distance * Math.Cos(angle);
            east += distance * Math.Sin(angle);
        }

        double? accuracy = null;
        string[]? motionValues = null;
        if (time >= _accuracyFrom)
        {
            var roll = _rng.NextDouble();
            if (roll < 0.007)
            {
                // A poor fix says so: worse than the server's 100 m cut, and off by about that much.
                accuracy = Math.Round(_rng.Uniform(120, 400), 1);
                var (poorNorth, poorEast) = _rng.Gauss2();
                north += poorNorth * accuracy.Value * 0.5;
                east += poorEast * accuracy.Value * 0.5;
            }
            else
            {
                accuracy = Math.Round(roll < 0.04 ? _rng.Uniform(30, 90) : _rng.Uniform(3, 16), 1);
            }

            motionValues = kind == Kind.Still || speed < 0.3 ? Stationary : MotionArrays[motion ?? "walking"];
        }

        var position = Offset(truth, north, east);
        double? reportedSpeed = kind == Kind.Still ? 0 : _rng.Chance(0.03) ? null : Math.Round(Math.Max(0, speed + 0.25 * _rng.Gauss()), 2);
        var altitude = kind == Kind.Air
            ? 10500 + 80 * _rng.Gauss()
            : 20 + 12 * Math.Sin(truth.Latitude * 50) + 8 * Math.Cos(truth.Longitude * 70) + 1.2 * _rng.Gauss();

        _sink(new Fix(
            time, Math.Round(position.Latitude, 6), Math.Round(position.Longitude, 6), reportedSpeed,
            Math.Round(altitude, 1), accuracy, motionValues));
    }

    private bool IsOff(DateTime time)
    {
        foreach (var (from, to) in _off)
        {
            if (time >= from && time < to)
                return true;
        }
        return false;
    }

    private TimeSpan Minutes(double low, double high) => TimeSpan.FromMinutes(_rng.Uniform(low, high));

    private static GeoPoint Offset(GeoPoint from, double northMeters, double eastMeters)
        => new(from.Latitude + northMeters / MetersPerDegree,
               from.Longitude + eastMeters / (MetersPerDegree * Math.Cos(from.Latitude * Math.PI / 180)));
}
