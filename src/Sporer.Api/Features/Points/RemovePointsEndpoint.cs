using System.Text.Json.Serialization;
using FastEndpoints;

namespace Sporer.Api.Features.Points;

/// <summary>
/// The body of <c>POST /api/points/remove</c>: the points to remove, each by its device and its time in epoch microseconds
/// (see <see cref="PointTime"/>). It is read from the JSON body alone. A point is nullable all through, so that a body that leaves
/// something out is told from one that says zero, and is a 400.
/// </summary>
internal sealed record RemovePointsRequest
{
    [DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public RemovePointRef?[]? Points { get; init; }
}

/// <summary>One point of <see cref="RemovePointsRequest"/>.</summary>
internal sealed record RemovePointRef(string? Device, long? T);

/// <summary>
/// The answer to a removal: the batch it is undone by, and how many points it removed. A removal that removed none has no batch: it is
/// <c>null</c>, always written, so that the client reads a null and never the lack of one.
/// </summary>
internal sealed record RemovePointsResponse([property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] Guid? Batch, int Count);

/// <summary>
/// <c>POST /api/points/remove</c>: removes points from the timeline, which is to say that the raw points stay and are left out of every
/// rebuild of it. The points are given by device and time (<see cref="RemovePointsRequest"/>) and go in one batch (see
/// <see cref="ExcludedPointStore.RemoveAsync"/>, which also says what is a point that is not removed: one that does not exist, or that was
/// removed before, is ignored, and is not counted). The stretch they are in is asked to be rebuilt at once. Answers 200 with the
/// <c>batch</c>, which <c>DELETE /api/points/removed/{batch}</c> undoes, and the <c>count</c> removed; when that is none, the batch is
/// <c>null</c> and nothing is asked to be rebuilt. More than <see cref="MaxPoints"/> points is a 400, as is a body without <c>points</c>, a
/// point without a <c>device</c> or a <c>t</c> that is not a time (a point that does not exist is ignored, not a 400), and nothing is removed.
/// </summary>
internal sealed class RemovePointsEndpoint(ExcludedPointStore store, TimeProvider time) : Endpoint<RemovePointsRequest, RemovePointsResponse>
{
    /// <summary>The most points one request can remove.</summary>
    public const int MaxPoints = 50_000;

    public override void Configure()
    {
        Post("points/remove");
        AllowAnonymous();
    }

    public override async Task HandleAsync(RemovePointsRequest req, CancellationToken ct)
    {
        if (req.Points is not { } refs)
        {
            ValidationFailures.Add(new("points", "The points to remove are missing."));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        if (refs.Length > MaxPoints)
        {
            ValidationFailures.Add(new("points", $"At most {MaxPoints} points can be removed at once."));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        var points = new List<PointKey>(refs.Length);
        for (var i = 0; i < refs.Length; i++)
        {
            if (refs[i] is not { Device: { } device, T: { } micros } || !PointTime.TryFromMicros(micros, out var timeUtc))
            {
                // The first that is wrong, not all of them: a request can have fifty thousand.
                ValidationFailures.Add(new($"points[{i}]", "A point is a device and a time in microseconds since the epoch: {\"device\": string, \"t\": number}."));
                await Send.ErrorsAsync(400, ct);
                return;
            }

            points.Add(new PointKey(device, timeUtc));
        }

        var (batch, count) = await store.RemoveAsync(points, time.GetUtcNow().UtcDateTime, ct);
        await Send.OkAsync(new RemovePointsResponse(batch, count), ct);
    }
}
