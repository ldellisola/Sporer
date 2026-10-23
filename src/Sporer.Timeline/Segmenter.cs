namespace Sporer.Timeline;

/// <summary>
/// Second detection step: splits a cleaned track into stays, moves (routes and flights) and gaps (spec section 6.4).
/// Mode classification, place matching and simplification are separate, later steps.
/// </summary>
public static class Segmenter
{
    /// <summary>
    /// Splits <paramref name="cleaned"/> (the output of <see cref="PointCleaner.Clean"/>) into ordered, non-overlapping
    /// segments, each starting where the previous one ends. Stays come first; what lies between two stays (or before the
    /// first, after the last) is then cut into moves, flights and gaps.
    /// </summary>
    public static IReadOnlyList<Segment> Split(IReadOnlyList<TrackPoint> cleaned, DetectionOptions o)
    {
        ArgumentNullException.ThrowIfNull(cleaned);
        ArgumentNullException.ThrowIfNull(o);

        var segments = new List<Segment>();
        if (cleaned.Count == 0)
            return segments;

        var stays = MergeStays(FindStays(cleaned, o), o);
        if (stays.Count == 0)
        {
            SplitBetween(cleaned, 0, cleaned.Count - 1, cleaned[0].TimeUtc, o, segments);
            return segments;
        }

        // Before the first stay: the move starts at its own first point.
        SplitBetween(cleaned, 0, stays[0].First, cleaned[0].TimeUtc, o, segments);
        for (var s = 0; s < stays.Count; s++)
        {
            var stay = stays[s];
            segments.Add(new StaySegment(stay.Start, stay.End, stay.Centre, stay.Points));

            // Between two stays, or after the last: from this stay's end to the next stay's first point (or the last point).
            var next = s + 1 < stays.Count ? stays[s + 1].First : cleaned.Count - 1;
            SplitBetween(cleaned, stay.Last, next, stay.End, o, segments);
        }
        return segments;
    }

    // ---- stays -------------------------------------------------------------------------------------------------

    /// <summary>
    /// Anchored at its first point, a stay takes every following point within the stay radius of that point. It counts
    /// when it lasts at least the minimum duration. Where logging then goes silent while the person stayed put, the
    /// stay is extended to when they must have set off for the next point.
    /// </summary>
    private static List<Stay> FindStays(IReadOnlyList<TrackPoint> p, DetectionOptions o)
    {
        var stays = new List<Stay>();
        var i = 0;
        while (i < p.Count)
        {
            var j = i;
            while (j + 1 < p.Count && Geo.DistanceMeters(p[i].Position, p[j + 1].Position) <= o.StayRadiusMeters)
                j++;

            var end = StayEnd(p, j, o);
            if (end - p[i].TimeUtc >= o.StayMinDuration)
            {
                stays.Add(new Stay(i, j, p[i].TimeUtc, end, Slice(p, i, j)));
                i = j + 1;
            }
            else
            {
                i++;
            }
        }
        return stays;
    }

    /// <summary>
    /// A stay's end: its last point, unless the next point comes after a pause of at least the minimum stay duration and
    /// implies a speed below the stationary limit. Then the person is assumed to have stayed until they could just walk
    /// to that point (never before the last point of the stay).
    /// </summary>
    private static DateTime StayEnd(IReadOnlyList<TrackPoint> p, int last, DetectionOptions o)
    {
        var end = p[last].TimeUtc;
        if (last + 1 >= p.Count)
            return end;

        var pause = p[last + 1].TimeUtc - end;
        var meters = Geo.DistanceMeters(p[last].Position, p[last + 1].Position);
        if (pause < o.StayMinDuration || meters / pause.TotalSeconds >= o.StationaryGapMaxSpeedMps)
            return end;

        var walkSeconds = o.WalkingSpeedMps > 0 ? meters / o.WalkingSpeedMps : double.PositiveInfinity;
        return p[last + 1].TimeUtc - TimeSpan.FromSeconds(Math.Min(walkSeconds, pause.TotalSeconds));
    }

    /// <summary>
    /// Consecutive stays whose centres are within the stay radius and that are less than the minimum stay duration
    /// apart are one stay: the person was in the same place and the points between them were GPS drift. The merged
    /// stay spans both, keeps the points of both and drops the drift points between them.
    /// </summary>
    private static List<Stay> MergeStays(List<Stay> stays, DetectionOptions o)
    {
        var merged = new List<Stay>(stays.Count);
        foreach (var stay in stays)
        {
            if (merged.Count > 0
                && stay.Start - merged[^1].End < o.StayMinDuration
                && Geo.DistanceMeters(merged[^1].Centre, stay.Centre) <= o.StayRadiusMeters)
                merged[^1].Absorb(stay);
            else
                merged.Add(stay);
        }
        return merged;
    }

    // ---- moves, flights and gaps -------------------------------------------------------------------------------

    private enum PairKind { Normal, Gap, FlightHop }

