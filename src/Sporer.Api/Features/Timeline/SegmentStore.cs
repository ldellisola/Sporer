using Dapper;
using Npgsql;

namespace Sporer.Api.Features.Timeline;

/// <summary>
/// One row of <c>segment</c>. <paramref name="GeometryDetailJson"/> and <paramref name="GeometryCoarseJson"/> are
/// <c>[[lon,lat],...]</c> with coordinates rounded to 6 decimals; all times are UTC.
/// </summary>
public sealed record StoredSegment(
    string Kind,
    DateTime StartUtc,
    DateTime EndUtc,
    string StartTz,
    string EndTz,
    DateOnly LocalStartDate,
    DateOnly LocalEndDate,
    long? PlaceId,
    double? Latitude,
    double? Longitude,
    string? Mode,
    double? DistanceM,
    string? GeometryDetailJson,
    string? GeometryCoarseJson,
    int PointCount);

/// <summary>Reads and rewrites the derived timeline in <c>segment</c>.</summary>
public sealed class SegmentStore(NpgsqlDataSource dataSource)
{
    /// <summary>
    /// The edges of the range that has to be rebuilt to reprocess <paramref name="fromUtc"/> to <paramref name="toUtc"/>.
    /// Stays are fixed points of the timeline (they start at a logged point and are found greedily from it), so the
    /// rebuild starts at a stay and stops at the end of one: <c>T0</c> is the start of the last stored stay that starts
    /// before <paramref name="fromUtc"/> (or <paramref name="fromUtc"/> itself when there is none), <c>T1</c> the end of the
    /// first stored stay that starts after <paramref name="toUtc"/> (or null when there is none: the end of the data).
    /// </summary>
    public async Task<(DateTime T0, DateTime? T1)> FindAnchorsAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var anchors = await connection.QuerySingleAsync<AnchorRow>(new CommandDefinition(
            """
            select
              (select start_utc from segment where kind = 'stay' and start_utc < @FromUtc order by start_utc desc limit 1) as T0,
              (select end_utc   from segment where kind = 'stay' and start_utc > @ToUtc   order by start_utc       limit 1) as T1
            """,
            new { FromUtc = fromUtc, ToUtc = toUtc }, cancellationToken: ct));

        return (anchors.T0 is { } t0 ? AsUtc(t0) : fromUtc, anchors.T1 is { } t1 ? AsUtc(t1) : null);
    }

    /// <summary>
    /// Replaces the segments that start at or after <paramref name="t0"/> and, unless <paramref name="t1"/> is null,
    /// before it, by <paramref name="segments"/>. One transaction: readers see the old rows or the new ones, and a
    /// failure leaves the old ones.
    /// </summary>
    public async Task ReplaceAsync(DateTime t0, DateTime? t1, IReadOnlyList<StoredSegment> segments, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        await connection.ExecuteAsync(t1 is { } upper
            ? new CommandDefinition("delete from segment where start_utc >= @T0 and start_utc < @T1",
                new { T0 = t0, T1 = upper }, transaction, cancellationToken: ct)
            : new CommandDefinition("delete from segment where start_utc >= @T0",
                new { T0 = t0 }, transaction, cancellationToken: ct));

        if (segments.Count > 0)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                """
                insert into segment (kind, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date, place_id,
                                     latitude, longitude, mode, distance_m, geometry_detail, geometry_coarse, point_count)
                values (@Kind, @StartUtc, @EndUtc, @StartTz, @EndTz, @LocalStartDate, @LocalEndDate, @PlaceId,
                        @Latitude, @Longitude, @Mode, @DistanceM, @GeometryDetailJson::jsonb, @GeometryCoarseJson::jsonb, @PointCount)
                """,
                segments, transaction, cancellationToken: ct));
        }

        await transaction.CommitAsync(ct);
    }

    private static DateTime AsUtc(DateTime value) => DateTime.SpecifyKind(value, DateTimeKind.Utc);

    private sealed record AnchorRow(DateTime? T0, DateTime? T1);
}
