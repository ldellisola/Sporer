using FastEndpoints;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;

namespace Sporer.Api.Features.Places;

/// <summary>
/// The body of <c>POST /api/places/{id}/merge</c>: <paramref name="Place"/> is the place to merge into the one in the route, and
/// <paramref name="Name"/> the name the survivor is to have (null, or none, to leave it as it is). Both are read from the JSON body
/// alone: a query that has a <c>place</c> or a <c>name</c> is no part of the request. A body with no <c>place</c> in it has none, which
/// is a 400 whatever it says of the rest. (The properties carry <c>[DontBind]</c>, with which FastEndpoints 8.3.0 ignores <c>required</c>
/// and <c>JsonRequired</c>, as with <see cref="RenamePlaceRequest"/>; so the place is a nullable number that is checked.)
/// </summary>
internal sealed record MergePlaceRequest
{
    [DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public long? Place { get; init; }

    [DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public string? Name { get; init; }
}

/// <summary>
/// <c>POST /api/places/{id}/merge</c>: merges the place <c>place</c> stands for into the place <c>id</c> stands for (each as
/// <c>GET /api/places/{id}</c> serves it, so an id of a place that was merged is the one it was merged into): the place the owner is
/// on survives, and everything spent at the other is spent at it from now on, in the day, the range, the place and the trips. A
/// <c>name</c> that is not null becomes the survivor's name, which the owner chose to keep (it is trimmed, and one that is empty
/// afterwards is none: OpenStreetMap's shows again; at most <see cref="RenamePlaceEndpoint.MaxNameLength"/> characters, else 400); null,
/// or none, leaves it as it is. Answers 200 with the survivor, as <c>GET /api/places/{id}</c> gives it, merged places and all. An id
/// that is not a positive whole number, a <c>place</c> that is missing or is not one, and a name that is too long are 400; a place
/// that is no place of the timeline (see <see cref="PlaceStore.FindDetailAsync"/>) is 404; and two that are the same place once their
/// merges are followed, or a merge that would chain more than <see cref="PlaceStore.MaxMergeLinks"/> merges (more than the views
/// follow) is 409. Nothing is reprocessed: what is read follows the merges, and the homes and trips are worked out again
/// before the answer (see <see cref="EditRecompute"/>), so that they are never the ones of the places as they were.
/// </summary>
/// <remarks>
/// The merge is committed before the homes and trips are, and each is its own transaction. A failure of the second does not undo the
/// first, and the answer is still 200: <see cref="EditRecompute"/> logs it and has the worker work the homes and trips out.
/// </remarks>
internal sealed class MergePlaceEndpoint(PlaceStore places, EditRecompute recompute) : Endpoint<MergePlaceRequest, PlaceResponse>
{
    public override void Configure()
    {
        Post("places/{id}/merge");
        AllowAnonymous();
    }

    public override async Task HandleAsync(MergePlaceRequest req, CancellationToken ct)
    {
        if (!PlaceId.TryParse(Route<string>("id", isRequired: false), out var id))
        {
            ValidationFailures.Add(new("id", PlaceId.InvalidMessage));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        if (req.Place is not { } other || other <= 0)
        {
            ValidationFailures.Add(new("place", "The place must be given, as a positive whole number."));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        var name = req.Name?.Trim();
        if (name is { Length: > RenamePlaceEndpoint.MaxNameLength })
        {
            ValidationFailures.Add(new("name", $"The name can be at most {RenamePlaceEndpoint.MaxNameLength} characters."));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        var merge = await places.MergeAsync(id, other, name, ct);
        switch (merge.Outcome)
        {
            case MergeOutcome.NotFound:
                await Send.NotFoundAsync(ct);
                return;
            case MergeOutcome.Conflict:
                ValidationFailures.Add(new("place", "The place is the one it is to be merged into, or is merged into it already."));
                await Send.ErrorsAsync(409, ct);
                return;
            case MergeOutcome.ChainTooLong:
                ValidationFailures.Add(new("place", $"The place has places merged into it that are {PlaceStore.MaxMergeLinks} merges deep already: one more would be more than the {PlaceStore.MaxMergeLinks} that can be followed."));
                await Send.ErrorsAsync(409, ct);
                return;
        }

        await recompute.RecomputeAfterEditAsync(ct);

        var survivor = await places.FindDetailAsync(merge.SurvivorId, ct);
        if (survivor is null)
        {
            await Send.NotFoundAsync(ct); // a rebuild took the place off the timeline between the two: the same answer as for any place
            return;
        }

        await Send.OkAsync(PlaceResponse.From(survivor), ct);
    }
}
