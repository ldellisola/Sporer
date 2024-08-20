using Dapper;
using FastEndpoints;
using Microsoft.Extensions.Options;
using Npgsql;
using NpgsqlTypes;
using Sporer.Api.Configuration;

namespace Sporer.Api.Features.Overland;

internal sealed class ConsumeEndpoint(IOptions<DataBaseOptions> options) : Endpoint<Request,Response>
{
    private readonly string _connectionString = options.Value.ConnectionString;
    public override void Configure()
    {
        Post("overland");
        AllowAnonymous();
    }

    public override async Task HandleAsync(Request req, CancellationToken ct)
    {
        await using var connection = new NpgsqlConnection(_connectionString);
        
        await connection.ExecuteAsync(
            """
            Insert into locationlog (time, longitude, latitude, device, speed, altitude)
            values (@Timestamp, @Longitude, @Latitude, @DeviceId, @Speed, @Altitude)
            """,
            req.Locations.Select(l => new
            {
                Timestamp = l.Properties.Timestamp,
                Longitude = l.Geometry.Coordinates[0],
                Latitude = l.Geometry.Coordinates[1],
                DeviceId = l.Properties.DeviceId,
                Speed = (double?) (l.Properties.Speed < 0 ? null : l.Properties.Speed),
                Altitude = l.Properties.Altitude
            }));
        
        await SendOkAsync(new Response(), ct);
    }
    
    
    
}