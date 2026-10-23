using System.Text.Json.Nodes;

namespace Sporer.Api.Tests;

/// <summary>Builds Overland-style JSON payloads. Optional properties are left out when null.</summary>
public static class Payload
{
    public static string One(
        string time,
        double lon,
        double lat,
        double? speed = null,
        double? altitude = null,
        string? device = null,
        double? horizontalAccuracy = null,
        string[]? motion = null)
        => Many(Point(time, lon, lat, speed, altitude, device, horizontalAccuracy, motion));

    public static string Many(params JsonObject[] points)
        => new JsonObject { ["locations"] = new JsonArray(points.Select(p => (JsonNode)p).ToArray()) }.ToJsonString();

    public static JsonObject Point(
        string time,
        double lon,
        double lat,
        double? speed = null,
        double? altitude = null,
        string? device = null,
        double? horizontalAccuracy = null,
        string[]? motion = null)
    {
        var properties = new JsonObject { ["timestamp"] = time };
        if (speed is not null) properties["speed"] = speed;
        if (altitude is not null) properties["altitude"] = altitude;
        if (device is not null) properties["device_id"] = device;
        if (horizontalAccuracy is not null) properties["horizontal_accuracy"] = horizontalAccuracy;
        if (motion is not null) properties["motion"] = new JsonArray(motion.Select(m => (JsonNode)JsonValue.Create(m)!).ToArray());

        return new JsonObject
        {
            ["type"] = "Feature",
            ["geometry"] = new JsonObject
            {
                ["type"] = "Point",
                ["coordinates"] = new JsonArray(lon, lat),
            },
            ["properties"] = properties,
        };
    }
}
