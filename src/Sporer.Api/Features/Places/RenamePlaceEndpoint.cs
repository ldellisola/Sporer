using System.Text.Json.Serialization;
using FastEndpoints;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Places;

/// <summary>
/// The body of <c>PUT /api/places/{id}/name</c>: <paramref name="Name"/> is the owner's name for the place, or null, or empty, to go
/// back to the automatic one. It is read from the JSON body alone: a query that has a <c>name</c> is no part of the request.
/// <see cref="HasName"/> says whether the body had the property at all: asking for the automatic name is <c>"name": null</c>, and a
/// body that says nothing of it (<c>{}</c>, or none) must not be taken for that. (The JSON deserializer calls the setter only for a
/// property that is there, null or not, which is what tells the two apart. The accessors are <c>set</c>, not <c>init</c>: source
/// generation sets every init-only property at construction, which would make every body one that had a name. Neither
/// <c>required</c> nor <c>JsonRequired</c> made FastEndpoints refuse <c>{}</c>, because the property carries <c>[DontBind]</c>
/// (FastEndpoints 8.3.0) and the attributes are ignored on such a property; and a body with nothing in it binds an instance with
/// no setter called at all.)
/// </summary>
internal sealed record RenamePlaceRequest
{
    private string? _name;

    [DontBind(Source.QueryParam)]
    public string? Name
    {
        get => _name;
        set
        {
            _name = value;
            HasName = true;
        }
    }

    [JsonIgnore, DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public bool HasName { get; private set; }
}

/// <summary>
/// <c>PUT /api/places/{id}/name</c>: the owner's name for a place, which is shown in place of OpenStreetMap's wherever the place is. A
/// place merged into another is the one it was merged into (as <c>GET /api/places/{id}</c> serves it), and that is the one named. The
/// name is trimmed, and one that is empty afterwards is none: OpenStreetMap's name shows again. It is at most
/// <see cref="MaxNameLength"/> characters, else 400, and a body with no <c>name</c> in it is a 400 too (see <see cref="RenamePlaceRequest"/>). An id that is not a positive whole number is a 400, and one that is no place of the
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
        if (!PlaceId.TryParse(Route<string>("id", isRequired: false), out var id))
        {
            ValidationFailures.Add(new("id", PlaceId.InvalidMessage));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        if (!req.HasName)
        {
            ValidationFailures.Add(new("name", "The name is missing: send null, or an empty name, to go back to the automatic one."));
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
