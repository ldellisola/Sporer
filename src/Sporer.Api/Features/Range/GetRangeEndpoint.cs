using System.Globalization;
using FastEndpoints;
using Sporer.Api.Features.Day;
using Sporer.Api.Features.Timeline;
using Sporer.Timeline;

namespace Sporer.Api.Features.Range;

/// <summary>
/// <c>GET /api/range?from=yyyy-MM-dd&amp;to=yyyy-MM-dd</c>: the moves, places and days of a stretch of local days, for the
/// week, month, year and custom range views. Reads only: nothing here waits for or triggers processing; <c>state</c> says
/// whether more is on its way. What the response holds is described by <see cref="RangeStore.FindAsync"/>.
/// </summary>
internal sealed class GetRangeEndpoint(RangeStore store, ProcessingQueue queue) : EndpointWithoutRequest<RangeResponse>
{
    public override void Configure()
    {
        Get("range");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        var from = Query<string>("from", isRequired: false);
        var to = Query<string>("to", isRequired: false);
        if (!DateRange.TryParse(from, to, out var range, out var error))
        {
            ValidationFailures.Add(new("range", error!));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        // Asked before the data is read: work that finished in between only makes the answer say pending over data that is already
        // new (the client asks again), while asking after could say done over data from before it. The span is the widest the
        // days could cover in any zone, 14 hours before the start of the first to 14 hours after the end of the last: the
        // zones of the segments are not looked at, because the range is long and the check cheap.
        var pending = await queue.HasPendingWorkAsync(
            DaySpan.Of(range.From, null).FromUtc, DaySpan.Of(range.To, null).ToUtc, ct);

        var data = await store.FindAsync(range, ct);

        // The moves are drawn together, so the vertex budget is for all of their lines.
        var lines = VertexBudget.Fit([.. data.Moves.Select(m => m.Line)]);

        var moving = data.Moves.Aggregate(TimeSpan.Zero, (total, move) => total + (move.EndUtc - move.StartUtc));
        await Send.OkAsync(new RangeResponse(
            Text(range.From),
            Text(range.To),
            pending ? "pending" : "done",
            new RangeSummary(data.Places.Count, data.Moves.Sum(m => m.DistanceM ?? 0), (long)Math.Round(moving.TotalSeconds), data.Moves.Count),
            [.. data.Moves.Select((m, k) => new RangeMoveDto(m.Id, m.Mode, m.StartUtc, m.EndUtc, LonLat(lines[k])))],
            [.. data.Places.Select(p => new RangePlaceDto(p.Id, p.Name, p.City, p.Country, p.Latitude, p.Longitude, p.Seconds, p.Visits))],
            [.. data.Days.Select(d => new RangeDayDto(Text(d.Date), d.DistanceM, d.MovingSeconds, d.Places))]), ct);
    }

    private static string Text(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>A line as <c>[[lon,lat],...]</c>, the order the stored lines and GeoJSON have.</summary>
    private static double[][] LonLat(IReadOnlyList<GeoPoint> line) => [.. line.Select(p => new[] { p.Longitude, p.Latitude })];
}
