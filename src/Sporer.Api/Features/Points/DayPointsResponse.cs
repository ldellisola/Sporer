using System.Text.Json;
using System.Text.Json.Serialization;
using Sporer.Timeline;

namespace Sporer.Api.Features.Points;

/// <summary>
/// The raw points of one local day that are not removed, as served by <c>GET /api/day/{date}/points</c>, in time order. A point is an
/// array, <c>[t, lon, lat, deviceIndex, status]</c>, as there can be tens of thousands of them in a day: <c>t</c> is its time as microseconds since the
/// epoch (exact, see <see cref="PointTime"/>: it is what a removal names the point by, with its device) and <c>deviceIndex</c> is where its
/// device is in <paramref name="Devices"/>, which are in the order they first appear in the day. <c>status</c> is what the timeline made of the point
/// (<see cref="PointStatus"/>): <c>0</c> used, <c>1</c> poor accuracy, <c>2</c> glitch, <c>3</c> duplicate; the points of a day are judged with the
/// <see cref="PointSpan.Margin"/> nearest points before it and after it, as the cleaning is (<see cref="PointCleaner.Classify"/>).
/// </summary>
public sealed record DayPointsResponse(string Date, IReadOnlyList<string> Devices, IReadOnlyList<DayPoint> Points);

/// <summary>A point of a day, written as the array <c>[t, lon, lat, deviceIndex, status]</c> (see <see cref="DayPointsResponse"/>).</summary>
[JsonConverter(typeof(DayPointConverter))]
public readonly record struct DayPoint(long T, double Lon, double Lat, int Device, int Status);

/// <summary>Writes a <see cref="DayPoint"/> as an array of five numbers. The points of a day are only ever sent, never read.</summary>
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
        writer.WriteNumberValue(value.Status);
        writer.WriteEndArray();
    }
}
