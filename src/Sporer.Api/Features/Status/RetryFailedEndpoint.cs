using FastEndpoints;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Status;

/// <summary>The answer to <c>POST /api/status/retry</c>: how many failed ranges were made due.</summary>
public sealed record RetryFailedResponse(int Retried);

/// <summary>
/// <c>POST /api/status/retry</c>: makes every failed range of the processing queue due now, instead of when its backoff is over (see
/// <see cref="ProcessingQueue.RetryFailedAsync"/>): the ranges that failed on their own and the backfill steps that were set aside, which are what
/// <c>GET /api/status</c> lists as failed. The worker takes them on its next pass. Takes no body (an empty one, or <c>{}</c>, sent as JSON like
/// every write). Answers 200 with how many there were, 0 when none had failed.
/// </summary>
internal sealed class RetryFailedEndpoint(ProcessingQueue queue, TimeProvider time) : EndpointWithoutRequest<RetryFailedResponse>
{
    public override void Configure()
    {
        Post("status/retry");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
        => await Send.OkAsync(new RetryFailedResponse(await queue.RetryFailedAsync(time.GetUtcNow().UtcDateTime, ct)), ct);
}
