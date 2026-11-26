namespace Sporer.Timeline;

/// <summary>
/// A segment with the mode it ended up with: a move's final mode, or null for a stay or a gap (or a move without one).
/// <paramref name="Edited"/> says the owner set the mode (of the move, or of a piece of a train ride joined from several).
/// </summary>
public readonly record struct ModedSegment(Segment Segment, TravelMode? Mode, bool Edited = false);

/// <summary>
/// Joins the pieces of one train ride (transit spec section 2, last paragraph). A fast train is cut by the segmenter wherever it
/// slows below flight speed, and the pieces come out as adjacent moves; once each has its final mode, adjacent moves that are
/// both trains, with nothing between them, are one ride. A slow stretch too short to be a train of its own (shorter than
/// <see cref="DetectionOptions.TrainMinDistanceKm"/>) that touches a train on each side is part of the ride too: the drive rule
/// never makes so short a move a train, so it would come out as a bus (or a walk) and cut the ride in two.
/// </summary>
public static class TrainMerger
{
    /// <summary>
    /// <paramref name="segments"/> (in time order) with every run of consecutive train moves that touch (each starts at the
    /// instant the one before it ends) joined into one train move, by <see cref="Join"/>, together with any move between two of them
    /// that is a short slow stretch of the same ride (see <see cref="IsDip"/>). The joined ride is edited when any train joined into
    /// it was. Everything else is returned as it is, in order.
    /// </summary>
    public static IReadOnlyList<ModedSegment> Merge(IReadOnlyList<ModedSegment> segments, DetectionOptions options)
    {
        ArgumentNullException.ThrowIfNull(segments);
        ArgumentNullException.ThrowIfNull(options);

        var merged = new List<ModedSegment>(segments.Count);
        for (var k = 0; k < segments.Count; k++)
        {
            var segment = segments[k];
            if (merged.Count > 0 && merged[^1] is { Mode: TravelMode.Train, Segment: MoveSegment before } ride)
            {
                if (segment is { Mode: TravelMode.Train, Segment: MoveSegment after } && before.EndUtc == after.StartUtc)
                {
                    merged[^1] = new ModedSegment(Join(before, after), TravelMode.Train, ride.Edited || segment.Edited);
                    continue;
                }

                if (k + 1 < segments.Count
                    && segments[k + 1] is { Mode: TravelMode.Train, Segment: MoveSegment next } rest
                    && IsDip(segment, before, next, options))
                {
                    var piece = (MoveSegment)segment.Segment;
                    merged[^1] = new ModedSegment(Join(Join(before, piece), next), TravelMode.Train, ride.Edited || rest.Edited);
                    k++;
                    continue;
                }
            }

            merged.Add(segment);
        }
        return merged;
    }

    /// <summary>
    /// One move from the start of <paramref name="first"/> to the end of <paramref name="second"/>, through the points of both.
    /// The segmenter gives two adjacent moves the point between them (the last of the first is the first of the second); that point
    /// is kept once. It is not a flight: what is joined is ground travel.
    /// </summary>
    public static MoveSegment Join(MoveSegment first, MoveSegment second)
    {
        ArgumentNullException.ThrowIfNull(first);
        ArgumentNullException.ThrowIfNull(second);

        var points = new List<TrackPoint>(first.Points.Count + second.Points.Count);
        points.AddRange(first.Points);
        var skip = first.Points.Count > 0 && second.Points.Count > 0 && SamePoint(first.Points[^1], second.Points[0]) ? 1 : 0;
        for (var k = skip; k < second.Points.Count; k++)
            points.Add(second.Points[k]);
        return new MoveSegment(first.StartUtc, second.EndUtc, points, IsFlight: false);
    }

    /// <summary>
    /// Whether <paramref name="piece"/> is where a train ride slowed down for a moment: a move that is not a flight, whose mode the
    /// owner did not set, that starts the instant <paramref name="before"/> ends and ends the instant <paramref name="after"/> starts,
    /// and whose path (the sum of its hops) is shorter than <see cref="DetectionOptions.TrainMinDistanceKm"/>. The segmenter puts
    /// runs of the same kind together, so a move between two others is the slow part between two fast ones: a train that slowed
    /// below flight speed, for one noisy fix or a few hundred metres.
    /// </summary>
    private static bool IsDip(ModedSegment piece, MoveSegment before, MoveSegment after, DetectionOptions options)
        => piece is { Edited: false, Mode: not null, Segment: MoveSegment { IsFlight: false } move }
           && before.EndUtc == move.StartUtc
           && move.EndUtc == after.StartUtc
           && MoveGeometry.DistanceMeters(move, TravelMode.Train) < options.TrainMinDistanceKm * 1000;

    /// <summary>The same fix: one device, one time, one position (the motion array is not compared).</summary>
    private static bool SamePoint(TrackPoint a, TrackPoint b)
        => ReferenceEquals(a, b)
           || (a.TimeUtc == b.TimeUtc && a.Device == b.Device && a.Latitude == b.Latitude && a.Longitude == b.Longitude);
}
