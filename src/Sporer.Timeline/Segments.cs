namespace Sporer.Timeline;

/// <summary>
/// One stretch of a person's track: a stay, a move (route or flight) or a gap with no data. Times are UTC. The
/// segments <see cref="Segmenter.Split"/> returns are ordered and each starts where the previous one ends.
/// </summary>
public abstract record Segment(DateTime StartUtc, DateTime EndUtc);

/// <summary>Time spent in one place. <paramref name="Points"/> are the track points that belong to it.</summary>
public sealed record StaySegment(DateTime StartUtc, DateTime EndUtc, GeoPoint Centre, IReadOnlyList<TrackPoint> Points)
    : Segment(StartUtc, EndUtc);

/// <summary>
/// Travel between two places, along <paramref name="Points"/>. <paramref name="IsFlight"/> marks a flight; the travel
/// mode of the other moves is classified later.
/// </summary>
public sealed record MoveSegment(DateTime StartUtc, DateTime EndUtc, IReadOnlyList<TrackPoint> Points, bool IsFlight)
    : Segment(StartUtc, EndUtc);

/// <summary>A pause in logging (phone off, no signal) outside a stay, from the last position known to the next one.</summary>
public sealed record GapSegment(DateTime StartUtc, DateTime EndUtc, GeoPoint From, GeoPoint To)
    : Segment(StartUtc, EndUtc);

/// <summary>How a move was travelled.</summary>
public enum TravelMode { Walk, Cycle, Drive, Flight }
