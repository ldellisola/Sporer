using Dapper;
using Npgsql;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

/// <summary>Reads raw points from <c>locationlog</c>. The timeline never writes to that table.</summary>
public sealed class PointStore(NpgsqlDataSource dataSource)
{
    /// <summary>
    /// The points with <c>fromUtc &lt;= time &lt;= toUtc</c>, ordered by time (then device, so equal times come in a stable
    /// order). A null <paramref name="toUtc"/> means no upper bound: every point from <paramref name="fromUtc"/> on.
    /// With <paramref name="includeNextPoint"/> the first point after <paramref name="toUtc"/> is added at the end; the
    /// segmenter needs it to tell when a stay that ends at <paramref name="toUtc"/> really ended.
    /// </summary>
    public async Task<List<TrackPoint>> LoadAsync(
        DateTime fromUtc, DateTime? toUtc, bool includeNextPoint, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);

        // Two statements instead of a null-able bound: Npgsql cannot type a bare NULL parameter.
        var points = toUtc is { } upper
            ? await connection.QueryAsync<PointRow>(new CommandDefinition(
                Select + " where time >= @FromUtc and time <= @ToUtc order by time, device",
                new { FromUtc = fromUtc, ToUtc = upper }, cancellationToken: ct))
            : await connection.QueryAsync<PointRow>(new CommandDefinition(
                Select + " where time >= @FromUtc order by time, device",
                new { FromUtc = fromUtc }, cancellationToken: ct));

        var result = points.Select(ToTrackPoint).ToList();

        if (includeNextPoint && toUtc is { } after)
        {
            var next = await connection.QueryAsync<PointRow>(new CommandDefinition(
                Select + " where time > @AfterUtc order by time, device limit 1",
                new { AfterUtc = after }, cancellationToken: ct));
            result.AddRange(next.Select(ToTrackPoint));
        }

        return result;
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
