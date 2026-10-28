using System.Text.Json.Serialization;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// One trip with all its page is drawn from, as served by <c>GET /api/trips/{id}</c>: its <see cref="TripSummary"/>, as a list
/// item has it, and its <see cref="Stats"/>, <see cref="Moves"/> and <see cref="Days"/>, but not the list's thumbnail. For an
/// ongoing trip the last of its days is the day after its last night, and its moves and stays are those of the timeline so far.
/// </summary>
public sealed record TripResponse : TripSummary
{
    public TripResponse(
        TripSummary summary, TripStatsDto stats, IReadOnlyList<TripMoveDto> moves, IReadOnlyList<TripDayDto> days) : base(summary)
    {
        Stats = stats;
        Moves = moves;
        Days = days;
    }

    [JsonPropertyOrder(1)]
    public TripStatsDto Stats { get; }

    [JsonPropertyOrder(1)]
    public IReadOnlyList<TripMoveDto> Moves { get; }

    [JsonPropertyOrder(1)]
    public IReadOnlyList<TripDayDto> Days { get; }
}

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
