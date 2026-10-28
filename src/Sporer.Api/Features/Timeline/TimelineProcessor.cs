using System.Globalization;
using System.Text;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

/// <summary>
/// What a rebuild did: <paramref name="Written"/> segments were stored, and the timeline between <paramref name="RebuiltFromUtc"/>
/// and <paramref name="RebuiltToUtc"/> is what was recomputed. That is the range that was asked for, widened to the stays
/// around it where there are any (with none stored, it is the range itself), and it is the window whatever is derived from
/// the segments (the nights, the homes and the trips) has to be refreshed over.
/// </summary>
public sealed record ReprocessResult(int Written, DateTime RebuiltFromUtc, DateTime RebuiltToUtc);

/// <summary>Rebuilds the derived timeline (segments and places) from the raw points of a time range.</summary>
public interface ITimelineProcessor
{
    /// <summary>
    /// Reprocesses <paramref name="fromUtc"/> to <paramref name="toUtc"/> and returns how many segments were written and the
    /// window that was rebuilt (see <see cref="ReprocessResult"/>).
    /// The range is widened to the stays around it (see <see cref="SegmentStore.FindAnchorsAsync"/>), so the result is
    /// the same as processing all the data at once. Where no stay follows and nothing later is stored, the rebuild stops
    /// at the first point after the range, so the last segments may be cut short until a later run (which starts at the
    /// last stay before it) completes them. The rebuild does not reach back into a stretch that was set aside after repeated
    /// failures (see <see cref="SegmentStore.FindAnchorsAsync"/>).
    /// </summary>
    Task<ReprocessResult> ReprocessAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct);
}

