using Microsoft.Extensions.Configuration;
using Sporer.Api.Configuration;

namespace Sporer.Api.Tests;

public class ProcessingOptionsTests
{
    private static ProcessingOptions Bind(params (string Key, string Value)[] settings) => new ConfigurationBuilder()
        .AddInMemoryCollection(settings.Select(s => new KeyValuePair<string, string?>($"Processing:{s.Key}", s.Value)))
        .Build()
        .GetSection("Processing")
        .Get<ProcessingOptions>() ?? new ProcessingOptions();

    [Fact]
    public void Defaults_are_inside_the_bounds()
    {
        var options = Bind();

        Assert.Equal(TimeSpan.FromSeconds(5), options.PollInterval);
        Assert.Equal(TimeSpan.FromSeconds(60), options.Debounce);
        Assert.Equal(TimeSpan.FromMilliseconds(200), options.BackfillPause);
        Assert.Equal(options, new ProcessingOptions());
    }

    [Fact]
    public void Durations_inside_the_bounds_are_kept()
    {
        var options = Bind(("PollInterval", "00:00:00.100"), ("Debounce", "01:00:00"), ("BackfillPause", "00:10:00"));

        Assert.Equal(TimeSpan.FromMilliseconds(100), options.PollInterval);
        Assert.Equal(TimeSpan.FromHours(1), options.Debounce);
        Assert.Equal(TimeSpan.FromMinutes(10), options.BackfillPause);
        Assert.Equal(TimeSpan.Zero, Bind(("Debounce", "00:00:00"), ("BackfillPause", "00:00:00")).Debounce);
    }

    [Theory]
    [InlineData("00:00:00", "00:00:00.100")]   // zero would be a busy loop
    [InlineData("-00:00:00.001", "00:00:00.100")] // -1 ms is Task.Delay's "forever"
    [InlineData("-01:00:00", "00:00:00.100")]
    [InlineData("00:00:00.050", "00:00:00.100")]
    [InlineData("00:10:00.001", "00:10:00")]
    [InlineData("60.00:00:00", "00:10:00")]    // more than Task.Delay accepts (about 49.7 days)
    public void Poll_interval_is_kept_between_100_ms_and_10_minutes(string configured, string expected)
        => Assert.Equal(TimeSpan.Parse(expected), Bind(("PollInterval", configured)).PollInterval);

    [Theory]
    [InlineData("-00:00:05", "00:00:00")]
    [InlineData("-00:00:00.001", "00:00:00")]
    [InlineData("00:10:00.001", "00:10:00")]
    [InlineData("60.00:00:00", "00:10:00")]
    public void Backfill_pause_is_kept_between_zero_and_10_minutes(string configured, string expected)
        => Assert.Equal(TimeSpan.Parse(expected), Bind(("BackfillPause", configured)).BackfillPause);

    [Theory]
    [InlineData("-00:01:00", "00:00:00")]
    [InlineData("01:00:00.001", "01:00:00")]
    [InlineData("10675199.02:48:05", "01:00:00")] // about TimeSpan.MaxValue: the cut-off time "now - debounce" would not exist
    public void Debounce_is_kept_between_zero_and_one_hour(string configured, string expected)
        => Assert.Equal(TimeSpan.Parse(expected), Bind(("Debounce", configured)).Debounce);

    [Fact]
    public void Setting_a_duration_in_code_is_clamped_too()
    {
        var options = new ProcessingOptions { PollInterval = TimeSpan.Zero, Debounce = TimeSpan.FromDays(1), BackfillPause = TimeSpan.FromDays(-1) };

        Assert.Equal(TimeSpan.FromMilliseconds(100), options.PollInterval);
        Assert.Equal(TimeSpan.FromHours(1), options.Debounce);
        Assert.Equal(TimeSpan.Zero, options.BackfillPause);
        Assert.Equal(TimeSpan.FromMinutes(10), (options with { PollInterval = TimeSpan.MaxValue }).PollInterval);
    }
}
