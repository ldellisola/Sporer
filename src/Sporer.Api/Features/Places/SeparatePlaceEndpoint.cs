using FastEndpoints;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;

namespace Sporer.Api.Features.Places;

/// <summary>
/// <c>DELETE /api/places/{id}/merged/{other}</c>: separates a place from the one it was merged into: the place <c>other</c>, which
/// must have been merged <em>directly</em> into the place <c>id</c> (the ids are those of the places themselves, as
/// <c>GET /api/places/{id}</c> lists them under <c>merged</c>, and are not followed to a survivor), is a place of its own again, with
/// its own stays and its own name; what was merged into it is with it. The name the survivor was given at the merge stays with the
/// survivor: nothing keeps the one it had before. Answers 204. An id that is not a positive whole number is a 400, and a place that is
/// not merged into <c>id</c> (it is unknown, is not merged at all, is merged into another, or into this one through another) a 404.
/// Nothing is reprocessed, and the homes and trips are worked out again before the answer, as for a merge
/// (see <see cref="ITripRefresher.RecomputeAsync"/>).
/// </summary>
internal sealed class SeparatePlaceEndpoint(PlaceStore places, ITripRefresher refresher) : EndpointWithoutRequest
{
    public override void Configure()
    {
        Delete("places/{id}/merged/{other}");
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

        if (!PlaceId.TryParse(Route<string>("other", isRequired: false), out var other))
        {
            ValidationFailures.Add(new("other", PlaceId.InvalidMessage));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        if (!await places.SeparateAsync(id, other, ct))
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        await refresher.RecomputeAsync(ct);

        await Send.NoContentAsync(ct);
    }
}
