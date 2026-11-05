using System.Text.Json.Serialization;
using Sporer.Timeline;

namespace Sporer.Api.Features.Points;

/// <summary>
/// One raw point in full, as served by <c>GET /api/points/detail</c>: what is stored of it (<paramref name="SpeedMps"/>, <paramref name="AccuracyM"/>
/// and <paramref name="Motion"/> are null on rows that came without them), its time as UTC and as the clock of the place it is at
/// (<paramref name="LocalTime"/> is <c>yyyy-MM-ddTHH:mm:ss</c> with no offset, <paramref name="Zone"/> the IANA zone it was worked out in), and
/// <paramref name="Status"/>: <c>used</c>, <c>poorAccuracy</c>, <c>glitch</c>, <c>duplicate</c> or <c>removed</c>. <paramref name="T"/> is the
/// time as microseconds since the epoch, as everywhere a point is named.
/// </summary>
public sealed record PointDetailResponse(
    string Device,
    long T,
    DateTime TimeUtc,
    string LocalTime,
    string Zone,
    double Lat,
    double Lon,
    double? AccuracyM,
    double? SpeedMps,
    double AltitudeM,
    string[]? Motion,
    string Status,
    PointNeighbour? Previous,
    PointNeighbour? Next,
    PointSegment? Segment);

/// <summary>
/// The nearest point of any device before or after a point that is not removed: <paramref name="T"/> its time, <paramref name="GapSeconds"/>
/// how long from or to the point, <paramref name="DistanceM"/> how far (great circle) and <paramref name="SpeedKmh"/> what that makes.
/// </summary>
public sealed record PointNeighbour(long T, double GapSeconds, double DistanceM, double SpeedKmh);

/// <summary>The stay, move or gap that covers a point: <paramref name="Kind"/> is <c>stay</c>, <c>move</c> or <c>gap</c>; a stay has its place, a move its mode.</summary>
public sealed record PointSegment(
    string Kind,
    DateTime StartUtc,
    DateTime EndUtc,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] PointPlace? Place,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Mode);

/// <summary>The place a stay is at (the one that survives merges); <paramref name="Name"/> is null while it has none.</summary>
public sealed record PointPlace(long Id, string? Name);

internal static class PointStatusName
{
    public const string Removed = "removed";

    public static string Of(PointStatus status) => status switch
    {
        PointStatus.Used => "used",
        PointStatus.PoorAccuracy => "poorAccuracy",
        PointStatus.Glitch => "glitch",
        PointStatus.Duplicate => "duplicate",
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, null),
    };
}
