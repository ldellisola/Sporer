using System.Globalization;
using FastEndpoints;
using Sporer.Api.Features.Timeline;
using Sporer.Timeline;

namespace Sporer.Api.Features.Points;

/// <summary>
/// <c>GET /api/points/detail?device=…&amp;t=…</c>: one raw point in full (see <see cref="PointDetailResponse"/>). The point is named as a removal
/// names it, by its device and its exact time (<c>t</c>, microseconds since the epoch, see <see cref="PointTime"/>). A missing or empty
/// <c>device</c>, and a <c>t</c> that is missing, not a whole number or not a time a point can have, are a 400; a point that is not stored is a 404.
/// A point the owner removed is answered, with the status <c>removed</c>: it is in <c>locationlog</c> still. Any other status is what
/// <see cref="PointCleaner.Classify"/> makes of the point among its own neighbours, the nearest points before and after it that are not removed.
/// Reads only.
/// </summary>
internal sealed class GetPointDetailEndpoint(PointStore points, SegmentStore segments, PlaceStore places, DetectionOptions options)
    : EndpointWithoutRequest<PointDetailResponse>
{
    public override void Configure()
    {
        Get("points/detail");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        var device = Query<string>("device", isRequired: false);
        var text = Query<string>("t", isRequired: false);
        DateTime time = default;
        if (string.IsNullOrEmpty(device))
            ValidationFailures.Add(new("device", "device is required."));
        if (!long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var micros) || !PointTime.TryFromMicros(micros, out time))
            ValidationFailures.Add(new("t", "t must be a time in microseconds since the epoch."));
        if (ValidationFailures.Count > 0)
        {
            await Send.ErrorsAsync(400, ct);
            return;
        }

        var full = await points.FindFullAsync(device!, time, ct);
        if (full is null)
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        var point = full.Point;
        string status;
        if (full.Removed)
            status = PointStatusName.Removed;
        else
        {
            // As the cleaning meets it: the neighbours around the point (and around any twin of it, which comes after it).
            List<TrackPoint> judged = [];
            if (full.Before is { } before)
                judged.Add(before);
            var at = judged.Count;
            judged.Add(point);
            judged.AddRange(full.Twins);
            if (full.After is { } after)
                judged.Add(after);
            status = PointStatusName.Of(PointCleaner.Classify(judged, options)[at]);
        }

        var zone = LocalTime.TimeZoneAt(point.Position);
        var local = LocalTime.ToLocal(point.TimeUtc, zone);
        var segment = await segments.FindAtAsync(point.TimeUtc, ct);

        await Send.OkAsync(new PointDetailResponse(
            point.Device, PointTime.ToMicros(point.TimeUtc), point.TimeUtc,
            local.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture), zone,
            point.Latitude, point.Longitude, point.AccuracyMeters, point.SpeedMps, full.Altitude, point.Motion, status,
            full.Before is { } b ? Hop(point, b) : null, full.After is { } n ? Hop(point, n) : null,
            segment is null ? null : await ToSegmentAsync(segment, ct)), ct);
    }

    /// <summary>The hop between the point and a neighbour, before or after it, as a speed: the great-circle distance over the time between them.</summary>
    private static PointNeighbour Hop(TrackPoint point, TrackPoint other)
    {
        var gap = Math.Abs((other.TimeUtc - point.TimeUtc).TotalSeconds);
        var meters = Geo.DistanceMeters(point.Position, other.Position);
        return new PointNeighbour(PointTime.ToMicros(other.TimeUtc), gap, meters, gap > 0 ? meters / gap * 3.6 : 0);
    }

    private async Task<PointSegment> ToSegmentAsync(SegmentAt segment, CancellationToken ct)
    {
        PointPlace? place = null;
        if (segment is { Kind: "stay", PlaceId: { } id } && await places.FindSurvivorAsync(id, ct) is { } survivor)
            place = new PointPlace(survivor.Id, survivor.Name);
        return new PointSegment(segment.Kind, segment.StartUtc, segment.EndUtc, place, segment.Mode);
    }
}