/// <summary>
/// The one path that turns raw points into stored segments and places: backfill, live ingest and edits all go through
/// <see cref="ReprocessAsync"/>. It reads <c>locationlog</c> and writes only <c>segment</c> and <c>place</c>.
/// </summary>
public sealed class TimelineProcessor(
    PointStore points,
    PlaceStore places,
    SegmentStore segments,
    DetectionOptions options) : ITimelineProcessor
{
    /// <summary>
    /// Runs do not overlap: two concurrent rebuilds of the same range would both delete and then both insert, leaving
    /// every segment twice, and could create the same new place twice.
    /// </summary>
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<ReprocessResult> ReprocessAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct)
    {
        var from = AsUtc(fromUtc);
        var to = AsUtc(toUtc);
        if (to < from)
            throw new ArgumentOutOfRangeException(nameof(toUtc), toUtc, "The range must not end before it starts.");

        await _gate.WaitAsync(ct);
        try
        {
            var (t0, t1) = await segments.FindAnchorsAsync(from, to, ct);

            // Load up to the closing stay's end (T1). Without a later stay there is no such edge, and loading to the end of
            // the data would segment the whole history on a first backfill: load up to the range's end instead, or up to
            // the end of what is stored when that is later (a late point in the middle of a stored move must not cut
            // the rebuild short: everything stored after T0 is deleted, so everything stored has to be rebuilt).
            // The first point after the bound comes along so the last stay or move is closed by real data; a chunk
            // that ends in the middle of one leaves it cut, and the next chunk starts again at the last stay before it.
            var upper = t1 ?? Latest(to, await segments.FindLastEndAsync(ct));
            var loaded = await points.LoadAsync(t0, upper, includeNextPoint: true, ct);
            var split = Segmenter.Split(PointCleaner.Clean(loaded, options), options);

            // What starts at the closing stay's end (the move leaving it) is stored already and is not rewritten.
            // Moves and gaps that take no time carry nothing and are dropped; stays are always kept.
            var kept = split
                .Where(s => t1 is not { } end || s.StartUtc < end)
                .Where(s => s is StaySegment || s.EndUtc > s.StartUtc)
                .ToList();

            var matcher = new PlaceMatcher(await places.LoadMatchableAsync(ct), options.PlaceRadiusMeters);
            var stored = new List<StoredSegment>(kept.Count);
            foreach (var segment in kept)
            {
                stored.Add(segment switch
                {
                    StaySegment stay => MapStay(stay, await PlaceIdAsync(matcher, stay.Centre, ct)),
                    MoveSegment move => MapMove(move),
                    GapSegment gap => MapGap(gap),
                    _ => throw new InvalidOperationException($"Unexpected segment type {segment.GetType().Name}."),
                });
            }

            await segments.ReplaceAsync(t0, t1, stored, ct);

            // From the first anchor to where the load stopped: the closing stay's end when there is one, else the end of what was
            // loaded. Everything stored between the two was replaced.
            return new ReprocessResult(stored.Count, t0, upper);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// The place a stay belongs to: the nearest known one within the match radius, else a new one (which later stays
    /// then match). A stay at a position that is not on the globe (ingest stores whatever a client sends) gets no place:
    /// the matcher rejects such a position, and one bad point must not stop the range from being processed.
    /// </summary>
    private async Task<long?> PlaceIdAsync(PlaceMatcher matcher, GeoPoint centre, CancellationToken ct)
    {
        if (!IsPosition(centre))
            return null;

        if (matcher.Match(centre) is { } known)
            return known;

        var created = await places.CreateAsync(centre, ct);
        matcher.Add(created, centre); // only fresh ids: the matcher throws on a duplicate
        return created;
    }

    private static DateTime Latest(DateTime a, DateTime? b) => b is { } later && later > a ? later : a;

    private static bool IsPosition(GeoPoint p)
        => double.IsFinite(p.Latitude) && double.IsFinite(p.Longitude) && p.Latitude is >= -90 and <= 90;

    private static StoredSegment MapStay(StaySegment stay, long? placeId)
    {
        var zone = LocalTime.TimeZoneAt(stay.Centre);
        return Stored("stay", stay, zone, zone) with
        {
            PlaceId = placeId,
            Latitude = stay.Centre.Latitude,
            Longitude = stay.Centre.Longitude,
            PointCount = stay.Points.Count,
        };
    }

    private StoredSegment MapMove(MoveSegment move)
    {
        var first = move.Points[0].Position;
        var last = move.Points[^1].Position;

        // A flight is drawn as the arc between take-off and landing at either level of detail.
        var (detail, coarse) = move.IsFlight
            ? (Geo.GreatCircle(first, last), Geo.GreatCircle(first, last))
            : (LineSimplifier.Simplify(Positions(move), options.DetailToleranceMeters),
               LineSimplifier.Simplify(Positions(move), options.CoarseToleranceMeters));

        return Stored("move", move, LocalTime.TimeZoneAt(first), LocalTime.TimeZoneAt(last)) with
        {
            Mode = ModeClassifier.Classify(move, options).ToString().ToLowerInvariant(),
            DistanceM = ModeClassifier.DistanceMeters(move),
            GeometryDetailJson = ToJson(detail),
            GeometryCoarseJson = ToJson(coarse),
            PointCount = move.Points.Count,
        };
    }

    /// <summary>A gap has no route, but the positions either side of it are kept as a two-point line.</summary>
    private static StoredSegment MapGap(GapSegment gap)
    {
        var ends = ToJson([gap.From, gap.To]);
        return Stored("gap", gap, LocalTime.TimeZoneAt(gap.From), LocalTime.TimeZoneAt(gap.To)) with
        {
            GeometryDetailJson = ends,
            GeometryCoarseJson = ends,
        };
    }

    /// <summary>
    /// A segment's times, zones and local dates; the caller adds what is particular to its kind. The dates are the two
    /// ends' local dates, each in its own zone, put in order: a segment that crosses zones westward just after local
    /// midnight (a flight from Tokyo to San Francisco) ends on an earlier local date than it started on, and the day
    /// query (<c>local_start_date &lt;= day &lt;= local_end_date</c>) would find it on no day.
    /// </summary>
    private static StoredSegment Stored(string kind, Segment segment, string startZone, string endZone)
    {
        var start = AsUtc(segment.StartUtc);
        var end = AsUtc(segment.EndUtc);
        var startDate = LocalTime.LocalDate(start, startZone);
        var endDate = LocalTime.LocalDate(end, endZone);
        return new StoredSegment(
            kind, start, end, startZone, endZone,
            startDate <= endDate ? startDate : endDate, startDate <= endDate ? endDate : startDate,
            PlaceId: null, Latitude: null, Longitude: null, Mode: null, DistanceM: null,
            GeometryDetailJson: null, GeometryCoarseJson: null, PointCount: 0);
    }

    private static List<GeoPoint> Positions(MoveSegment move) => [.. move.Points.Select(p => p.Position)];

    /// <summary><c>[[lon,lat],...]</c>, each coordinate rounded to 6 decimals (about 0.1 m).</summary>
    private static string ToJson(IReadOnlyList<GeoPoint> line)
    {
        var json = new StringBuilder("[");
        for (var k = 0; k < line.Count; k++)
        {
            if (k > 0)
                json.Append(',');
            json.Append('[').Append(Coordinate(line[k].Longitude)).Append(',').Append(Coordinate(line[k].Latitude)).Append(']');
        }
        return json.Append(']').ToString();
    }

    private static string Coordinate(double degrees)
    {
        var rounded = Math.Round(degrees, 6);
        return (rounded == 0 ? 0 : rounded).ToString("0.######", CultureInfo.InvariantCulture); // no "-0", no exponent
    }

    /// <summary>Npgsql writes only UTC values to timestamptz. Everything in the timeline is UTC; unspecified means UTC too.</summary>
    private static DateTime AsUtc(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
    };
}
