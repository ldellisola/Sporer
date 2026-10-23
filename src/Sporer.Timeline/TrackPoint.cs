namespace Sporer.Timeline;

/// <summary>One logged location. <paramref name="Motion"/> is Overland's motion array when it sent one.</summary>
public sealed record TrackPoint(
    DateTime TimeUtc,
    string Device,
    double Latitude,
    double Longitude,
    double? SpeedMps,
    double? AccuracyMeters,
    string[]? Motion)
{
    public GeoPoint Position => new(Latitude, Longitude);
}
