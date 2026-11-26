using FastEndpoints;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Places;

/// <summary>
/// <c>GET /api/places</c>: every place in use, the most time first, with where it is, for the map that shows all of them (the Places view, and
/// what a place is merged with there). The places are those <c>GET /api/places/search</c> lists, all of them and not 20 (see
/// <see cref="PlaceStore.ListAsync"/>). Reads only.
/// </summary>
internal sealed class GetPlacesEndpoint(PlaceStore places) : EndpointWithoutRequest<PlacesResponse>
{
    public override void Configure()
    {
        Get("places");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        var all = await places.ListAsync(ct);
        await Send.OkAsync(new PlacesResponse([.. all.Select(p => new MapPlaceDto(p.Id, p.Name, p.Latitude, p.Longitude, p.Seconds, p.Visits))]), ct);
    }
}
