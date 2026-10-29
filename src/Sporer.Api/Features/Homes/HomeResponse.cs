using System.Text.Json.Serialization;

namespace Sporer.Api.Features.Homes;

/// <summary>
/// A home period, as <c>GET /api/homes</c> lists it and <c>POST /api/homes</c> answers. <paramref name="Id"/> is what
/// <c>DELETE /api/homes/{id}</c> takes. <paramref name="PlaceId"/> is the place that survives merges and <paramref name="PlaceName"/> its
/// name (the owner's, else OpenStreetMap's, else null). <paramref name="From"/> and <paramref name="To"/> are night dates
/// (<c>yyyy-MM-dd</c>), both inclusive; <paramref name="To"/> is null for a period that goes on. <paramref name="Source"/> is
/// <c>detected</c>, for the homes found from the nights, or <c>user</c>, for the owner's.
/// </summary>
public sealed record HomeDto(
    long Id,
    long PlaceId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? PlaceName,
    string From,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? To,
    string Source);

/// <summary>The home periods that are stored, detected and the owner's, in date order, as served by <c>GET /api/homes</c>. Empty when there are none.</summary>
public sealed record HomesResponse(IReadOnlyList<HomeDto> Periods);
