using FastEndpoints;
using Sporer.Timeline;

namespace Sporer.Api.Features.Settings;

/// <summary>
/// <c>GET /api/settings</c>: the owner's settings, with the value in effect and the one it falls back to (see <see cref="SettingsResponse"/>).
/// Reads only.
/// </summary>
internal sealed class GetSettingsEndpoint(SettingsStore settings, DetectionOptions options) : EndpointWithoutRequest<SettingsResponse>
{
    public override void Configure()
    {
        Get("settings");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
        => await Send.OkAsync(new SettingsResponse(
            await settings.GetTripMinDistanceKmAsync(ct) ?? options.TripMinDistanceKm, options.TripMinDistanceKm), ct);
}
