using System.Globalization;
using FastEndpoints;
using Sporer.Api.Features.Range;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// <c>GET /api/trips/{id}</c>: one trip with its stats, the moves of its span to draw and a summary of each of its days, for the
/// trip view. The id is the date of the trip's first night, <c>yyyy-MM-dd</c>; anything else, and a date that no trip began on,
/// is a 404 (a malformed id is not a different kind of mistake from an unknown one: both name no trip). Reads only. What it is
/// read with is described by <see cref="TripStore.FindAsync"/>; the name, cities, stats and days are made from it here, each
/// time, and the name and cities as the list's are (see <see cref="TripMapping.Summary"/>).
/// </summary>
internal sealed class GetTripEndpoint(TripStore store) : EndpointWithoutRequest<TripResponse>
{
    public override void Configure()
    {
        Get("trips/{id}");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        // Exactly yyyy-MM-dd, as the ids are written: no other form of a date names a trip.
        var text = Route<string>("id", isRequired: false);
        if (!DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var id))
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        var detail = await store.FindAsync(id, ct);
        if (detail is null)
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        var (trip, nights) = (detail.Trip, detail.Nights);
        var stats = TripDays.Stats(detail);

        // The moves are drawn together, so the vertex budget is for all of their lines.
        var lines = VertexBudget.Fit([.. detail.Moves.Select(m => m.Line)]);

        await Send.OkAsync(new TripResponse(
            TripMapping.Summary(trip, nights),
            new TripStatsDto(stats.Flights, stats.Cities, stats.Places, stats.GroundDistanceMeters),
            [.. detail.Moves.Select((m, k) => new TripMoveDto(m.Id, m.Mode, m.DistanceM, TripMapping.LonLat(lines[k])))],
            [.. TripDays.Days(detail).Select(d => new TripDayDto(TripMapping.Text(d.Date), d.Description, d.Highlights, d.GroundDistanceMeters, d.Flights))]), ct);
    }
}
