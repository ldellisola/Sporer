using FastEndpoints;
using Sporer.Api.Features.Trips;

namespace Sporer.Api.Features.Homes;

/// <summary>
/// <c>DELETE /api/homes/{id}</c>: takes back a home period the owner set; what detection found for those dates is the home again. The trips are
/// worked out again before the answer (see <see cref="EditRecompute"/>). Answers 204. Only the owner's own period can be deleted: a detected one
/// is a 409, because the next refresh would find it again; one that is no period is a 404; and an id that is not a positive whole number is a 400.
/// </summary>
internal sealed class DeleteHomeEndpoint(HomeStore homes, EditRecompute recompute) : EndpointWithoutRequest
{
    public override void Configure()
    {
        Delete("homes/{id}");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        if (!HomeId.TryParse(Route<string>("id", isRequired: false), out var id))
        {
            ValidationFailures.Add(new("id", HomeId.InvalidMessage));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        switch (await homes.DeleteUserAsync(id, ct))
        {
            case DeleteHomeOutcome.NotFound:
                await Send.NotFoundAsync(ct);
                return;
            case DeleteHomeOutcome.Detected:
                ValidationFailures.Add(new("id",
                    "This home was found from where you slept, and is found again whenever the trips are worked out. Set a home for its dates to replace it."));
                await Send.ErrorsAsync(409, ct);
                return;
        }

        await recompute.RecomputeAfterEditAsync(ct);

        await Send.NoContentAsync(ct);
    }
}
