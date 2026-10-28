using FastEndpoints;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Places;

/// <summary>
/// <c>GET /api/places/{id}</c>: a place and the time spent at it, for the place view. An id that is not a positive whole number
/// is a 400; one that is no place of the timeline (it does not exist, or is not in use, see <see cref="PlaceStore.FindDetailAsync"/>)
/// is a 404. A place merged into another is served as the one it was merged into, so the id of the answer is that of the survivor,
/// whichever id was asked for; <c>merged</c> lists the places merged directly into it. Reads only.
/// </summary>
internal sealed class GetPlaceEndpoint(PlaceStore places) : EndpointWithoutRequest<PlaceResponse>
{
    public override void Configure()
    {
        Get("places/{id}");
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

        var place = await places.FindDetailAsync(id, ct);
        if (place is null)
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        await Send.OkAsync(PlaceResponse.From(place), ct);
    }
}
