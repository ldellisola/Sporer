using FastEndpoints;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Http;

namespace Sporer.Api.Features.Moves;

/// <summary>
/// The body of <c>PUT /api/moves/{id}/mode</c>: <paramref name="Mode"/> is one of <c>walk</c>, <c>cycle</c>, <c>drive</c>, <c>bus</c>,
/// <c>train</c> and <c>flight</c>, exactly. It is read from the JSON body alone: a query or a form that has a <c>mode</c> is no part of the
/// request.
/// </summary>
internal sealed record SetMoveModeRequest
{
    [DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public string? Mode { get; init; }
}

/// <summary>The answer to <c>PUT /api/moves/{id}/mode</c>: the move, by the id it was asked for by, its mode now, and that the owner set it.</summary>
public sealed record MoveModeResponse(long Id, string Mode, bool ModeEdited);

/// <summary>
/// <c>PUT /api/moves/{id}/mode</c>: the owner says how the stored move <c>id</c> was travelled (an id from the day, the range or a trip; ids
/// change on every rebuild, so a client reloads the day after this). The edit is kept by the move's time, in place of any edit that overlapped
/// it, so it survives every rebuild (see <see cref="ModeEditStore.SetAsync"/>); the stored move takes the mode at once, and its stretch is asked
/// to be rebuilt at once, so that its line and distance follow a change to or from a flight. Answers 200 with
/// <c>{"id", "mode", "modeEdited": true}</c>. 400 for an id that is not a positive whole number, and for a <c>mode</c> that is missing or is not
/// one of the six; 404 when no stored move has that id (a stay or a gap is not one).
/// </summary>
internal sealed class SetMoveModeEndpoint(ModeEditStore edits, TimeProvider time) : Endpoint<SetMoveModeRequest, MoveModeResponse>
{
    public override void Configure()
    {
        Put("moves/{id}/mode");
        AllowAnonymous();
    }

    public override async Task HandleAsync(SetMoveModeRequest req, CancellationToken ct)
    {
        if (!PositiveId.TryParse(Route<string>("id", isRequired: false), out var id))
        {
            ValidationFailures.Add(new("id", PositiveId.InvalidMessage));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        if (!TravelModeNames.TryParse(req.Mode, out var mode))
        {
            ValidationFailures.Add(new("mode", $"The mode must be one of {string.Join(", ", TravelModeNames.All)}."));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        if (!await edits.SetAsync(id, mode, time.GetUtcNow().UtcDateTime, ct))
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        await Send.OkAsync(new MoveModeResponse(id, TravelModeNames.Name(mode), ModeEdited: true), ct);
    }
}

/// <summary>
/// <c>DELETE /api/moves/{id}/mode</c>: takes back the mode the owner set on the stored move <c>id</c>. Every edit that overlaps the move's time
/// is deleted, and its stretch is asked to be rebuilt at once, which brings back the detected mode (see <see cref="ModeEditStore.ClearAsync"/>).
/// Answers 204, whether or not there was an edit to take back; 400 for an id that is not a positive whole number; 404 when no stored move has
/// that id.
/// </summary>
internal sealed class ClearMoveModeEndpoint(ModeEditStore edits, TimeProvider time) : EndpointWithoutRequest
{
    public override void Configure()
    {
        Delete("moves/{id}/mode");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        if (!PositiveId.TryParse(Route<string>("id", isRequired: false), out var id))
        {
            ValidationFailures.Add(new("id", PositiveId.InvalidMessage));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        if (!await edits.ClearAsync(id, time.GetUtcNow().UtcDateTime, ct))
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        await Send.NoContentAsync(ct);
    }
}
