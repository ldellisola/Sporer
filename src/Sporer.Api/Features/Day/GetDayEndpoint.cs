using System.Globalization;
using System.Text.Json;
using FastEndpoints;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;
using Sporer.Timeline;

namespace Sporer.Api.Features.Day;

/// <summary>
/// <c>GET /api/day/{date}</c>: one local day of the stored timeline. A day is the local calendar date of the segments
/// (see <see cref="SegmentStore.FindDayAsync"/>), so a stay that crosses midnight is on both days. A stay at the home in
/// effect on that day is marked <c>home</c> (see <see cref="TripStore.FindHomeOnAsync"/>): one at the home place, or at a place
/// within <see cref="DetectionOptions.HomeRadiusMeters"/> of it that was the night location on a night of that home period,
/// which is the same home that GPS drift made another place of. A place near the home that was never where the night was
/// spent (a café, a shop, a gym) is not home and keeps its number.
/// Reads only: nothing here waits for or triggers processing; <c>state</c> says whether more is on its way.
/// </summary>
internal sealed class GetDayEndpoint(SegmentStore segments, TripStore trips, ProcessingQueue queue, DetectionOptions options)
    : EndpointWithoutRequest<DayResponse>
{
    private const string UnknownZone = "UTC";

    public override void Configure()
    {
        Get("day/{date}");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        var text = Route<string>("date", isRequired: false);
        if (!DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
        {
            ValidationFailures.Add(new("date", "The date must be a calendar date written yyyy-MM-dd."));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        var stored = await segments.FindDayAsync(date, ct);

        // The zone the day is shown in: where its first segment starts, else where the latest earlier stay was.
        var zone = stored.Count > 0 ? stored[0].StartTz : await segments.FindZoneBeforeAsync(date, ct);
        var (fromUtc, toUtc) = DaySpan.Of(date, zone);

        // The day's segments can reach past the day in the zone it is shown in: a stay across midnight, or a later segment
        // in a zone west of the first one. Waiting work on any part of what is served makes the day pending.
        if (stored.Count > 0)
        {
            fromUtc = Min(fromUtc, stored.Min(s => s.StartUtc));
            toUtc = Max(toUtc, stored.Max(s => s.EndUtc));
        }

        var pending = await queue.HasPendingWorkAsync(fromUtc, toUtc, ct);

        // One lookup for the day, not one per stay: the home is that of the day viewed, so a day before a move shows the old home.
        var home = await trips.FindHomeOnAsync(date, ct);

        await Send.OkAsync(new DayResponse(
            date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            zone ?? UnknownZone,
            pending ? "pending" : "done",
            Summarize(stored),
            [.. stored.Select(s => Map(s, home, options.HomeRadiusMeters))]), ct);
    }

    private static DateTime Min(DateTime a, DateTime b) => a <= b ? a : b;

    private static DateTime Max(DateTime a, DateTime b) => a >= b ? a : b;

    /// <summary>Distinct places among the stays; distance and time on the move are the stored columns of the moves, summed.</summary>
    private static DaySummary Summarize(IReadOnlyList<DaySegment> stored)
    {
        var places = stored.Where(s => s is { Kind: "stay", Place: not null }).Select(s => s.Place!.Id).Distinct().Count();
        var moves = stored.Where(s => s.Kind == "move").ToList();
        var moving = moves.Aggregate(TimeSpan.Zero, (total, move) => total + (move.EndUtc - move.StartUtc));
        return new DaySummary(places, moves.Sum(m => m.DistanceM ?? 0), (long)Math.Round(moving.TotalSeconds));
    }

    /// <summary>
    /// A stay is at home when its place (the surviving one, as the home is) is the <paramref name="home"/> place, or is within
    /// <paramref name="radiusMeters"/> of the home's position and was the night location on a night of the home period
    /// (<see cref="HomeInEffect.NightPlaceIds"/>): GPS drift can split one home into several places, and home detection counts
    /// only places that nights were spent at, so a nearby place that none was is not part of the home. A stay with no place,
    /// and every stay of a day with no home in effect (<paramref name="home"/> null), is not.
    /// </summary>
    private static DaySegmentDto Map(DaySegment s, HomeInEffect? home, double radiusMeters) => s.Kind switch
    {
        "stay" => new StayDto(s.Id, s.StartUtc, s.EndUtc, s.StartTz, s.EndTz,
            s.Place is { } p ? new PlaceDto(p.Id, p.Name, p.City, p.Country, p.Latitude, p.Longitude) : null,
            Home: IsHome(s.Place, home, radiusMeters)),
        "move" => new MoveDto(s.Id, s.StartUtc, s.EndUtc, s.StartTz, s.EndTz, s.Mode, s.DistanceM ?? 0, Line(s.GeometryDetailJson)),
        "gap" => MapGap(s),
        _ => throw new InvalidOperationException($"Segment {s.Id} has the unknown kind '{s.Kind}'."),
    };

    private static bool IsHome(DayPlace? place, HomeInEffect? home, double radiusMeters)
        => place is not null && home is not null
            && (place.Id == home.PlaceId
                || (home.NightPlaceIds.Contains(place.Id)
                    && Geo.DistanceMeters(new GeoPoint(place.Latitude, place.Longitude), home.Position) <= radiusMeters));

    /// <summary>A gap stores the positions either side of it as a two-point line: the first is where it starts, the last where it ends.</summary>
    private static GapDto MapGap(DaySegment s)
    {
        var ends = Line(s.GeometryDetailJson);
        var count = ends.GetArrayLength();
        return new GapDto(s.Id, s.StartUtc, s.EndUtc, s.StartTz, s.EndTz,
            count > 0 ? Position(ends[0]) : null,
            count > 0 ? Position(ends[count - 1]) : null);
    }

    /// <summary>The stored line, as stored: <c>[[lon,lat],...]</c>. A segment without one has an empty line.</summary>
    private static JsonElement Line(string? json) => JsonSerializer.Deserialize<JsonElement>(json ?? "[]");

    private static LatLon Position(JsonElement lonLat) => new(Lat: lonLat[1].GetDouble(), Lon: lonLat[0].GetDouble());
}
