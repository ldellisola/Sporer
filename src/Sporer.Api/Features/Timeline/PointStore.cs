using Dapper;
using Npgsql;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

/// <summary>A raw point as a map draws it: when, by which device, and where.</summary>
public sealed record PointPosition(DateTime TimeUtc, string Device, double Longitude, double Latitude);

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
    /// The time, device and position of the points with <c>fromUtc &lt;= time &lt; toUtc</c> (the end is exclusive, as a local day's is,
    /// see <c>DaySpan</c>), ordered by time and then device, the removed ones left out. Only what a map draws is read: a dense day has
    /// tens of thousands of points, and the speed, accuracy and motion of each are of no use to it.
    /// </summary>
    public async Task<List<PointPosition>> LoadPositionsAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<PositionRow>(new CommandDefinition(
            "select l.time as Time, l.device as Device, l.longitude as Longitude, l.latitude as Latitude from locationlog l "
            + "where l.time >= @FromUtc and l.time < @ToUtc and " + NotExcluded + " order by l.time, l.device",
            new { FromUtc = fromUtc, ToUtc = toUtc }, cancellationToken: ct));
        return [.. rows.Select(r => new PointPosition(AsUtc(r.Time), r.Device, r.Longitude, r.Latitude))];
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

    private static TrackPoint ToTrackPoint(PointRow r) => new(
        DateTime.SpecifyKind(r.Time, DateTimeKind.Utc), r.Device, r.Latitude, r.Longitude, r.Speed, r.HorizontalAccuracy, r.Motion);

    private sealed class PositionRow
    {
        public DateTime Time { get; set; }
        public string Device { get; set; } = string.Empty;
        public double Longitude { get; set; }
        public double Latitude { get; set; }
    }

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
    }
}
