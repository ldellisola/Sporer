using FastEndpoints;
using Sporer.Api.Features.Day;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Points;

/// <summary>
/// <c>GET /api/day/{date}/points</c>: the raw points of a local day that are not removed (see <see cref="DayPointsResponse"/>), for the
/// owner to pick the ones to remove from. The day is what the day view calls the day, in every zone its segments are in (see
/// <see cref="DayZone.FindPointSpanAsync"/>): from the earliest local midnight to the latest next one, so no point is on no day, and on a
/// day of travel the points of the days next to it overlap. A day with no points has an empty list. A date that is not written
/// <c>yyyy-MM-dd</c> is a 400, as for the day. Reads only.
/// </summary>
internal sealed class GetDayPointsEndpoint(SegmentStore segments, PointStore points) : EndpointWithoutRequest<DayPointsResponse>
{
    public override void Configure()
    {
        Get("day/{date}/points");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        if (!DayDate.TryParse(Route<string>("date", isRequired: false), out var date))
        {
            ValidationFailures.Add(new("date", DayDate.InvalidMessage));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        var (fromUtc, toUtc) = await DayZone.FindPointSpanAsync(segments, date, ct);
        var loaded = await points.LoadPositionsAsync(fromUtc, toUtc, ct);

        var devices = new List<string>();
        var indexOf = new Dictionary<string, int>(StringComparer.Ordinal);
        var result = new List<DayPoint>(loaded.Count);
        foreach (var point in loaded)
        {
            if (!indexOf.TryGetValue(point.Device, out var device))
            {
                device = devices.Count;
                indexOf.Add(point.Device, device);
                devices.Add(point.Device);
            }

            result.Add(new DayPoint(PointTime.ToMicros(point.TimeUtc), point.Longitude, point.Latitude, device));
        }

        await Send.OkAsync(new DayPointsResponse(DayDate.ToText(date), devices, result), ct);
    }
}
