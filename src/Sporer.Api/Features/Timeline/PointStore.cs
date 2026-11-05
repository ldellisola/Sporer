using Dapper;
using Npgsql;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

/// <summary>
/// The raw points of a stretch that are not removed, with the <see cref="Margin"/> nearest ones before it and after it (each in time order): what
/// decides whether a point at the stretch's edge is a glitch. They carry what the cleaning judges them by: position and accuracy, but no speed or motion.
/// </summary>
public sealed record PointSpan(IReadOnlyList<TrackPoint> Before, IReadOnlyList<TrackPoint> Points, IReadOnlyList<TrackPoint> After)
{
    /// <summary>How many points on each side of a stretch are judged with it. The day's list and one point's detail use the same, so they agree.</summary>
    public const int Margin = 20;

    /// <summary>What the timeline makes of each of <see cref="Points"/> (in their order): the margin and the points are classified together, then sliced to the points.</summary>
    public IReadOnlyList<PointStatus> Classify(DetectionOptions options)
    {
        List<TrackPoint> judged = [.. Before, .. Points, .. After];
        return [.. PointCleaner.Classify(judged, options).Skip(Before.Count).Take(Points.Count)];
    }
}

/// <summary>
/// One stored point in full, as <see cref="PointStore.FindFullAsync"/> reads it. <paramref name="Removed"/> is whether the owner removed it;
/// <paramref name="Window"/> is the point with the <see cref="PointSpan.Margin"/> points before and after it in the order of the day's list
/// (time, then device), not removed, to judge it by; <paramref name="Before"/> and <paramref name="After"/> are the nearest points of any
/// device strictly before and after it in time that are not removed. <c>locationlog</c> has no key, so a re-sent batch can leave twin rows
/// (same device and time, identical); the point is the first of them, and the others are left out of the window (they are always duplicates).
/// </summary>
public sealed record FullPoint(
    TrackPoint Point, double Altitude, bool Removed, PointSpan Window, TrackPoint? Before, TrackPoint? After);

/// <summary>
/// Reads raw points from <c>locationlog</c>. The timeline never writes to that table. Every read leaves out the points the owner
/// removed (the rows of <c>excluded_point</c>, see <see cref="NotExcluded"/>): they are raw points still, and are in no timeline.
/// </summary>
public sealed class PointStore(NpgsqlDataSource dataSource)
{
    /// <summary>
    /// The condition that a point of <c>locationlog</c> (as <c>l</c>) is not one the owner removed. A point is told from another by
    /// its device and its exact time, which is <c>excluded_point</c>'s primary key. The planner takes the anti-join this makes as it finds
    /// cheapest: a probe of that key for each point when few are read (the nearest point of a night, a day with many removals), else one
    /// merge or hash against the table. The scan of the hypertable is not changed by it: it still reads the chunks the time range
    /// names, through the time index, and no more. (Measured on a week of 60 000 points: 21 ms without it, 25 ms with it and no
    /// removals, 26 to 35 ms with two thousand, 100 ms with two hundred thousand.)
    /// </summary>
    internal const string NotExcluded =
        "not exists (select 1 from excluded_point e where e.device = l.device and e.time = l.time)";

    /// <summary>
    /// The points with <c>fromUtc &lt;= time &lt;= toUtc</c>, ordered by time (then device, so equal times come in a stable
    /// order). With <paramref name="includeNextPoint"/> the first point after <paramref name="toUtc"/> is added at the end;
    /// the segmenter needs it to tell when a stay that reaches <paramref name="toUtc"/> really ended. A removed point is neither
    /// in the range nor the next point: the next one is the first that is not removed.
    /// </summary>
    public async Task<List<TrackPoint>> LoadAsync(
        DateTime fromUtc, DateTime toUtc, bool includeNextPoint, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);

        var points = await connection.QueryAsync<PointRow>(new CommandDefinition(
            Select + " where l.time >= @FromUtc and l.time <= @ToUtc and " + NotExcluded + " order by l.time, l.device",
            new { FromUtc = fromUtc, ToUtc = toUtc }, cancellationToken: ct));
        var result = points.Select(ToTrackPoint).ToList();

