using FastEndpoints;
using Microsoft.Extensions.Options;
using Sporer.Api.Configuration;
using Sporer.Api.Database;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Status;

/// <summary>
/// <c>GET /api/status</c>: the owner's window into whether the processing, above all the backfill of years of history, is
/// healthy. Reads only. The warnings are those recorded at start-up (the database checks, and place naming that is
/// enabled but has no user agent) plus the one about ingest being open, which is a setting and so read as it stands.
/// </summary>
internal sealed class GetStatusEndpoint(
    ProcessingQueue queue,
    PlaceStore places,
    DatabaseWarnings databaseWarnings,
    IOptions<OverlandOptions> overland) : EndpointWithoutRequest<StatusResponse>
{
    public override void Configure()
    {
        Get("status");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        var state = await queue.GetStateAsync(ct);
        var backlog = await queue.GetBacklogAsync(ct);
        var counts = await places.CountInUseAsync(ct);

        List<string> warnings = [.. databaseWarnings.Items];
        if (string.IsNullOrEmpty(overland.Value.Token))
            warnings.Add(OverlandOptions.OpenIngestWarning);

        await Send.OkAsync(new StatusResponse(
            state.AlgorithmVersion,
            new BackfillStatus(state.BackfillFrom, state.BackfillTo, state.BackfillCursor,
                Percent(state.BackfillFrom, state.BackfillTo, state.BackfillCursor), state.Paused),
            backlog.Pending,
            [.. backlog.Failed.Select(f => new FailedRangeDto(f.FromUtc, f.ToUtc, f.Attempts, f.LastError))],
            state.LastRunAt,
            state.LastError,
            new PlaceStatus(counts.Total, counts.Unnamed, counts.Failed),
            warnings), ct);
    }

    /// <summary>
    /// How much of <paramref name="from"/> to <paramref name="to"/> lies behind <paramref name="cursor"/>, in percent, rounded
    /// down to a tenth so that 100 means the cursor has reached the end. 100 as well where there is no range to backfill;
    /// a range without a cursor has made no progress.
    /// </summary>
    private static double Percent(DateTime? from, DateTime? to, DateTime? cursor)
    {
        if (from is not { } start || to is not { } end || end <= start)
            return 100;
        if (cursor is not { } at || at <= start)
            return 0;
        if (at >= end)
            return 100;

        // Decimal, so that a share that is exact in decimal (17 of 40 days, 0.425) is not rounded down by binary error.
        var share = (decimal)(at - start).Ticks / (end - start).Ticks;
        return (double)(Math.Floor(share * 1000m) / 10m);
    }
}
