using Dapper;
using FastEndpoints;
using Npgsql;

namespace Sporer.Api.Features.Overland;

internal sealed class ConsumeEndpoint(NpgsqlDataSource dataSource) : Endpoint<Request,Response>
{
    public override void Configure()
    {
        Post("overland");
        AllowAnonymous();
    }

    public override async Task HandleAsync(Request req, CancellationToken ct)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        
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
        
        await Send.OkAsync(new Response(), ct);
    }
    
    
    
}