        if (includeNextPoint)
        {
            var next = await connection.QueryAsync<PointRow>(new CommandDefinition(
                Select + " where l.time > @ToUtc and " + NotExcluded + " order by l.time, l.device limit 1",
                new { ToUtc = toUtc }, cancellationToken: ct));
            result.AddRange(next.Select(ToTrackPoint));
        }

        return result;
    }

    /// <summary>
    /// The points with <c>fromUtc &lt;= time &lt; toUtc</c> (the end is exclusive, as a local day's is) that are not removed, ordered by time and
    /// then device (identical rows of one device and time, which a re-sent batch leaves, in the order they are stored), with the
    /// <see cref="PointSpan.Margin"/> nearest points before <paramref name="fromUtc"/> and from <paramref name="toUtc"/> on. For telling
    /// which of a day's points the cleaning keeps: the speed and motion of each are of no use to it and are not read.
    /// </summary>
    public async Task<PointSpan> LoadSpanAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<PointRow>(new CommandDefinition(
            Judged + " where l.time >= @FromUtc and l.time < @ToUtc and " + NotExcluded + " order by l.time, l.device, l.ctid",
            new { FromUtc = fromUtc, ToUtc = toUtc }, cancellationToken: ct));
        var before = await connection.QueryAsync<PointRow>(new CommandDefinition(
            Judged + " where l.time < @FromUtc and " + NotExcluded + $" order by l.time desc, l.device desc, l.ctid desc limit {PointSpan.Margin}",
            new { FromUtc = fromUtc }, cancellationToken: ct));
        var after = await connection.QueryAsync<PointRow>(new CommandDefinition(
            Judged + " where l.time >= @ToUtc and " + NotExcluded + $" order by l.time, l.device, l.ctid limit {PointSpan.Margin}",
            new { ToUtc = toUtc }, cancellationToken: ct));
        return new PointSpan([.. before.Reverse().Select(ToTrackPoint)], [.. rows.Select(ToTrackPoint)], [.. after.Select(ToTrackPoint)]);
    }

    /// <summary>
    /// The point of <paramref name="device"/> at exactly <paramref name="timeUtc"/>, whether the owner removed it or not, or null when there
    /// is none (see <see cref="FullPoint"/>). The nearest points before and after it are strictly before and after its time, and never
    /// removed ones.
    /// </summary>
    public async Task<FullPoint?> FindFullAsync(string device, DateTime timeUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = (await connection.QueryAsync<PointRow>(new CommandDefinition(
            SelectFull + " where l.time = @Time and l.device = @Device order by l.ctid limit 1",
            new { Time = timeUtc, Device = device }, cancellationToken: ct))).ToList();
        if (rows.Count == 0)
            return null;

        var removed = await connection.ExecuteScalarAsync<bool>(new CommandDefinition(
            "select exists (select 1 from excluded_point where device = @Device and time = @Time)",
            new { Time = timeUtc, Device = device }, cancellationToken: ct));
        // The window is in the day's order, (time, device): a point of another device at the same time is on the side that order puts it. The
        // time bounds keep the time index in play, which the row comparison alone would not.
        var windowBefore = await connection.QueryAsync<PointRow>(new CommandDefinition(
            Judged + " where l.time <= @Time and (l.time, l.device) < (@Time, @Device) and " + NotExcluded
            + $" order by l.time desc, l.device desc, l.ctid desc limit {PointSpan.Margin}",
            new { Time = timeUtc, Device = device }, cancellationToken: ct));
        var windowAfter = await connection.QueryAsync<PointRow>(new CommandDefinition(
            Judged + " where l.time >= @Time and (l.time, l.device) > (@Time, @Device) and " + NotExcluded
            + $" order by l.time, l.device, l.ctid limit {PointSpan.Margin}",
            new { Time = timeUtc, Device = device }, cancellationToken: ct));
        var before = await connection.QueryAsync<PointRow>(new CommandDefinition(
            Select + " where l.time < @Time and " + NotExcluded + " order by l.time desc, l.device desc, l.ctid desc limit 1",
            new { Time = timeUtc }, cancellationToken: ct));
        var after = await connection.QueryAsync<PointRow>(new CommandDefinition(
            Select + " where l.time > @Time and " + NotExcluded + " order by l.time, l.device, l.ctid limit 1",
            new { Time = timeUtc }, cancellationToken: ct));

        return new FullPoint(
            ToTrackPoint(rows[0]), rows[0].Altitude, removed,
            new PointSpan([.. windowBefore.Reverse().Select(ToTrackPoint)], [ToTrackPoint(rows[0])], [.. windowAfter.Select(ToTrackPoint)]),
            before.Select(ToTrackPoint).SingleOrDefault(), after.Select(ToTrackPoint).SingleOrDefault());
    }

    /// <summary>
    /// The time of the oldest point, or null when there are none: where a backfill starts. A point that was removed counts, which can
    /// only make the backfill start earlier than it needs to, over a stretch with no points in it.
    /// </summary>
    public async Task<DateTime?> FindFirstTimeAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var first = await connection.ExecuteScalarAsync<DateTime?>(new CommandDefinition(
            "select min(time) from locationlog", cancellationToken: ct));
        return first is { } time ? DateTime.SpecifyKind(time, DateTimeKind.Utc) : null;
    }

    /// <summary>
    /// The point nearest in time to <paramref name="instantUtc"/> that is at most <paramref name="within"/> away from it, or
    /// null when there is none. Two queries, each bounded by <c>instantUtc ± within</c> so that they use the hypertable's time
    /// index and read one row: the latest point at or before the instant, and the earliest after it. The closer of the two
    /// wins, and an exact tie goes to the earlier one. A point at the instant itself is the nearest there can be. Raw points,
    /// as <see cref="LoadAsync"/> reads them: nothing is cleaned or dropped here, but a point the owner removed is never the nearest.
    /// </summary>
    public async Task<TrackPoint?> NearestAsync(DateTime instantUtc, TimeSpan within, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);

        var before = (await connection.QueryAsync<PointRow>(new CommandDefinition(
            Select + " where l.time <= @Instant and l.time >= @Earliest and " + NotExcluded + " order by l.time desc, l.device limit 1",
            new { Instant = instantUtc, Earliest = instantUtc - within }, cancellationToken: ct))).SingleOrDefault();
        var after = (await connection.QueryAsync<PointRow>(new CommandDefinition(
            Select + " where l.time > @Instant and l.time <= @Latest and " + NotExcluded + " order by l.time, l.device limit 1",
            new { Instant = instantUtc, Latest = instantUtc + within }, cancellationToken: ct))).SingleOrDefault();

        if (before is null) return after is null ? null : ToTrackPoint(after);
        if (after is null) return ToTrackPoint(before);

        var closer = instantUtc - AsUtc(before.Time) <= AsUtc(after.Time) - instantUtc ? before : after;
        return ToTrackPoint(closer);
    }

    private static DateTime AsUtc(DateTime value) => DateTime.SpecifyKind(value, DateTimeKind.Utc);

    private const string Select =
        "select l.time as Time, l.device as Device, l.latitude as Latitude, l.longitude as Longitude, l.speed as Speed, "
        + "l.horizontal_accuracy as HorizontalAccuracy, l.motion as Motion from locationlog l";

    private const string SelectFull =
        "select l.time as Time, l.device as Device, l.latitude as Latitude, l.longitude as Longitude, l.speed as Speed, "
        + "l.horizontal_accuracy as HorizontalAccuracy, l.motion as Motion, l.altitude::double precision as Altitude from locationlog l";

    /// <summary>What the cleaning judges a point by: the time, device, position and accuracy.</summary>
    private const string Judged =
        "select l.time as Time, l.device as Device, l.latitude as Latitude, l.longitude as Longitude, "
        + "l.horizontal_accuracy as HorizontalAccuracy from locationlog l";

    private static TrackPoint ToTrackPoint(PointRow r) => new(
        DateTime.SpecifyKind(r.Time, DateTimeKind.Utc), r.Device, r.Latitude, r.Longitude, r.Speed, r.HorizontalAccuracy, r.Motion);

    /// <summary>A class with setters rather than a record: Dapper matches a record's constructor by exact column type, and Npgsql reports text[] as Array.</summary>
    private sealed class PointRow
    {
        public DateTime Time { get; set; }
        public string Device { get; set; } = string.Empty;
        public double Latitude { get; set; }
        public double Longitude { get; set; }
        public double? Speed { get; set; }
        public double? HorizontalAccuracy { get; set; }
        public string[]? Motion { get; set; }
        public double Altitude { get; set; }
    }
}
