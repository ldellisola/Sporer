namespace Sporer.Api.Configuration;

/// <summary>
/// Which map styles the web app draws with. Bound from configuration section <c>Map</c> (environment variables
/// <c>Map__StyleLight</c>, <c>Map__StyleDark</c>) and served by <c>GET /api/config</c>. A style is the URL of a MapLibre style
/// document. A blank value, as an unset variable passed through by a compose file leaves, keeps the default.
/// </summary>
public sealed record MapOptions
{
    public const string DefaultStyleLight = "https://tiles.openfreemap.org/styles/liberty";
    public const string DefaultStyleDark = "https://tiles.openfreemap.org/styles/dark";

    private readonly string _styleLight = DefaultStyleLight;
    private readonly string _styleDark = DefaultStyleDark;

    /// <summary>The style used while the browser prefers a light colour scheme.</summary>
    public string StyleLight
    {
        get => _styleLight;
        init => _styleLight = OrDefault(value, DefaultStyleLight);
    }

    /// <summary>The style used while the browser prefers a dark colour scheme.</summary>
    public string StyleDark
    {
        get => _styleDark;
        init => _styleDark = OrDefault(value, DefaultStyleDark);
    }

    private static string OrDefault(string? value, string fallback) => string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
}
