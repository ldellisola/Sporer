using FastEndpoints;
using Sporer.Api.Configuration;

namespace Sporer.Api.Features.Config;

/// <summary>
/// <c>GET /api/config</c>: what the web app needs to know about this installation before it can draw: the map styles to use
/// in the light and in the dark colour scheme (see <see cref="MapOptions"/>). Reads only configuration.
/// </summary>
internal sealed class GetConfigEndpoint(MapOptions map) : EndpointWithoutRequest<ConfigResponse>
{
    public override void Configure()
    {
        Get("config");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
        => await Send.OkAsync(new ConfigResponse(map.StyleLight, map.StyleDark), ct);
}

/// <summary>The installation's settings for the web app, as served by <c>GET /api/config</c>.</summary>
/// <param name="MapStyleLight">URL of the MapLibre style document for the light colour scheme.</param>
/// <param name="MapStyleDark">URL of the MapLibre style document for the dark colour scheme.</param>
public sealed record ConfigResponse(string MapStyleLight, string MapStyleDark);
