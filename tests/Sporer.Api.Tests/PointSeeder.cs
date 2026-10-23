using Npgsql;
using NpgsqlTypes;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>Bulk-inserts synthetic points straight into <c>locationlog</c>, the way a backfill or a simulator would.</summary>
public static class PointSeeder
{
    /// <summary>Altitude is not used by the timeline; the column is NOT NULL, so every seeded point gets this one.</summary>
    private const decimal Altitude = 10m;

    public static async Task InsertAsync(string connectionString, IEnumerable<TrackPoint> points, CancellationToken ct = default)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(ct);

        await using var writer = await connection.BeginBinaryImportAsync(
            "COPY locationlog (time, longitude, latitude, device, speed, altitude, horizontal_accuracy, motion) FROM STDIN (FORMAT BINARY)",
            ct);

        foreach (var p in points)
        {
            await writer.StartRowAsync(ct);
            await writer.WriteAsync(p.TimeUtc, NpgsqlDbType.TimestampTz, ct);
            await writer.WriteAsync(p.Longitude, NpgsqlDbType.Double, ct);
            await writer.WriteAsync(p.Latitude, NpgsqlDbType.Double, ct);
            await writer.WriteAsync(p.Device, NpgsqlDbType.Text, ct);
            await WriteNullableAsync(writer, p.SpeedMps, NpgsqlDbType.Double, ct);
            await writer.WriteAsync(Altitude, NpgsqlDbType.Numeric, ct);
            await WriteNullableAsync(writer, p.AccuracyMeters, NpgsqlDbType.Double, ct);
            if (p.Motion is { } motion)
                await writer.WriteAsync(motion, NpgsqlDbType.Array | NpgsqlDbType.Text, ct);
            else
                await writer.WriteNullAsync(ct);
        }

        await writer.CompleteAsync(ct);
    }

    private static async Task WriteNullableAsync(NpgsqlBinaryImporter writer, double? value, NpgsqlDbType type, CancellationToken ct)
    {
        if (value is { } v)
            await writer.WriteAsync(v, type, ct);
        else
            await writer.WriteNullAsync(ct);
    }
}
