using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Dapper;
using FastEndpoints;
using Microsoft.Extensions.Options;
using Npgsql;
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

        var rows = req.Locations.Select(l => new
        {
            Timestamp = l.Properties.Timestamp.ToUniversalTime(),
            Longitude = l.Geometry.Coordinates[0],
            Latitude = l.Geometry.Coordinates[1],
            DeviceId = l.Properties.DeviceId,
            Speed = l.Properties.Speed is < 0 ? null : l.Properties.Speed,
            Altitude = l.Properties.Altitude,
            HorizontalAccuracy = l.Properties.HorizontalAccuracy,
            Motion = l.Properties.Motion
        }).ToList();

        await using var connection = await dataSource.OpenConnectionAsync(ct);

        // 1. The raw points. Committed on their own: nothing below can undo or block them.
        await using (var transaction = await connection.BeginTransactionAsync(ct))
        {
            await connection.ExecuteAsync(new CommandDefinition(
                """
                Insert into locationlog (time, longitude, latitude, device, speed, altitude, horizontal_accuracy, motion)
                values (@Timestamp, @Longitude, @Latitude, @DeviceId, @Speed, @Altitude, @HorizontalAccuracy, @Motion)
                """,
                rows, transaction, cancellationToken: ct));
            await transaction.CommitAsync(ct);
        }

        // 2. Best effort: tell the timeline processing which time range has new points.
        await RecordDirtyRangeAsync(connection, rows.Min(r => r.Timestamp), rows.Max(r => r.Timestamp), rows.Count);

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
}