    /// <summary>
    /// Cuts the track points <paramref name="lo"/>..<paramref name="hi"/> (inclusive; the first and last are the
    /// neighbouring stays' points, kept for continuity of the line) into moves, flights and gaps by consecutive pairs.
    /// The run starts at <paramref name="start"/> (the previous stay's end, which can be after its last point) and ends at
    /// the time of point <paramref name="hi"/>; every segment starts where the one before it ends.
    /// </summary>
    private static void SplitBetween(
        IReadOnlyList<TrackPoint> p, int lo, int hi, DateTime start, DetectionOptions o, List<Segment> output)
    {
        if (hi <= lo)
            return;

        // Pair k joins point lo+k to point lo+k+1. Time starts at 'start' rather than at the first point.
        var pairs = hi - lo;
        var meters = new double[pairs];
        var elapsed = new TimeSpan[pairs];
        var kinds = new PairKind[pairs];
        for (var k = 0; k < pairs; k++)
        {
            meters[k] = Geo.DistanceMeters(p[lo + k].Position, p[lo + k + 1].Position);
            elapsed[k] = p[lo + k + 1].TimeUtc - (k == 0 ? start : p[lo + k].TimeUtc);
            kinds[k] = IsFlightHop(meters[k], elapsed[k], o) ? PairKind.FlightHop : NonFlightKind(elapsed[k], o);
        }

        DemoteShortFlights(kinds, meters, elapsed, o);

        DateTime TimeAt(int index) => index == lo ? start : p[index].TimeUtc;
        var from = 0;
        while (from < pairs)
        {
            if (kinds[from] == PairKind.Gap)
            {
                output.Add(new GapSegment(TimeAt(lo + from), TimeAt(lo + from + 1), p[lo + from].Position, p[lo + from + 1].Position));
                from++;
                continue;
            }

            var to = from;
            while (to + 1 < pairs && kinds[to + 1] == kinds[from])
                to++;
            var points = Slice(p, lo + from, lo + to + 1);
            output.Add(new MoveSegment(TimeAt(lo + from), TimeAt(lo + to + 1), points, kinds[from] == PairKind.FlightHop));
            from = to + 1;
        }
    }

    /// <summary>A run of fast hops is a flight only if it covers the minimum flight distance; its hops are otherwise ordinary.</summary>
    private static void DemoteShortFlights(PairKind[] kinds, double[] meters, TimeSpan[] elapsed, DetectionOptions o)
    {
        var from = 0;
        while (from < kinds.Length)
        {
            if (kinds[from] != PairKind.FlightHop)
            {
                from++;
                continue;
            }

            var to = from;
            var total = meters[from];
            while (to + 1 < kinds.Length && kinds[to + 1] == PairKind.FlightHop)
                total += meters[++to];

            if (total < o.FlightMinDistanceKm * 1000)
            {
                for (var k = from; k <= to; k++)
                    kinds[k] = NonFlightKind(elapsed[k], o);
            }
            from = to + 1;
        }
    }

    private static bool IsFlightHop(double meters, TimeSpan elapsed, DetectionOptions o)
        => SpeedKmh(meters, elapsed) >= o.FlightSpeedKmh;

    /// <summary>A pause in logging of at least the gap duration is a gap, anything shorter is plain movement.</summary>
    private static PairKind NonFlightKind(TimeSpan elapsed, DetectionOptions o)
        => elapsed >= o.GapMinDuration ? PairKind.Gap : PairKind.Normal;

    /// <summary>Implied speed of a hop; points with the same time but different places imply an infinite one.</summary>
    private static double SpeedKmh(double meters, TimeSpan elapsed)
        => elapsed <= TimeSpan.Zero
            ? meters > 0 ? double.PositiveInfinity : 0
            : meters / elapsed.TotalSeconds * 3.6;

    // ---- helpers -----------------------------------------------------------------------------------------------

    private static TrackPoint[] Slice(IReadOnlyList<TrackPoint> p, int first, int last)
    {
        var slice = new TrackPoint[last - first + 1];
        for (var k = 0; k < slice.Length; k++)
            slice[k] = p[first + k];
        return slice;
    }

    /// <summary>
    /// Mean position of <paramref name="points"/>. Longitudes are averaged as offsets from the first point so that a stay
    /// straddling the antimeridian does not average to the wrong side of the world.
    /// </summary>
    private static GeoPoint Mean(IReadOnlyList<TrackPoint> points)
    {
        var reference = points[0].Longitude;
        double latitude = 0, longitudeOffset = 0;
        foreach (var point in points)
        {
            latitude += point.Latitude;
            var delta = point.Longitude - reference;
            longitudeOffset += delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta;
        }

        var longitude = reference + longitudeOffset / points.Count;
        return new GeoPoint(latitude / points.Count, longitude >= 180 ? longitude - 360 : longitude < -180 ? longitude + 360 : longitude);
    }

    /// <summary>A stay while it is being found and merged. <see cref="First"/> and <see cref="Last"/> index the cleaned track.</summary>
    private sealed class Stay(int first, int last, DateTime start, DateTime end, TrackPoint[] points)
    {
        private List<TrackPoint>? _merged;
        private GeoPoint? _centre;

        public int First { get; } = first;
        public int Last { get; private set; } = last;
        public DateTime Start { get; } = start;
        public DateTime End { get; private set; } = end;
        public IReadOnlyList<TrackPoint> Points => (IReadOnlyList<TrackPoint>?)_merged ?? points;
        public GeoPoint Centre => _centre ??= Mean(Points);

        /// <summary>Takes over the later stay: it ends where that one ends and keeps the points of both.</summary>
        public void Absorb(Stay later)
        {
            _merged ??= [.. points];
            _merged.AddRange(later.Points);
            Last = later.Last;
            End = later.End;
            _centre = null;
        }
    }
}
