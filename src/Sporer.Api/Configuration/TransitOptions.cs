namespace Sporer.Api.Configuration;

/// <summary>
/// How the railway and bus-route lines are fetched from OpenStreetMap through the Overpass API (transit spec sections 3 and 7). Bound from
/// configuration section <c>Transit</c> (environment variables <c>Transit__Enabled</c>, <c>Transit__UserAgent</c>, ...) by <see cref="From"/>.
/// None of it is part of the detection thresholds or the algorithm's version: changing it rebuilds nothing, and the lines already cached are
/// used whatever it says. A duration outside its bounds is moved to the nearest bound when it is set, as in <see cref="ProcessingOptions"/>, and
/// a blank URL is the default one.
/// </summary>
public sealed record TransitOptions
{
    public const string DefaultOverpassUrl = "https://overpass-api.de/api/interpreter";

    /// <summary>The least <see cref="MinInterval"/>: Overpass asks for one request at a time from each user, and a pause between them.</summary>
    public static readonly TimeSpan MinMinInterval = TimeSpan.FromSeconds(1);

    public static readonly TimeSpan MaxMinInterval = TimeSpan.FromHours(1);

    private readonly string _overpassUrl = DefaultOverpassUrl;
    private readonly TimeSpan _minInterval = TimeSpan.FromSeconds(10);

    /// <summary>Whether lines are fetched at all. Read once at start-up: it decides whether the fetcher is registered.</summary>
    public bool Enabled { get; init; } = true;

    /// <summary>The Overpass API to ask (its <c>interpreter</c> endpoint). A blank value is the default.</summary>
    public string OverpassUrl
    {
        get => _overpassUrl;
        init => _overpassUrl = string.IsNullOrWhiteSpace(value) ? DefaultOverpassUrl : value.Trim();
    }

    /// <summary>
    /// Identifies this installation to Overpass, which refuses clients that do not say who they are: the application name and a way to
    /// reach the operator. <see cref="From"/> takes <c>Nominatim:UserAgent</c> when this is not set. Without either nothing is fetched.
    /// </summary>
    public string? UserAgent { get; init; }

    /// <summary>The least time between two requests. Between 1 second and 1 hour.</summary>
    public TimeSpan MinInterval
    {
        get => _minInterval;
        init => _minInterval = value < MinMinInterval ? MinMinInterval : value > MaxMinInterval ? MaxMinInterval : value;
    }

    /// <summary>Whether lines are fetched: enabled, and a user agent to send.</summary>
    public bool FetchingEnabled => Enabled && !string.IsNullOrWhiteSpace(UserAgent);

    /// <summary>
    /// The options of section <c>Transit</c> of <paramref name="configuration"/>, with <c>Nominatim:UserAgent</c> as the user agent when the
    /// section has none (one name for the installation is enough).
    /// </summary>
    public static TransitOptions From(IConfiguration configuration)
    {
        var options = configuration.GetSection("Transit").Get<TransitOptions>() ?? new TransitOptions();
        return string.IsNullOrWhiteSpace(options.UserAgent)
            ? options with { UserAgent = string.IsNullOrWhiteSpace(configuration["Nominatim:UserAgent"]) ? null : configuration["Nominatim:UserAgent"] }
            : options;
    }
}
