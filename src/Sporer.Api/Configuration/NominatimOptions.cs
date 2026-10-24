namespace Sporer.Api.Configuration;

/// <summary>
/// How places are named through the public OpenStreetMap Nominatim service. Bound from configuration section
/// <c>Nominatim</c> (environment variables <c>Nominatim__Enabled</c>, <c>Nominatim__UserAgent</c>, ...). Read once at
/// start-up: it decides whether the naming worker is registered.
/// </summary>
public sealed record NominatimOptions
{
    public bool Enabled { get; init; } = true;

    public string BaseUrl { get; init; } = "https://nominatim.openstreetmap.org";

    /// <summary>
    /// Identifies this installation to Nominatim, as its usage policy requires: the application name and a way to
    /// reach the operator, for example <c>Sporer/1.0 (you@example.com)</c>. Without it nothing is requested.
    /// </summary>
    public string? UserAgent { get; init; }

    /// <summary>The least time between two requests; the policy allows one per second at most.</summary>
    public TimeSpan MinInterval { get; init; } = TimeSpan.FromSeconds(1.1);

    /// <summary>Whether places are named at all: enabled, and a user agent is set.</summary>
    public bool NamingEnabled => Enabled && !string.IsNullOrWhiteSpace(UserAgent);
}
