using System.Globalization;
using FastEndpoints;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Places;

/// <summary>
/// The body of <c>PUT /api/places/{id}/name</c>: <paramref name="Name"/> is the owner's name for the place, or null, or empty, to go
/// back to the automatic one. It is read from the JSON body alone: a query that has a <c>name</c> is no part of the request.
/// </summary>
internal sealed record RenamePlaceRequest([property: DontBind(Source.QueryParam)] string? Name);

/// <summary>
/// <c>PUT /api/places/{id}/name</c>: the owner's name for a place, which is shown in place of OpenStreetMap's wherever the place is. A
/// place merged into another is the one it was merged into (as <c>GET /api/places/{id}</c> serves it), and that is the one named. The
/// name is trimmed, and one that is empty afterwards is none: OpenStreetMap's name shows again. It is at most
/// <see cref="MaxNameLength"/> characters, else 400. An id that is not a positive whole number is a 400, and one that is no place of the
/// timeline (see <see cref="PlaceStore.FindDetailAsync"/>) a 404. Answers 200 with the place, as <c>GET /api/places/{id}</c> gives it.
/// Nothing is reprocessed: the views read the name from the place.
/// </summary>
internal sealed class RenamePlaceEndpoint(PlaceStore places) : Endpoint<RenamePlaceRequest, PlaceResponse>
{
    /// <summary>The longest name, in characters as a text input counts them (UTF-16 code units).</summary>
    public const int MaxNameLength = 100;

    public override void Configure()
    {
        Put("places/{id}/name");
        AllowAnonymous();
    }

    public override async Task HandleAsync(RenamePlaceRequest req, CancellationToken ct)
    {
        var text = Route<string>("id", isRequired: false);
        // Digits only: no sign, no space, no exponent. An id too big for a long is no id either.
        if (!long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id <= 0)
        {
            ValidationFailures.Add(new("id", "The id must be a positive whole number."));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        var name = req.Name?.Trim();
        if (string.IsNullOrEmpty(name))
            name = null;
        if (name is { Length: > MaxNameLength })
        {
            ValidationFailures.Add(new("name", $"The name can be at most {MaxNameLength} characters."));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        var place = await places.RenameAsync(id, name, ct);
        if (place is null)
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        await Send.OkAsync(PlaceResponse.From(place), ct);
    }
}
