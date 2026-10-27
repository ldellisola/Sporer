using System.Text.Json.Serialization;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// One trip with all its page is drawn from, as served by <c>GET /api/trips/{id}</c>. The fields from <paramref name="Id"/> to
/// <paramref name="Cities"/> are those of a list item (see <see cref="TripDto"/>), without its thumbnail. For an ongoing trip the
/// last of its <paramref name="Days"/> is the day after its last night, and its moves and stays are those of the timeline so far.
/// </summary>
public sealed record TripResponse(
    string Id,
    string Name,
    string FirstNight,
    string LastNight,
    int Nights,
    DateTime Start,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] DateTime? End,
    string StartTimeZone,
    string EndTimeZone,
    string LocalStartDate,
    string LocalEndDate,
    bool Ongoing,
    IReadOnlyList<TripCityDto> Cities,
    TripStatsDto Stats,
    IReadOnlyList<TripMoveDto> Moves,
    IReadOnlyList<TripDayDto> Days);

/// <summary>
/// What the trip adds up to (see <see cref="TripDays.Stats"/>): the number of flights, of distinct cities and of distinct places
/// its stays were at, and the distance of the moves that are not flights.
/// </summary>
public sealed record TripStatsDto(int Flights, int Cities, int Places, double GroundDistanceMeters);

/// <summary>
/// A move of the trip to draw. <paramref name="Mode"/> is <c>walk</c>, <c>cycle</c>, <c>drive</c> or <c>flight</c>, and null for a
/// move whose mode could not be told, as in the range; <paramref name="Geometry"/> is its stored coarse line as <c>[[lon,lat],...]</c>, simplified further when the moves of the
/// trip together would carry too many vertices (see <see cref="Range.VertexBudget"/>).
/// </summary>
public sealed record TripMoveDto(long Id, string? Mode, double DistanceMeters, double[][] Geometry);

/// <summary>
/// A local day of the trip (<c>yyyy-MM-dd</c>): <paramref name="Description"/> says where it was spent ("Oslo → Lisbon"),
/// <paramref name="Highlights"/> are up to three named places with the most time that day, leaving out where the nights around it
/// were spent, and the ground distance and flights are of the day's moves (see <see cref="TripDays.Days"/>).
/// </summary>
public sealed record TripDayDto(string Date, string Description, IReadOnlyList<string> Highlights, double GroundDistanceMeters, int Flights);
