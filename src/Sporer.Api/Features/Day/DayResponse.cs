using System.Text.Json;
using System.Text.Json.Serialization;

namespace Sporer.Api.Features.Day;

/// <summary>
/// One local day of the timeline, as served by <c>GET /api/day/{date}</c>. Times are ISO-8601 UTC (<c>Z</c>); the zone
/// each segment starts and ends in comes with it, so the client can show local time. <paramref name="State"/> is
/// <c>done</c>, or <c>pending</c> when the day may still change because points of it wait to be processed.
/// </summary>
public sealed record DayResponse(
    string Date,
    string TimeZone,
    string State,
    DaySummary Summary,
    IReadOnlyList<DaySegmentDto> Segments);

/// <summary>
/// <paramref name="Places"/> counts the distinct places among the stays; <paramref name="DistanceMeters"/> and
/// <paramref name="MovingSeconds"/> add up the moves.
/// </summary>
public sealed record DaySummary(int Places, double DistanceMeters, long MovingSeconds);

/// <summary>
/// A segment of the day. The <c>kind</c> property (<c>stay</c>, <c>move</c> or <c>gap</c>) says which of the three it is.
/// What is particular to a kind is ordered after what the kinds share, so the JSON reads kind, id, times, zones, then the rest.
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(StayDto), "stay")]
[JsonDerivedType(typeof(MoveDto), "move")]
[JsonDerivedType(typeof(GapDto), "gap")]
public abstract record DaySegmentDto(long Id, DateTime Start, DateTime End, string StartTimeZone, string EndTimeZone);

/// <summary>
/// Time spent in one place; <paramref name="Place"/> is null for a stay at a position that matched no place.
/// <paramref name="Home"/> is true when the place is the home in effect on the day served (the home period that covers the
/// date, see <see cref="Trips.TripStore.FindHomeOnAsync"/>) or is within <c>Detection:HomeRadiusMeters</c> of it and was the
/// night location on a night of that home period (GPS drift can split one home into several places, and a stay at any of them
/// is at home), and false for every other stay, one with no place too: a café next door is never where the night is spent, so
/// it is not home. It is always written, so that the client reads a boolean and never the lack of one.
/// </summary>
public sealed record StayDto(
    long Id, DateTime Start, DateTime End, string StartTimeZone, string EndTimeZone,
    [property: JsonPropertyOrder(1), JsonIgnore(Condition = JsonIgnoreCondition.Never)] PlaceDto? Place,
    [property: JsonPropertyOrder(2)] bool Home)
    : DaySegmentDto(Id, Start, End, StartTimeZone, EndTimeZone);

/// <summary>
/// Travel between two stays. <paramref name="Geometry"/> is the stored line as <c>[[lon,lat],...]</c>;
/// <paramref name="Mode"/> is <c>walk</c>, <c>cycle</c>, <c>drive</c> or <c>flight</c>.
/// </summary>
public sealed record MoveDto(
    long Id, DateTime Start, DateTime End, string StartTimeZone, string EndTimeZone,
    [property: JsonPropertyOrder(1)] string? Mode,
    [property: JsonPropertyOrder(1)] double DistanceMeters,
    [property: JsonPropertyOrder(1)] JsonElement Geometry)
    : DaySegmentDto(Id, Start, End, StartTimeZone, EndTimeZone);

/// <summary>Time with no data, from the last position known before it (<paramref name="From"/>) to the first one after it (<paramref name="To"/>).</summary>
public sealed record GapDto(
    long Id, DateTime Start, DateTime End, string StartTimeZone, string EndTimeZone,
    [property: JsonPropertyOrder(1), JsonIgnore(Condition = JsonIgnoreCondition.Never)] LatLon? From,
    [property: JsonPropertyOrder(1), JsonIgnore(Condition = JsonIgnoreCondition.Never)] LatLon? To)
    : DaySegmentDto(Id, Start, End, StartTimeZone, EndTimeZone);

/// <summary>A place's id (the one that survives a merge), its name (the owner's, else OpenStreetMap's, else null) and its centre.</summary>
public sealed record PlaceDto(
    long Id,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? City,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Country,
    double Lat,
    double Lon);

public sealed record LatLon(double Lat, double Lon);
