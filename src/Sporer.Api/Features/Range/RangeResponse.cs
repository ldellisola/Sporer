using System.Text.Json.Serialization;

namespace Sporer.Api.Features.Range;

/// <summary>
/// A stretch of local days of the timeline, as served by <c>GET /api/range</c>: every move of it, the places it was spent at,
/// and a list of its days. <paramref name="From"/> and <paramref name="To"/> are the dates asked for (<c>yyyy-MM-dd</c>, both
/// included). <paramref name="State"/> is <c>done</c>, or <c>pending</c> when part of the period may still change because
/// points of it wait to be processed.
/// </summary>
public sealed record RangeResponse(
    string From,
    string To,
    string State,
    RangeSummary Summary,
    IReadOnlyList<RangeMoveDto> Moves,
    IReadOnlyList<RangePlaceDto> Places,
    IReadOnlyList<RangeDayDto> Days);

/// <summary>
/// <paramref name="Places"/> is the number of places in the response; <paramref name="DistanceMeters"/>,
/// <paramref name="MovingSeconds"/> and <paramref name="Moves"/> add up its moves, each as a whole (a drive that began the
/// evening before the range counts in full).
/// </summary>
public sealed record RangeSummary(int Places, double DistanceMeters, long MovingSeconds, int Moves);

/// <summary>
/// A move to draw. <paramref name="Mode"/> is <c>walk</c>, <c>cycle</c>, <c>drive</c> or <c>flight</c>; <paramref name="Geometry"/>
/// is its stored coarse line as <c>[[lon,lat],...]</c>, simplified further when the response would otherwise carry too many
/// vertices (see <see cref="VertexBudget"/>).
/// </summary>
public sealed record RangeMoveDto(long Id, string? Mode, DateTime Start, DateTime End, double[][] Geometry);

/// <summary>
/// A place that was visited: its id (the one that survives a merge), its name (the owner's, else OpenStreetMap's, else null) and
/// centre, the <paramref name="Seconds"/> spent there within the range and the number of <paramref name="Visits"/> (stays) that
/// time was spent in.
/// </summary>
public sealed record RangePlaceDto(
    long Id,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? City,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Country,
    double Lat,
    double Lon,
    long Seconds,
    int Visits);

/// <summary>
/// A local day (<c>yyyy-MM-dd</c>) on which a segment starts: the distance and time of the moves that start on it, and the
/// number of distinct places its stays are at.
/// </summary>
public sealed record RangeDayDto(string Date, double DistanceMeters, long MovingSeconds, int Places);
