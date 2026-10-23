using System.Globalization;
using System.Text.Json;
using FastEndpoints;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Day;

/// <summary>
/// <c>GET /api/day/{date}</c>: one local day of the stored timeline. A day is the local calendar date of the segments
/// (see <see cref="SegmentStore.FindDayAsync"/>), so a stay that crosses midnight is on both days. Reads only: nothing
/// here waits for or triggers processing; <c>state</c> says whether more is on its way.
/// </summary>
internal sealed class GetDayEndpoint(SegmentStore segments, ProcessingQueue queue) : EndpointWithoutRequest<DayResponse>
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
        var pending = await queue.HasPendingWorkAsync(fromUtc, toUtc, ct);

        await Send.OkAsync(new DayResponse(
            date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            zone ?? UnknownZone,
            pending ? "pending" : "done",
            Summarize(stored),
            [.. stored.Select(Map)]), ct);
    }

    /// <summary>Distinct places among the stays; distance and time on the move are the stored columns of the moves, summed.</summary>
    private static DaySummary Summarize(IReadOnlyList<DaySegment> stored)
    {
        var places = stored.Where(s => s is { Kind: "stay", Place: not null }).Select(s => s.Place!.Id).Distinct().Count();
        var moves = stored.Where(s => s.Kind == "move").ToList();
        var moving = moves.Aggregate(TimeSpan.Zero, (total, move) => total + (move.EndUtc - move.StartUtc));
        return new DaySummary(places, moves.Sum(m => m.DistanceM ?? 0), (long)Math.Round(moving.TotalSeconds));
    }

    private static DaySegmentDto Map(DaySegment s) => s.Kind switch
    {
        "stay" => new StayDto(s.Id, s.StartUtc, s.EndUtc, s.StartTz, s.EndTz,
            s.Place is { } p ? new PlaceDto(p.Id, p.Name, p.City, p.Country, p.Latitude, p.Longitude) : null),
        "move" => new MoveDto(s.Id, s.StartUtc, s.EndUtc, s.StartTz, s.EndTz, s.Mode, s.DistanceM ?? 0, Line(s.GeometryDetailJson)),
        "gap" => MapGap(s),
        _ => throw new InvalidOperationException($"Segment {s.Id} has the unknown kind '{s.Kind}'."),
    };

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
