namespace Sporer.Timeline.Tests;

public class DetectionOptionsTests
{
    [Fact]
    public void Defaults_match_the_spec()
    {
        var o = new DetectionOptions();
        Assert.Equal(100, o.MaxAccuracyMeters);
        Assert.Equal(300, o.GlitchSpeedKmh);
        Assert.Equal(100, o.StayRadiusMeters);
        Assert.Equal(TimeSpan.FromMinutes(5), o.StayMinDuration);
        Assert.Equal(1.0, o.StationaryGapMaxSpeedMps);
        Assert.Equal(1.4, o.WalkingSpeedMps);
        Assert.Equal(TimeSpan.FromMinutes(30), o.GapMinDuration);
        Assert.Equal(200, o.FlightSpeedKmh);
        Assert.Equal(100, o.FlightMinDistanceKm);
        Assert.Equal(7, o.WalkMaxKmh);
        Assert.Equal(25, o.CycleMaxKmh);
        Assert.Equal(75, o.PlaceRadiusMeters);
        Assert.Equal(5, o.DetailToleranceMeters);
        Assert.Equal(50, o.CoarseToleranceMeters);
    }

    [Fact]
    public void Values_can_be_overridden_with_init_syntax()
    {
        var o = new DetectionOptions { StayRadiusMeters = 40, GapMinDuration = TimeSpan.FromMinutes(10) };
        Assert.Equal(40, o.StayRadiusMeters);
        Assert.Equal(TimeSpan.FromMinutes(10), o.GapMinDuration);
        Assert.Equal(100, o.MaxAccuracyMeters);
    }
}
