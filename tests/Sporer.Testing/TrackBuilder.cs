using Sporer.Timeline;

namespace Sporer.Testing;

/// <summary>
/// Builds synthetic tracks for tests. The builder keeps a cursor (<see cref="Now"/>, <see cref="Here"/>) that starts
/// at the given time and place, where the first point is logged. Every step then logs points strictly after the cursor
/// and moves it on, so no two steps ever log the same timestamp. <see cref="WithAccuracy"/> and <see cref="WithMotion"/>
/// apply to the points logged after they are called; speed is always unknown (null).
/// </summary>
public sealed class TrackBuilder
{
    private static readonly TimeSpan SpikeDelay = TimeSpan.FromSeconds(10);

    private readonly List<TrackPoint> _points = [];
    private readonly string _device;
    private double? _accuracy;
    private string[]? _motion;

    public TrackBuilder(DateTime startUtc, GeoPoint start, string device = "phone")
    {
        Now = DateTime.SpecifyKind(startUtc, DateTimeKind.Utc);
        Here = start;
        _device = device;
        Log(Here);
    }

    /// <summary>The time the next step starts from.</summary>
    public DateTime Now { get; private set; }

    /// <summary>The position the next step starts from.</summary>
    public GeoPoint Here { get; private set; }

    /// <summary>Stay put for <paramref name="duration"/>, logging a point every <paramref name="every"/>.</summary>
    public TrackBuilder Stay(TimeSpan duration, TimeSpan every)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(duration, TimeSpan.Zero);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(every, TimeSpan.Zero);
        var start = Now;
        for (var k = 1; k * every.Ticks <= duration.Ticks; k++)
            Log(Here, start + k * every);
        Now = start + duration;
        return this;
    }

    /// <summary>
    /// Move in a straight (great-circle) line to <paramref name="to"/> at a constant <paramref name="kmh"/>, logging a
    /// point every <paramref name="every"/> and a final point on the target if the arrival falls between two logs.
    /// </summary>
    public TrackBuilder Travel(GeoPoint to, double kmh, TimeSpan every)
    {
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(kmh, 0);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(every, TimeSpan.Zero);
        var start = Now;
        var from = Here;
        // Whole milliseconds, so arrival times are clean (600 s, not 599.9999981 s) and a 1 km walk at 6 km/h logged
        // every 10 s is exactly 60 steps.
        var seconds = Geo.DistanceMeters(from, to) / (kmh / 3.6);
        var duration = TimeSpan.FromMilliseconds(Math.Round(seconds * 1000));
        var steps = (long)(duration / every);
        for (var k = 1; k <= steps; k++)
        {
            var elapsed = k * every;
            Log(Geo.Interpolate(from, to, elapsed / duration), start + elapsed);
        }
        if (duration > steps * every)
            Log(to, start + duration);
        Now = start + duration;
        Here = to;
        return this;
    }

    /// <summary>Time passes and nothing is logged (phone off, no signal).</summary>
    public TrackBuilder Silence(TimeSpan duration)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(duration, TimeSpan.Zero);
        Now += duration;
        return this;
    }

    /// <summary>One point at <paramref name="to"/>, <paramref name="after"/> the previous step: a jump across a gap.</summary>
    public TrackBuilder Teleport(GeoPoint to, TimeSpan after)
    {
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(after, TimeSpan.Zero);
        Now += after;
        Here = to;
        Log(Here);
        return this;
    }

    /// <summary>
    /// One bad fix <paramref name="metersEast"/> metres east of here, 10 s later. The track is not moved: the next
    /// point resumes at the position held before the spike.
    /// </summary>
    public TrackBuilder Spike(double metersEast)
    {
        Now += SpikeDelay;
        Log(Geo.Offset(Here, 0, metersEast));
        return this;
    }

    /// <summary>Horizontal accuracy (metres) for the points logged from now on; null means unreported.</summary>
    public TrackBuilder WithAccuracy(double? m)
    {
        _accuracy = m;
        return this;
    }

    /// <summary>Overland motion values for the points logged from now on; no values clears it.</summary>
    public TrackBuilder WithMotion(params string[] m)
    {
        _motion = m.Length == 0 ? null : m;
        return this;
    }

    /// <summary>A copy of the points logged so far, in time order.</summary>
    public List<TrackPoint> Build() => [.. _points];

    private void Log(GeoPoint at) => Log(at, Now);

    private void Log(GeoPoint at, DateTime time)
        => _points.Add(new TrackPoint(time, _device, at.Latitude, at.Longitude, null, _accuracy, _motion));
}
