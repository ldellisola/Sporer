using Microsoft.Extensions.Configuration;
using Sporer.Api.Configuration;

namespace Sporer.Api.Tests;

public class TransitOptionsTests
{
    private static TransitOptions Bind(params (string Key, string? Value)[] settings) => TransitOptions.From(new ConfigurationBuilder()
        .AddInMemoryCollection(settings.Select(s => new KeyValuePair<string, string?>(s.Key, s.Value)))
        .Build());

    [Fact]
    public void Defaults_are_the_specs()
    {
        var options = Bind();

        Assert.True(options.Enabled);
        Assert.Equal("https://overpass-api.de/api/interpreter", options.OverpassUrl);
        Assert.Null(options.UserAgent);
        Assert.Equal(TimeSpan.FromSeconds(10), options.MinInterval);
        Assert.False(options.FetchingEnabled); // nobody to say who asks
        Assert.Equal(options, new TransitOptions());
    }

    [Fact]
    public void Values_inside_the_bounds_are_kept()
    {
        var options = Bind(
            ("Transit:Enabled", "false"), ("Transit:OverpassUrl", "https://overpass.example.test/api/interpreter"),
            ("Transit:UserAgent", "Sporer/1.0 (you@example.invalid)"), ("Transit:MinInterval", "00:00:30"));

        Assert.False(options.Enabled);
        Assert.Equal("https://overpass.example.test/api/interpreter", options.OverpassUrl);
        Assert.Equal("Sporer/1.0 (you@example.invalid)", options.UserAgent);
        Assert.Equal(TimeSpan.FromSeconds(30), options.MinInterval);
        Assert.False(options.FetchingEnabled); // switched off
    }

    [Theory]
    [InlineData("00:00:00", "00:00:01")]
    [InlineData("-00:00:05", "00:00:01")]
    [InlineData("00:00:00.5", "00:00:01")]
    [InlineData("00:00:01", "00:00:01")]
    [InlineData("01:00:00", "01:00:00")]
    [InlineData("1.00:00:00", "01:00:00")]
    public void The_interval_is_kept_between_a_second_and_an_hour(string configured, string expected)
        => Assert.Equal(TimeSpan.Parse(expected), Bind(("Transit:MinInterval", configured)).MinInterval);

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void A_blank_url_is_the_default(string url)
        => Assert.Equal(TransitOptions.DefaultOverpassUrl, Bind(("Transit:OverpassUrl", url)).OverpassUrl);

    [Theory]
    [InlineData(null, null, null)]
    [InlineData(null, "Naming/1.0", "Naming/1.0")]
    [InlineData("", "Naming/1.0", "Naming/1.0")]
    [InlineData("  ", "Naming/1.0", "Naming/1.0")]
    [InlineData("Transit/1.0", "Naming/1.0", "Transit/1.0")]
    [InlineData("Transit/1.0", null, "Transit/1.0")]
    [InlineData(null, "  ", null)]
    public void The_user_agent_is_the_transit_one_else_the_naming_one(string? transit, string? nominatim, string? expected)
    {
        var options = Bind(("Transit:UserAgent", transit), ("Nominatim:UserAgent", nominatim));

        Assert.Equal(expected, options.UserAgent);
        Assert.Equal(expected is not null, options.FetchingEnabled);
    }
}
