using Dapper;
using Npgsql;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

/// <summary>Reads raw points from <c>locationlog</c>. The timeline never writes to that table.</summary>
public sealed class PointStore(NpgsqlDataSource dataSource)
{
    /// <summary>
    /// The points with <c>fromUtc &lt;= time &lt;= toUtc</c>, ordered by time (then device, so equal times come in a stable
    /// order). With <paramref name="includeNextPoint"/> the first point after <paramref name="toUtc"/> is added at the end;
    /// the segmenter needs it to tell when a stay that reaches <paramref name="toUtc"/> really ended.
    /// </summary>
    public async Task<List<TrackPoint>> LoadAsync(
        DateTime fromUtc, DateTime toUtc, bool includeNextPoint, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);

        var points = await connection.QueryAsync<PointRow>(new CommandDefinition(
            Select + " where time >= @FromUtc and time <= @ToUtc order by time, device",
            new { FromUtc = fromUtc, ToUtc = toUtc }, cancellationToken: ct));
        var result = points.Select(ToTrackPoint).ToList();

        if (includeNextPoint)
        {
            var next = await connection.QueryAsync<PointRow>(new CommandDefinition(
                Select + " where time > @ToUtc order by time, device limit 1",
                new { ToUtc = toUtc }, cancellationToken: ct));
            result.AddRange(next.Select(ToTrackPoint));
        }

        return result;
    }

    /// <summary>The time of the oldest point, or null when there are none.</summary>
    public async Task<DateTime?> FindFirstTimeAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var first = await connection.ExecuteScalarAsync<DateTime?>(new CommandDefinition(
            "select min(time) from locationlog", cancellationToken: ct));
        return first is { } time ? DateTime.SpecifyKind(time, DateTimeKind.Utc) : null;
    }

    private const string Select =
        "select time as Time, device as Device, latitude as Latitude, longitude as Longitude, speed as Speed, "
        + "horizontal_accuracy as HorizontalAccuracy, motion as Motion from locationlog";

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
    }
}
