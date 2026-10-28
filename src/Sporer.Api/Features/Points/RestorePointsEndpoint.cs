using FastEndpoints;

namespace Sporer.Api.Features.Points;

/// <summary>
/// <c>DELETE /api/points/removed/{batch}</c>: restores the points of a removal (see <see cref="ExcludedPointStore.RestoreAsync"/>), and the
/// stretch they are in is asked to be rebuilt at once. Answers 204; 404 for a batch there is none of, which includes one that was restored
/// already; 400 for a batch that is not a batch id (the id the removal answered with).
/// </summary>
internal sealed class RestorePointsEndpoint(ExcludedPointStore store, TimeProvider time) : EndpointWithoutRequest
{
    public override void Configure()
    {
        Delete("points/removed/{batch}");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        if (!Guid.TryParseExact(Route<string>("batch", isRequired: false), "D", out var batch))
        {
            ValidationFailures.Add(new("batch", "The batch must be the id the removal gave, such as 3f2504e0-4f89-11d3-9a0c-0305e82c3301."));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        if (!await store.RestoreAsync(batch, time.GetUtcNow().UtcDateTime, ct))
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        await Send.NoContentAsync(ct);
    }
}
