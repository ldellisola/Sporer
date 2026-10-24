using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class PointCleanerTests
{
    private static readonly DateTime T0 = new(2026, 10, 23, 8, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);

    private static TrackPoint Pt(int seconds, double? accuracy = null, string device = "phone")
        => new(T0.AddSeconds(seconds), device, Spots.Home.Latitude, Spots.Home.Longitude, null, accuracy, null);

    [Fact]
    public void Removes_duplicates()
    {
        var p = Pt(0);
        var c = PointCleaner.Clean([p, Pt(10), p, Pt(10)], new());

        Assert.Equal([T0, T0.AddSeconds(10)], c.Select(x => x.TimeUtc));
    }

    [Fact]
    public void Keeps_points_with_the_same_time_from_different_devices()
    {
        var c = PointCleaner.Clean([Pt(0, device: "phone"), Pt(0, device: "watch")], new());

        Assert.Equal(["phone", "watch"], c.Select(x => x.Device));
    }

    [Fact]
    public void Drops_inaccurate_points_keeps_unknown()
    {
        var c = PointCleaner.Clean([Pt(0, 40), Pt(10, 250), Pt(20, null), Pt(30, 40)], new());

        Assert.Equal([T0, T0.AddSeconds(20), T0.AddSeconds(30)], c.Select(x => x.TimeUtc));
        Assert.Equal([40, null, 40], c.Select(x => x.AccuracyMeters));
    }

    [Fact]
    public void Keeps_a_point_exactly_at_the_accuracy_limit()
    {
        var c = PointCleaner.Clean([Pt(0, 100), Pt(10, 100.5)], new());

        Assert.Equal(100, Assert.Single(c).AccuracyMeters);
    }

    [Fact] // iOS reports -1 for an invalid fix and ingest stores the raw value
    public void Drops_negative_accuracy_as_an_invalid_fix()
    {
        var c = PointCleaner.Clean([Pt(0, 40), Pt(10, -1), Pt(20, null), Pt(30, 0)], new());

        Assert.Equal([40, null, 0], c.Select(x => x.AccuracyMeters));
    }

    [Fact]
    public void Honours_a_configured_accuracy_limit()
    {
        var c = PointCleaner.Clean([Pt(0, 40), Pt(10, 60)], new() { MaxAccuracyMeters = 50 });

        Assert.Equal(40, Assert.Single(c).AccuracyMeters);
    }

    [Fact]
    public void Drops_out_and_back_spike()
    {
        var t = new TrackBuilder(T0, Spots.Home).Stay(TimeSpan.FromMinutes(2), Every10s).Spike(5_000)
                                                .Stay(TimeSpan.FromMinutes(2), Every10s).Build();
        var c = PointCleaner.Clean(t, new());

        Assert.Equal(t.Count - 1, c.Count);
        Assert.All(c, p => Assert.True(Geo.DistanceMeters(p.Position, Spots.Home) < 50));
    }

    [Fact]
    public void Keeps_sustained_high_speed()
    {
        var t = new TrackBuilder(T0, Spots.Home).Travel(Spots.Lisbon, 800, TimeSpan.FromMinutes(1)).Build();
        var c = PointCleaner.Clean(t, new());

        Assert.True(t.Count > 100);
        Assert.Equal(t.Count, c.Count);
    }

    [Fact] // a real jump to somewhere else is not out-and-back: the track carries on from the new place
    public void Keeps_a_one_way_jump()
    {
        var t = new TrackBuilder(T0, Spots.Home).Stay(TimeSpan.FromMinutes(1), Every10s)
                                                .Teleport(Spots.Lisbon, Every10s).Stay(TimeSpan.FromMinutes(1), Every10s).Build();
        var c = PointCleaner.Clean(t, new());

        Assert.Equal(t.Count, c.Count);
    }

    [Fact] // 500 m out and back in 10 s each way is 180 km/h, under the 300 km/h glitch speed
    public void Keeps_an_out_and_back_below_the_glitch_speed()
    {
        var t = new TrackBuilder(T0, Spots.Home).Stay(TimeSpan.FromMinutes(1), Every10s).Spike(500)
                                                .Stay(TimeSpan.FromMinutes(1), Every10s).Build();
        var c = PointCleaner.Clean(t, new());

        Assert.Equal(t.Count, c.Count);
    }

    [Fact] // the first and last points have only one neighbour, so they are never glitch candidates
    public void Never_drops_the_first_or_last_point_as_a_glitch()
    {
        var home = new TrackBuilder(T0, Spots.Home).Stay(TimeSpan.FromMinutes(1), Every10s).Build();
        var far = new TrackPoint(T0.AddSeconds(-10), "phone", Spots.Lisbon.Latitude, Spots.Lisbon.Longitude, null, null, null);
        var farLast = far with { TimeUtc = home[^1].TimeUtc.AddSeconds(10) };
        var c = PointCleaner.Clean([far, .. home, farLast], new());

        Assert.Equal(home.Count + 2, c.Count);
    }

    [Fact]
    public void Drops_each_of_two_separate_spikes()
    {
        var t = new TrackBuilder(T0, Spots.Home).Stay(TimeSpan.FromMinutes(1), Every10s).Spike(5_000)
                                                .Stay(TimeSpan.FromMinutes(1), Every10s).Spike(8_000)
                                                .Stay(TimeSpan.FromMinutes(1), Every10s).Build();
        var c = PointCleaner.Clean(t, new());

        Assert.Equal(t.Count - 2, c.Count);
        Assert.All(c, p => Assert.True(Geo.DistanceMeters(p.Position, Spots.Home) < 50));
    }

    [Fact]
    public void Honours_a_configured_glitch_speed()
    {
        var t = new TrackBuilder(T0, Spots.Home).Stay(TimeSpan.FromMinutes(1), Every10s).Spike(500)
                                                .Stay(TimeSpan.FromMinutes(1), Every10s).Build();
        var c = PointCleaner.Clean(t, new() { GlitchSpeedKmh = 100 });

        Assert.Equal(t.Count - 1, c.Count);
    }

    [Fact]
    public void Merges_devices_in_time_order()
    {
        var phone = new TrackBuilder(T0, Spots.Home, "phone").Stay(TimeSpan.FromMinutes(1), TimeSpan.FromSeconds(20)).Build();
        var watch = new TrackBuilder(T0.AddSeconds(10), Spots.Home, "watch").Stay(TimeSpan.FromMinutes(1), TimeSpan.FromSeconds(20)).Build();

        var c = PointCleaner.Clean([.. watch, .. phone], new());

        Assert.Equal(phone.Count + watch.Count, c.Count);
        Assert.Equal(c.OrderBy(p => p.TimeUtc).ToList(), c);
        Assert.Equal(["phone", "watch"], c.Take(2).Select(p => p.Device));
        Assert.Equal(["phone", "watch"], c.Skip(2).Take(2).Select(p => p.Device));
    }

    [Fact]
    public void Empty_input_gives_an_empty_result()
        => Assert.Empty(PointCleaner.Clean([], new()));

    [Fact]
    public void Does_not_modify_the_input()
    {
        var input = new List<TrackPoint> { Pt(20), Pt(0, 250), Pt(0, 250), Pt(10) };
        var before = input.ToList();

        PointCleaner.Clean(input, new());

        Assert.Equal(before, input);
    }
}
