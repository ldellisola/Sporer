namespace Sporer.Api.Features.Settings;

/// <summary>
/// The owner's settings, as served by <c>GET /api/settings</c> and answered by <c>PUT /api/settings</c>. <paramref name="TripMinDistanceKm"/>
/// is the distance in kilometres that a night must be from home to be away, which makes a trip: the one the owner set, else
/// <paramref name="TripMinDistanceKmDefault"/>, the one that is configured (<c>Detection:TripMinDistanceKm</c>, 50 unless it was changed).
/// </summary>
public sealed record SettingsResponse(double TripMinDistanceKm, double TripMinDistanceKmDefault);
