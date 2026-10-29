using FastEndpoints;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// <c>GET /api/trips</c>: every trip, newest first, for the trips list and the map of where they went. Reads only. What the
/// stored trips and nights are read with is described by <see cref="TripStore.ListAsync"/>; the names, cities and thumbnails
/// are made from them here, each time, so a place named since shows in the answer without anything being reprocessed.
/// </summary>
internal sealed class GetTripsEndpoint(TripStore store) : EndpointWithoutRequest<TripsResponse>
{
    public override void Configure()
    {
        Get("trips");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        var trips = await store.ListAsync(ct);

        await Send.OkAsync(new TripsResponse([.. trips.Select(ToDto)]), ct);
    }

    private static TripDto ToDto(StoredTrip stored)
    {
        var (trip, nights) = (stored.Trip, stored.Nights);

        // A trip that is still going has not come back, so a line home would show a journey that has not happened.
        var thumbnail = TripThumbnail.Line(
            stored.HomeAtStart, nights.Select(n => n.Position), trip.EndUtc is null ? null : stored.HomeAtEnd);

        return new TripDto(TripMapping.Summary(trip, nights, stored.Name, stored.Edited), TripMapping.LonLat(thumbnail));
    }
}
