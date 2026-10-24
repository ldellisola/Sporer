using Sporer.Testing;

namespace Sporer.Timeline.Tests;

public class TrackBuilderTests
{
    private static readonly DateTime T0 = new(2026, 10, 23, 8, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);

    [Fact] // Travel 1 km at 6 km/h every 10 s: the start point plus 60 steps, the last one on the target
    public void Travel_spacing_matches_speed()
    {
        var target = Geo.Offset(Spots.Home, 1_000, 0);
        var track = new TrackBuilder(T0, Spots.Home).Travel(target, 6, Every10s).Build();

        Assert.Equal(61, track.Count);
        Assert.True(Geo.DistanceMeters(track[^1].Position, target) < 1);
        Assert.Equal(T0 + TimeSpan.FromMinutes(10), track[^1].TimeUtc);
        Assert.All(track.Zip(track.Skip(1)), p =>
        {
            Assert.Equal(Every10s, p.Second.TimeUtc - p.First.TimeUtc);
            Assert.Equal(6 / 3.6 * 10, Geo.DistanceMeters(p.First.Position, p.Second.Position), 0);
        });
    }

    [Fact]
    public void Travel_ends_with_a_point_on_the_target_when_the_duration_is_not_a_multiple_of_every()
    {
        var target = Geo.Offset(Spots.Home, 0, 1_000);
        var b = new TrackBuilder(T0, Spots.Home).Travel(target, 6, TimeSpan.FromSeconds(7));
        var track = b.Build();

        Assert.True(Geo.DistanceMeters(track[^1].Position, target) < 1);
        Assert.Equal(T0 + TimeSpan.FromMinutes(10), track[^1].TimeUtc);
        Assert.Equal(track[^1].TimeUtc, b.Now);
        Assert.Equal(target, b.Here);
    }

    [Fact]
    public void Travel_over_a_long_distance_follows_the_great_circle_at_constant_speed()
    {
        var track = new TrackBuilder(T0, Spots.Home).Travel(Spots.Lisbon, 800, TimeSpan.FromMinutes(1)).Build();

        Assert.True(Geo.DistanceMeters(track[^1].Position, Spots.Lisbon) < 1);
        var step = 800_000.0 / 60;
        Assert.All(track.Zip(track.Skip(1)).SkipLast(1),
            p => Assert.Equal(step, Geo.DistanceMeters(p.First.Position, p.Second.Position), 0));
    }

    [Fact]
    public void Stay_logs_points_at_the_start_and_every_interval_without_moving()
    {
        var b = new TrackBuilder(T0, Spots.Home).Stay(TimeSpan.FromMinutes(2), Every10s);
        var track = b.Build();

        Assert.Equal(13, track.Count);
        Assert.Equal(T0, track[0].TimeUtc);
        Assert.Equal(T0 + TimeSpan.FromMinutes(2), track[^1].TimeUtc);
        Assert.All(track, p => Assert.Equal(Spots.Home, p.Position));
        Assert.Equal(T0 + TimeSpan.FromMinutes(2), b.Now);
        Assert.Equal(Spots.Home, b.Here);
    }

    [Fact]
    public void Consecutive_stays_never_repeat_a_timestamp()
    {
        var track = new TrackBuilder(T0, Spots.Home)
            .Stay(TimeSpan.FromMinutes(1), Every10s)
            .Stay(TimeSpan.FromMinutes(1), Every10s)
            .Build();

        Assert.Equal(13, track.Count);
        Assert.Equal(track.Count, track.Select(p => p.TimeUtc).Distinct().Count());
    }

    [Fact]
    public void Silence_advances_time_without_points()
    {
        var b = new TrackBuilder(T0, Spots.Home).Silence(TimeSpan.FromHours(9)).Stay(TimeSpan.FromSeconds(20), Every10s);
        var track = b.Build();

        Assert.Equal(new[] { T0, T0.AddHours(9).AddSeconds(10), T0.AddHours(9).AddSeconds(20) },
            track.Select(p => p.TimeUtc).ToArray());
    }

    [Fact]
    public void Teleport_adds_one_point_after_the_gap_and_moves_the_builder()
    {
        var b = new TrackBuilder(T0, Spots.Home).Teleport(Spots.Lisbon, TimeSpan.FromHours(4));
        var track = b.Build();

        Assert.Equal(2, track.Count);
        Assert.Equal(T0.AddHours(4), track[1].TimeUtc);
        Assert.Equal(Spots.Lisbon, track[1].Position);
        Assert.Equal(Spots.Lisbon, b.Here);
        Assert.Equal(T0.AddHours(4), b.Now);
    }

    [Fact]
    public void Spike_is_one_point_ten_seconds_later_and_the_track_then_resumes_in_place()
    {
        var b = new TrackBuilder(T0, Spots.Home).Spike(5_000).Stay(Every10s, Every10s);
        var track = b.Build();

        Assert.Equal(3, track.Count);
        Assert.Equal(T0.AddSeconds(10), track[1].TimeUtc);
        Assert.Equal(5_000, Geo.DistanceMeters(Spots.Home, track[1].Position), 0);
        Assert.True(track[1].Position.Longitude > Spots.Home.Longitude);
        Assert.Equal(T0.AddSeconds(20), track[2].TimeUtc);
        Assert.Equal(Spots.Home, track[2].Position);
        Assert.Equal(Spots.Home, b.Here);
    }

    [Fact]
    public void Accuracy_and_motion_apply_to_points_added_after_they_are_set()
    {
        var track = new TrackBuilder(T0, Spots.Home)
            .WithAccuracy(250).WithMotion("walking", "stationary")
            .Stay(Every10s, Every10s)
            .WithAccuracy(null).WithMotion()
            .Stay(Every10s, Every10s)
            .Build();

        Assert.Null(track[0].AccuracyMeters);
        Assert.Null(track[0].Motion);
        Assert.Equal(250, track[1].AccuracyMeters);
        Assert.Equal(new[] { "walking", "stationary" }, track[1].Motion);
        Assert.Null(track[2].AccuracyMeters);
        Assert.Null(track[2].Motion);
    }

    [Fact]
    public void Motion_is_copied_so_neither_the_caller_nor_other_points_share_one_array()
    {
        var motion = new[] { "walking" };
        var track = new TrackBuilder(T0, Spots.Home).WithMotion(motion).Stay(Every10s * 2, Every10s).Build();
        motion[0] = "driving";

        Assert.Equal(new[] { "walking" }, track[1].Motion);
        Assert.Equal(new[] { "walking" }, track[2].Motion);
        Assert.NotSame(track[1].Motion, track[2].Motion);
    }

    [Fact]
    public void Points_carry_the_device_and_an_unknown_speed()
    {
        var phone = new TrackBuilder(T0, Spots.Home).Stay(Every10s, Every10s).Build();
        var watch = new TrackBuilder(T0, Spots.Home, "watch").Build();

        Assert.All(phone, p => Assert.Equal("phone", p.Device));
        Assert.All(phone, p => Assert.Null(p.SpeedMps));
        Assert.Equal("watch", Assert.Single(watch).Device);
    }

    [Fact]
    public void Build_returns_an_independent_copy()
    {
        var b = new TrackBuilder(T0, Spots.Home);
        var first = b.Build();
        b.Stay(Every10s, Every10s);

        Assert.Single(first);
        Assert.Equal(2, b.Build().Count);
    }
}
