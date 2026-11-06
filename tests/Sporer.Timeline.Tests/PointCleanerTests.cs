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

    // ---- Classify: which points the cleaning ignores, and why --------------------------------------------------------------

    [Fact]
    public void Classify_says_used_for_a_clean_track()
        => Assert.Equal([PointStatus.Used, PointStatus.Used, PointStatus.Used], PointCleaner.Classify([Pt(0, 5), Pt(10), Pt(20, 100)], new()));

    [Fact]
    public void Classify_calls_a_repeat_of_device_and_time_a_duplicate_and_the_first_used()
        => Assert.Equal(
            [PointStatus.Used, PointStatus.Used, PointStatus.Duplicate, PointStatus.Duplicate],
            PointCleaner.Classify([Pt(0), Pt(10), Pt(0), Pt(10)], new()));

    [Fact]
    public void Classify_calls_a_bad_accuracy_poor_and_keeps_unknown()
        => Assert.Equal(
            [PointStatus.Used, PointStatus.PoorAccuracy, PointStatus.PoorAccuracy, PointStatus.Used, PointStatus.Used],
            PointCleaner.Classify([Pt(0, 40), Pt(10, 250), Pt(20, -1), Pt(30, null), Pt(40, 100)], new()));

    [Fact]
    public void Classify_calls_a_duplicate_that_also_has_poor_accuracy_a_duplicate()
        => Assert.Equal(
            [PointStatus.Used, PointStatus.Duplicate],
            PointCleaner.Classify([Pt(0, 10), Pt(0, 500)], new()));

    [Fact]
    public void Classify_calls_a_poor_first_of_a_pair_poor_and_the_repeat_a_duplicate()
        => Assert.Equal(
            [PointStatus.PoorAccuracy, PointStatus.Duplicate],
            PointCleaner.Classify([Pt(0, 500), Pt(0, 10)], new()));

    [Fact]
    public void Classify_calls_an_out_and_back_spike_a_glitch_in_input_order()
    {
        var t = new TrackBuilder(T0, Spots.Home).Stay(TimeSpan.FromMinutes(2), Every10s).Spike(5_000)
                                                .Stay(TimeSpan.FromMinutes(2), Every10s).Build();
        var status = PointCleaner.Classify(t, new());

        Assert.Equal(t.Count, status.Count);
        var glitch = Assert.Single(Enumerable.Range(0, t.Count), i => status[i] == PointStatus.Glitch);
        Assert.True(Geo.DistanceMeters(t[glitch].Position, Spots.Home) > 1_000);
        Assert.All(Enumerable.Range(0, t.Count).Where(i => i != glitch), i => Assert.Equal(PointStatus.Used, status[i]));
    }

    [Fact] // a glitch is judged among the points that pass the first two rules: a poor fix between does not hide it
    public void Classify_judges_a_glitch_among_the_points_that_are_neither_poor_nor_repeats()
    {
        var home = new TrackBuilder(T0, Spots.Home).Stay(TimeSpan.FromMinutes(1), Every10s).Build();
        var far = new TrackPoint(home[^1].TimeUtc.AddSeconds(10), "phone", Spots.Lisbon.Latitude, Spots.Lisbon.Longitude, null, null, null);
        var poor = Pt(0, 500) with { TimeUtc = far.TimeUtc.AddSeconds(5) };
        var back = new TrackPoint(far.TimeUtc.AddSeconds(10), "phone", Spots.Home.Latitude, Spots.Home.Longitude, null, null, null);
        List<TrackPoint> t = [.. home, far, poor, back, back with { TimeUtc = back.TimeUtc.AddSeconds(10) }];

        var status = PointCleaner.Classify(t, new());

        Assert.Equal(PointStatus.Glitch, status[home.Count]);
        Assert.Equal(PointStatus.PoorAccuracy, status[home.Count + 1]);
    }

    [Fact] // the order of the answer is the order of the input, whatever the times
    public void Classify_answers_in_input_order()
        => Assert.Equal(
            [PointStatus.Used, PointStatus.PoorAccuracy, PointStatus.Used],
            PointCleaner.Classify([Pt(20), Pt(0, 250), Pt(10)], new()));

    [Fact]
    public void Clean_is_the_used_points_sorted_by_time()
    {
        var t = new TrackBuilder(T0, Spots.Home).Stay(TimeSpan.FromMinutes(1), Every10s).Spike(5_000)
                                                .Stay(TimeSpan.FromMinutes(1), Every10s).Build();
        List<TrackPoint> input = [.. t.AsEnumerable().Reverse(), Pt(0, 500), t[3]];

        var status = PointCleaner.Classify(input, new());

        Assert.Equal(
            input.Where((_, i) => status[i] == PointStatus.Used).OrderBy(p => p.TimeUtc),
            PointCleaner.Clean(input, new()));
    }
}
