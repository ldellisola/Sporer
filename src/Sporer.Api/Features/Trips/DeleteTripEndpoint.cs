using FastEndpoints;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// <c>DELETE /api/trips/{id}</c>: the owner says the trip is none. It is marked deleted in its edit (what else the edit says, a name or
/// dates, is kept), so that it stays gone when the trips are worked out again, from new data or a rebuild of the timeline, until it is
/// brought back (<c>POST /api/trips/deleted/{key}/restore</c>). What it was called is recorded with it (<c>deleted_label</c>), for the list of
/// the deleted: the name the list shows the trip under, then ` · `, then its dates the way the list writes them (see
/// <see cref="TripMapping.DateRange"/>): <c>Lisbon · 12 – 16 Sep 2026</c>. The trips are worked out again before the answer (see
/// <see cref="EditRecompute"/>). Answers 204. An id that is not <c>yyyy-MM-dd</c>, or no trip has, is a 404, and so is a trip that is deleted
/// already.
/// </summary>
internal sealed class DeleteTripEndpoint(TripStore trips, TripEditStore edits, EditRecompute recompute) : EndpointWithoutRequest
{
    public override void Configure()
    {
        Delete("trips/{id}");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        if (!TripId.TryParse(Route<string>("id", isRequired: false), out var id))
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        var target = await edits.FindTargetAsync(id, ct);
        // As the list shows it: the label is what the owner saw when they chose to delete the trip.
        var shown = target is null ? null : (await trips.ListAsync(ct)).FirstOrDefault(t => t.Trip.FirstNight == id);
        if (target is null || shown is null)
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        var label = $"{TripMapping.DisplayName(shown.Name, shown.Nights)} · {TripMapping.DateRange(shown.Trip.LocalStartDate, shown.Trip.LocalEndDate)}";
        await edits.DeleteTripAsync(target.Key, target.Edit?.DetectedLastNight ?? target.LastNight, label, ct);

        await recompute.RecomputeAfterEditAsync(ct);

        await Send.NoContentAsync(ct);
    }
}
