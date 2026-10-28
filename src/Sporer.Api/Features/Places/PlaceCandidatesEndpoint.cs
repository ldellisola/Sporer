using FastEndpoints;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Places;

/// <summary>
/// <c>GET /api/places/{id}/candidates?q=</c>: the places the place <c>id</c> stands for can be merged with, for the owner to pick
/// from: the nearest first, at most <see cref="PlaceStore.CandidateLimit"/>, as an array of <see cref="PlaceCandidateDto"/>. They are
/// the places in use that survive merges, not that place itself (so not one merged into it). With a <c>q</c>, those whose name or
/// address contains it, whatever the case (see <see cref="PlaceStore.FindCandidatesAsync"/>); with none, or an empty one, all of them. An id that is not
/// a positive whole number is a 400; one that is no place of the timeline (see <see cref="PlaceStore.FindDetailAsync"/>) is a 404.
/// Reads only.
/// </summary>
internal sealed class PlaceCandidatesEndpoint(PlaceStore places) : EndpointWithoutRequest<IReadOnlyList<PlaceCandidateDto>>
{
    public override void Configure()
    {
        Get("places/{id}/candidates");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        if (!PlaceId.TryParse(Route<string>("id", isRequired: false), out var id))
        {
            ValidationFailures.Add(new("id", PlaceId.InvalidMessage));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        var candidates = await places.FindCandidatesAsync(id, Query<string>("q", isRequired: false), ct);
        if (candidates is null)
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        await Send.OkAsync([.. candidates.Select(c => new PlaceCandidateDto(c.Id, c.Name, c.Address, c.DistanceM, c.Visits))], ct);
    }
}
