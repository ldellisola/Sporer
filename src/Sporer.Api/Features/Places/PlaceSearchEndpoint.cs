using FastEndpoints;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Places;

/// <summary>
/// <c>GET /api/places/search?q=</c>: the places in use, with no place to start from (the candidates of
/// <c>GET /api/places/{id}/candidates</c> are the places near one), for the owner to pick one by name or address: the most visited first, at most
/// <see cref="PlaceStore.CandidateLimit"/>, as an array of <see cref="PlaceSearchDto"/>. With a <c>q</c>, those whose name or address contains it,
/// whatever the case, as the candidates are found (see <see cref="PlaceStore.SearchAsync"/>); with none, or an empty one, the most visited of all.
/// Reads only.
/// </summary>
internal sealed class PlaceSearchEndpoint(PlaceStore places) : EndpointWithoutRequest<IReadOnlyList<PlaceSearchDto>>
{
    public override void Configure()
    {
        Get("places/search");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        var found = await places.SearchAsync(Query<string>("q", isRequired: false), ct);
        await Send.OkAsync([.. found.Select(p => new PlaceSearchDto(p.Id, p.Name, p.Address, p.Visits))], ct);
    }
}
