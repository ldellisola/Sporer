using System.Text.Json.Serialization;

namespace Sporer.Api.Features.Overland;

internal sealed record Request(Location[] Locations);

internal sealed record Location(Geometry Geometry, Metadata Properties);

internal sealed record Geometry(double[] Coordinates);

internal sealed record Metadata(
    DateTime Timestamp,
    double Altitude,
    double? Speed,
    [property: JsonPropertyName("device_id")]
    string DeviceId,
    [property: JsonPropertyName("horizontal_accuracy")]
    double? HorizontalAccuracy,
    string[]? Motion
    );
