using System.Text.Json;
using System.Text.Json.Serialization;

namespace Sporer.Api.Features.Points;

/// <summary>
/// The raw points of one local day that are not removed, as served by <c>GET /api/day/{date}/points</c>, in time order. A point is an
/// array, <c>[t, lon, lat, deviceIndex]</c>, as there can be tens of thousands of them in a day: <c>t</c> is its time as microseconds since the
/// epoch (exact, see <see cref="PointTime"/>: it is what a removal names the point by, with its device) and <c>deviceIndex</c> is where its
/// device is in <paramref name="Devices"/>, which are in the order they first appear in the day.
/// </summary>
public sealed record DayPointsResponse(string Date, IReadOnlyList<string> Devices, IReadOnlyList<DayPoint> Points);

/// <summary>A point of a day, written as the array <c>[t, lon, lat, deviceIndex]</c> (see <see cref="DayPointsResponse"/>).</summary>
[JsonConverter(typeof(DayPointConverter))]
public readonly record struct DayPoint(long T, double Lon, double Lat, int Device);

/// <summary>Writes a <see cref="DayPoint"/> as an array of four numbers. The points of a day are only ever sent, never read.</summary>
internal sealed class DayPointConverter : JsonConverter<DayPoint>
{
    public override DayPoint Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        => throw new NotSupportedException("A point of a day is written, not read.");

    public override void Write(Utf8JsonWriter writer, DayPoint value, JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        writer.WriteNumberValue(value.T);
        writer.WriteNumberValue(value.Lon);
        writer.WriteNumberValue(value.Lat);
        writer.WriteNumberValue(value.Device);
        writer.WriteEndArray();
    }
}
