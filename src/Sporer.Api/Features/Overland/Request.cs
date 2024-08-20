namespace Sporer.Api.Features.Overland;

internal sealed record Request(Location[] Locations);

internal sealed record Location(Geometry Geometry, Metadata Properties);

internal sealed record Geometry(double[] Coordinates);

internal sealed record Metadata(
    DateTime Timestamp,
    double Altitude,
    double Speed,
    [property: System.Text.Json.Serialization.JsonPropertyName("device_id")]
    string DeviceId
    );
