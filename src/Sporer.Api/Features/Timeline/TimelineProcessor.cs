using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text;
using Sporer.Api.Features.Moves;
using Sporer.Api.Features.Transit;
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
/// <see cref="ReprocessAsync"/>. It reads <c>locationlog</c>, the owner's modes (<c>mode_edit</c>) and the railway and bus-route lines
/// cached in <c>transit_tile</c> (never the network), and writes only <c>segment</c> and <c>place</c>, and the tiles its moves needed and
/// did not have (to be fetched in the background, see <see cref="TransitTileStore.RecordNeededAsync"/>). The same points, edits and cached
/// lines give the same segments, however the time is cut into rebuilds.
/// </summary>
public sealed class TimelineProcessor(
    PointStore points,
    PlaceStore places,
    SegmentStore segments,
    ModeEditStore modeEdits,
    TransitTileStore transitTiles,
    DetectionOptions options,
    TimeProvider time) : ITimelineProcessor
{
    /// <summary>
    /// How many times a rebuild loads cached tiles for its moves. Once is enough (see <see cref="ModesAsync"/>); the second is there should
    /// the classifier ever ask for a tile with some cached that it did not ask for with none.
    /// </summary>
    private const int MaxTileLoads = 2;

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

            // Each move's mode (the owner's, or detected with the lines cached so far), and then the pieces of one train ride as one move.
            // A ride joined from several pieces counts as the owner's when the mode of any train in it was; a move whose mode the owner
            // set is never taken into a train ride for being short (see TrainMerger).
            var modes = await ModesAsync(kept, ct);
            var merged = TrainMerger.Merge(
                [.. kept.Select(s => s is MoveSegment m ? new ModedSegment(s, modes.ModeOf(m), modes.IsEdited(m)) : new ModedSegment(s, null))],
                options);

            var matcher = new PlaceMatcher(await places.LoadMatchableAsync(ct), options.PlaceRadiusMeters);
            var stored = new List<StoredSegment>(merged.Count);
            foreach (var (segment, mode, edited) in merged)
            {
                stored.Add(segment switch
                {
                    StaySegment stay => MapStay(stay, await PlaceIdAsync(matcher, stay.Centre, ct)),
                    MoveSegment move => MapMove(move, mode ?? throw new InvalidOperationException("A move has no mode."), edited),
                    GapSegment gap => MapGap(gap),
                    _ => throw new InvalidOperationException($"Unexpected segment type {segment.GetType().Name}."),
                });
            }

            await segments.ReplaceAsync(t0, t1, stored, ct);

            // The tiles that could change a mode and are not cached are fetched in the background; when one arrives, the stretch of the
            // moves that needed it is rebuilt.
            await transitTiles.RecordNeededAsync(modes.Needed, time.GetUtcNow().UtcDateTime, ct);

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
    /// then match). A place that was merged into another is known too, and the stay is stored at it, not at the survivor: the views
    /// follow the merge when they read it, and separating the two places gives the stay back. A stay at a position that is not on the globe (ingest stores whatever a client sends) gets no place:
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

    /// <summary>
    /// The mode of every move of <paramref name="kept"/>. A move that an edit of the owner covers more than half of has the edit's mode (see
    /// <see cref="ModeEditStore.Find"/>), and needs no lines. The others are classified by <see cref="TransitClassifier"/> with the lines
    /// cached in the database: first with none, which tells which tiles they could need, and then with those of them that are cached. A
    /// tile that is cached can only keep a rule from asking for more, so that is all a move asks for; should the second pass ask for one the
    /// first did not, it is loaded and the moves are classified again. The tiles that the final pass still found missing are
    /// <see cref="MoveModes.Needed"/>, each with the time of the move that asked for it.
    /// </summary>
    private async Task<MoveModes> ModesAsync(IReadOnlyList<Segment> kept, CancellationToken ct)
    {
        var modes = new MoveModes();
        var moves = kept.OfType<MoveSegment>().ToList();
        if (moves.Count == 0)
            return modes;

        var edits = await modeEdits.FindOverlappingAsync(moves[0].StartUtc, moves[^1].EndUtc, ct);
        var detect = new List<MoveSegment>(moves.Count);
        foreach (var move in moves)
        {
            if (ModeEditStore.Find(edits, move.StartUtc, move.EndUtc) is { } owned)
                modes.Set(move, owned, edited: true);
            else
                detect.Add(move);
        }

        var cache = new TransitLineCache();
        var looked = new HashSet<TransitTile>();
        var results = new TransitResult[detect.Count];
        for (var loads = 0; ; loads++)
        {
            var source = new AskingSource(cache);
            for (var k = 0; k < detect.Count; k++)
                results[k] = TransitClassifier.Classify(detect[k], options, source);

            var unseen = source.NotCached.Where(t => !looked.Contains(t)).ToList();
            if (unseen.Count == 0 || loads == MaxTileLoads)
                break;
            looked.UnionWith(unseen);
            foreach (var (tile, lines) in await transitTiles.LoadAsync(unseen, ct))
                cache.Set(tile, lines);
        }

        for (var k = 0; k < detect.Count; k++)
        {
            modes.Set(detect[k], results[k].Mode, edited: false);
            foreach (var tile in results[k].Missing)
                modes.Needed.Add(new NeededTile(tile, detect[k].StartUtc, detect[k].EndUtc));
        }
        return modes;
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

    /// <summary>
    /// A move as <paramref name="mode"/>: a flight is drawn as the arc between take-off and landing at either level of detail and measured
    /// along it, every other mode (a train the segmenter took for a flight too) along the path of its points (see <see cref="MoveGeometry"/>).
    /// </summary>
    private StoredSegment MapMove(MoveSegment move, TravelMode mode, bool edited)
    {
        var first = move.Points[0].Position;
        var last = move.Points[^1].Position;
        var (detail, coarse) = MoveGeometry.Lines(move, mode, options);

        return Stored("move", move, LocalTime.TimeZoneAt(first), LocalTime.TimeZoneAt(last)) with
        {
            Mode = TravelModeNames.Name(mode),
            ModeEdited = edited,
            DistanceM = MoveGeometry.DistanceMeters(move, mode),
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

    /// <summary>
    /// The modes of the moves of one rebuild (by the move itself, not by its value), whether each is the owner's, and the tiles the moves
    /// needed and did not have.
    /// </summary>
    private sealed class MoveModes
    {
        private readonly Dictionary<MoveSegment, (TravelMode Mode, bool Edited)> _byMove = new(ReferenceEqualityComparer.Instance);

        public List<NeededTile> Needed { get; } = [];

        public void Set(MoveSegment move, TravelMode mode, bool edited) => _byMove[move] = (mode, edited);

        public TravelMode ModeOf(MoveSegment move) => _byMove[move].Mode;

        /// <summary>Whether the owner set the mode of <paramref name="move"/>.</summary>
        public bool IsEdited(MoveSegment move) => _byMove[move].Edited;
    }

    /// <summary>The cached lines of a rebuild, given to the classifier, noting each tile it asked for that is not among them.</summary>
    private sealed class AskingSource(TransitLineCache cache) : ITransitLineSource
    {
        public HashSet<TransitTile> NotCached { get; } = [];

        public bool TryGetLines(TransitTile tile, [NotNullWhen(true)] out TransitLines? lines)
        {
            if (cache.TryGetLines(tile, out lines))
                return true;
            NotCached.Add(tile);
            return false;
        }
    }

    /// <summary>Npgsql writes only UTC values to timestamptz. Everything in the timeline is UTC; unspecified means UTC too.</summary>
    private static DateTime AsUtc(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
    };
}
