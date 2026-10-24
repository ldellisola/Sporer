using FastEndpoints;
using Sporer.Api.Features.Range;

namespace Sporer.Api.Features.Heat;

/// <summary>
/// <c>GET /api/heat?from=yyyy-MM-dd&amp;to=yyyy-MM-dd</c>: where the time of a stretch of local days was spent, for the map's heat
/// layer. The range is read as the range API reads it (<see cref="DateRange.TryParse"/>), and the weights are time, not
/// points (see <see cref="RangeStore.FindHeatAsync"/>). Reads only.
/// </summary>
internal sealed class GetHeatEndpoint(RangeStore store) : EndpointWithoutRequest<HeatResponse>
{
    public override void Configure()
    {
        Get("heat");
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

        var cells = await store.FindHeatAsync(range, ct);

        // The cells are in the order of their weight, so the first has the most.
        await Send.OkAsync(new HeatResponse(
            cells.Count > 0 ? cells[0].Seconds : 0,
            [.. cells.Select(c => new[] { c.Longitude, c.Latitude, (double)c.Seconds })]), ct);
    }
}
