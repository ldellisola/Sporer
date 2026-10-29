using FastEndpoints;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;
using Sporer.Api.Http;

namespace Sporer.Api.Features.Places;

/// <summary>
/// <c>DELETE /api/places/{id}/merged/{other}</c>: separates a place from the one it was merged into: the place <c>other</c>, which
/// must have been merged <em>directly</em> into the place <c>id</c> stands for (as <c>GET /api/places/{id}</c> serves it, so an id of
/// a place that was merged is the one it was merged into, as for a merge; <c>other</c> is the place itself, as
/// <c>GET /api/places/{id}</c> lists it under <c>merged</c>), is a place of its own again, with its own stays and its own name; what
/// was merged into it is with it. The name the survivor was given at the merge stays with the
/// survivor: nothing keeps the one it had before. Answers 204. An id that is not a positive whole number is a 400, and an <c>id</c>
/// that is no place of the timeline, or a place that is not merged into the one it stands for (it is unknown, is not merged at all, is
/// merged into another, or into this one through another), a 404.
/// Nothing is reprocessed, and the homes and trips are worked out again before the answer, as for a merge (see
/// <see cref="EditRecompute"/>, which also says what a failure of that does: the answer is 204 all the same).
/// </summary>
internal sealed class SeparatePlaceEndpoint(PlaceStore places, EditRecompute recompute) : EndpointWithoutRequest
{
    public override void Configure()
    {
        Delete("places/{id}/merged/{other}");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        if (!PositiveId.TryParse(Route<string>("id", isRequired: false), out var id))
        {
            ValidationFailures.Add(new("id", PositiveId.InvalidMessage));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        if (!PositiveId.TryParse(Route<string>("other", isRequired: false), out var other))
        {
            ValidationFailures.Add(new("other", PositiveId.InvalidMessage));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        if (!await places.SeparateAsync(id, other, ct))
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        await recompute.RecomputeAfterEditAsync(ct);

        await Send.NoContentAsync(ct);
    }
}
