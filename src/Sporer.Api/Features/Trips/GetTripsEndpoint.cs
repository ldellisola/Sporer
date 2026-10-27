using System.Globalization;
using FastEndpoints;
using Sporer.Timeline;

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
        var thumbnail = TripThumbnail.Line(stored.HomeAtStart, nights.Select(n => n.Position), stored.HomeAtEnd);

        return new TripDto(
            Text(trip.FirstNight),
            TripNaming.Name([.. nights.Select(n => (n.Date, n.City, n.Country))]),
            Text(trip.FirstNight),
            Text(trip.LastNight),
            trip.Nights,
            trip.StartUtc,
            trip.EndUtc,
            trip.StartZone,
            trip.EndZone,
            Text(trip.LocalStartDate),
            Text(trip.LocalEndDate),
            trip.EndUtc is null,
            [.. TripNaming.Cities(nights).Select(c => new TripCityDto(c.Name, c.Country, c.Nights, c.Latitude, c.Longitude))],
            LonLat(thumbnail));
    }

    private static string Text(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>A line as <c>[[lon,lat],...]</c>, the order the stored lines and GeoJSON have.</summary>
    private static double[][] LonLat(IReadOnlyList<GeoPoint> line) => [.. line.Select(p => new[] { p.Longitude, p.Latitude })];
}
