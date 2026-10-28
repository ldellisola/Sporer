using FastEndpoints;
using Sporer.Api.Features.Day;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Points;

/// <summary>
/// One removal, as <c>GET /api/points/removed</c> lists it: the <paramref name="Batch"/> that <c>DELETE /api/points/removed/{batch}</c>
/// restores, when it was made, how many points it holds, the times of the first and the last of them, and the local dates they are on
/// (<c>yyyy-MM-dd</c>, oldest first, each in the zone the day view shows it in).
/// </summary>
public sealed record RemovedBatchDto(
    Guid Batch, DateTime RemovedAt, int Count, DateTime From, DateTime To, IReadOnlyList<string> LocalDates);

/// <summary>
/// <c>GET /api/points/removed</c>: the removals the owner has made and not restored, newest first, as an array of <see cref="RemovedBatchDto"/>.
/// A point is on a date when it is among that day's points (<c>GET /api/day/{date}/points</c>, see <see cref="DayZone"/>), which is what the day
/// is, so a removal is listed on the days it can be seen on. Reads only.
/// </summary>
internal sealed class GetRemovedPointsEndpoint(ExcludedPointStore store, SegmentStore segments)
    : EndpointWithoutRequest<IReadOnlyList<RemovedBatchDto>>
{
    public override void Configure()
    {
        Get("points/removed");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        var batches = await store.ListAsync(ct);

        // What a date is is worked out once, however many removals are on it.
        var spans = new Dictionary<DateOnly, (DateTime FromUtc, DateTime ToUtc)>();
        async Task<(DateTime FromUtc, DateTime ToUtc)> SpanOf(DateOnly date)
        {
            if (!spans.TryGetValue(date, out var span))
                spans[date] = span = await DayZone.FindPointSpanAsync(segments, date, ct);
            return span;
        }

        var result = new List<RemovedBatchDto>(batches.Count);
        foreach (var batch in batches)
        {
            var dates = await RemovedBatchDates.OfAsync(batch.TimesUtc, SpanOf);
            result.Add(new RemovedBatchDto(
                batch.Batch, batch.RemovedAt, batch.TimesUtc.Count, batch.TimesUtc[0], batch.TimesUtc[^1], [.. dates.Select(DayDate.ToText)]));
        }

        await Send.OkAsync(result, ct);
    }
}
