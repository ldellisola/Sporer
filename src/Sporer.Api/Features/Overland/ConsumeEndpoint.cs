using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Dapper;
using FastEndpoints;
using Microsoft.Extensions.Options;
using Npgsql;
using NpgsqlTypes;
using Sporer.Api.Configuration;

namespace Sporer.Api.Features.Overland;

internal sealed class ConsumeEndpoint(
    NpgsqlDataSource dataSource,
    IOptions<OverlandOptions> options,
    TimeProvider time,
    ILogger<ConsumeEndpoint> logger) : Endpoint<Request, Response>
{
    public override void Configure()
    {
        Post("overland");
        AllowAnonymous();
    }

    public override async Task HandleAsync(Request req, CancellationToken ct)
    {
        if (!IsAuthorized(options.Value.Token))
        {
            await Send.UnauthorizedAsync(ct);
            return;
        }

        if (req.Locations is not { Length: > 0 })
        {
            await Send.OkAsync(new Response(), ct);
            return;
        }

        var batch = Batch.From(req.Locations);

        await using var connection = await dataSource.OpenConnectionAsync(ct);

        // 1. The raw points, all of them in one statement (a batch can be hundreds of points, and a statement per point is a
        // round trip per point). Committed on their own: nothing below can undo or block them.
        await using (var transaction = await connection.BeginTransactionAsync(ct))
        {
            await using var insert = new NpgsqlCommand(Batch.Insert, connection, transaction);
            batch.AddParameters(insert);
            await insert.ExecuteNonQueryAsync(ct);
            await transaction.CommitAsync(ct);
        }

        // 2. Best effort: tell the timeline processing which time range has new points.
        await RecordDirtyRangeAsync(connection, batch.Times.Min(), batch.Times.Max(), batch.Times.Length);

        await Send.OkAsync(new Response(), ct);
    }

    private async Task RecordDirtyRangeAsync(NpgsqlConnection connection, DateTime fromUtc, DateTime toUtc, int points)
    {
        try
        {
            // Not tied to the request: the points are stored, so the range must be recorded even if the client hung up.
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await connection.ExecuteAsync(new CommandDefinition(
                "insert into dirty_range (from_utc, to_utc, created_at) values (@FromUtc, @ToUtc, @CreatedAt)",
                new { FromUtc = fromUtc, ToUtc = toUtc, CreatedAt = time.GetUtcNow().UtcDateTime },
                cancellationToken: timeout.Token));
        }
        catch (Exception ex)
        {
            logger.LogError(ex,
                "Stored {Points} points but could not record the dirty range {FromUtc:o} to {ToUtc:o}",
                points, fromUtc, toUtc);
        }
    }

    /// <summary>The token may come as <c>?token=</c> or as an <c>Authorization: Bearer</c> header. No configured token means open.</summary>
    private bool IsAuthorized(string? expected)
    {
        if (string.IsNullOrEmpty(expected))
            return true;

        var supplied = HttpContext.Request.Query["token"].ToString();
        if (supplied.Length == 0
            && AuthenticationHeaderValue.TryParse(HttpContext.Request.Headers.Authorization, out var header)
            && header.Scheme.Equals("Bearer", StringComparison.OrdinalIgnoreCase))
            supplied = header.Parameter ?? string.Empty;

        return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied), Encoding.UTF8.GetBytes(expected));
    }

    /// <summary>
    /// A batch as columns, to be inserted with one <c>unnest</c> statement. Each point's motion array is a slice of
    /// <see cref="MotionValues"/>: where it starts and how long it is, or null for a point without motion (which stays
    /// null, while an empty array stays empty).
    /// </summary>
    private sealed class Batch
    {
        public const string Insert =
            """
            insert into locationlog (time, longitude, latitude, device, speed, altitude, horizontal_accuracy, motion)
            select p.time, p.longitude, p.latitude, p.device, p.speed, p.altitude, p.horizontal_accuracy,
                   case when p.motion_length is null then null
                        else @motion_values[p.motion_start + 1 : p.motion_start + p.motion_length] end
            from unnest(@times, @longitudes, @latitudes, @devices, @speeds, @altitudes, @accuracies, @motion_starts, @motion_lengths)
                 as p(time, longitude, latitude, device, speed, altitude, horizontal_accuracy, motion_start, motion_length)
            """;

        public required DateTime[] Times { get; init; }
        public required double[] Longitudes { get; init; }
        public required double[] Latitudes { get; init; }
        public required string?[] Devices { get; init; }
        public required double?[] Speeds { get; init; }
        public required double[] Altitudes { get; init; }
        public required double?[] Accuracies { get; init; }
        public required int?[] MotionStarts { get; init; }
        public required int?[] MotionLengths { get; init; }
        public required string?[] MotionValues { get; init; }

        public static Batch From(Location[] locations)
        {
            var count = locations.Length;
            var motionStarts = new int?[count];
            var motionLengths = new int?[count];
            var motionValues = new List<string?>();
            for (var i = 0; i < count; i++)
            {
                if (locations[i].Properties.Motion is not { } motion)
                    continue;

                motionStarts[i] = motionValues.Count;
                motionLengths[i] = motion.Length;
                motionValues.AddRange(motion);
            }

            return new Batch
            {
                Times = [.. locations.Select(l => l.Properties.Timestamp.ToUniversalTime())],
                Longitudes = [.. locations.Select(l => l.Geometry.Coordinates[0])],
                Latitudes = [.. locations.Select(l => l.Geometry.Coordinates[1])],
                Devices = [.. locations.Select(l => l.Properties.DeviceId)],
                Speeds = [.. locations.Select(l => l.Properties.Speed is < 0 ? null : l.Properties.Speed)],
                Altitudes = [.. locations.Select(l => l.Properties.Altitude)],
                Accuracies = [.. locations.Select(l => l.Properties.HorizontalAccuracy)],
                MotionStarts = motionStarts,
                MotionLengths = motionLengths,
                MotionValues = [.. motionValues],
            };
        }

        public void AddParameters(NpgsqlCommand command)
        {
            Add(command, "times", NpgsqlDbType.TimestampTz, Times);
            Add(command, "longitudes", NpgsqlDbType.Double, Longitudes);
            Add(command, "latitudes", NpgsqlDbType.Double, Latitudes);
            Add(command, "devices", NpgsqlDbType.Text, Devices);
            Add(command, "speeds", NpgsqlDbType.Double, Speeds);
            Add(command, "altitudes", NpgsqlDbType.Double, Altitudes);
            Add(command, "accuracies", NpgsqlDbType.Double, Accuracies);
            Add(command, "motion_starts", NpgsqlDbType.Integer, MotionStarts);
            Add(command, "motion_lengths", NpgsqlDbType.Integer, MotionLengths);
            Add(command, "motion_values", NpgsqlDbType.Text, MotionValues);
        }

        private static void Add(NpgsqlCommand command, string name, NpgsqlDbType elementType, Array values)
            => command.Parameters.Add(new NpgsqlParameter(name, NpgsqlDbType.Array | elementType) { Value = values });
    }
}
