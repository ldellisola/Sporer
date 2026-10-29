using FastEndpoints;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// A trip the owner deleted, as <c>GET /api/trips/deleted</c> lists it: the <paramref name="Key"/> that
/// <c>POST /api/trips/deleted/{key}/restore</c> brings it back by (<c>yyyy-MM-dd</c>: the first night detection found it on when it was
/// first edited, which is not the id of any trip now), the <paramref name="Label"/> it was shown under when it was deleted, and when it was
/// deleted (ISO-8601 UTC, <c>Z</c>).
/// </summary>
public sealed record DeletedTripDto(string Key, string Label, DateTime DeletedAt);

/// <summary>
/// <c>GET /api/trips/deleted</c>: the trips the owner deleted and has not brought back, the one deleted last first, as an array of
/// <see cref="DeletedTripDto"/> (empty when there are none). Reads only.
/// </summary>
internal sealed class GetDeletedTripsEndpoint(TripEditStore edits) : EndpointWithoutRequest<IReadOnlyList<DeletedTripDto>>
{
    public override void Configure()
    {
        Get("trips/deleted");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
        => await Send.OkAsync([.. (await edits.ListDeletedAsync(ct)).Select(t => new DeletedTripDto(TripMapping.Text(t.Key), t.Label, t.DeletedAt))], ct);
}

/// <summary>
/// <c>POST /api/trips/deleted/{key}/restore</c>: brings back a deleted trip: it is a trip again as detection finds it, with the name and the
/// dates the owner gave it before it was deleted. The trips are worked out again before the answer (see <see cref="EditRecompute"/>). Takes no
/// body (an empty one, or <c>{}</c>, sent as JSON like every write). Answers 204. A key that is not <c>yyyy-MM-dd</c>, or no deleted trip has,
/// is a 404.
/// </summary>
/// <remarks>
/// The trip comes back with the nights detection gives it. If an edit of another trip has since taken some of them, that edit goes without
/// its dates until they are free (see <see cref="Sporer.Timeline.TripEdits.Apply"/>): the restore is not refused.
/// </remarks>
internal sealed class RestoreTripEndpoint(TripEditStore edits, EditRecompute recompute) : EndpointWithoutRequest
{
    public override void Configure()
    {
        Post("trips/deleted/{key}/restore");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        if (!TripId.TryParse(Route<string>("key", isRequired: false), out var key) || !await edits.RestoreAsync(key, ct))
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        await recompute.RecomputeAfterEditAsync(ct);

        await Send.NoContentAsync(ct);
    }
}
