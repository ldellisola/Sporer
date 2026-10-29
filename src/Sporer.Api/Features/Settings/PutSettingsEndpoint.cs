using System.Text.Json.Serialization;
using FastEndpoints;
using Sporer.Api.Features.Trips;
using Sporer.Timeline;

namespace Sporer.Api.Features.Settings;

/// <summary>
/// The body of <c>PUT /api/settings</c>: <paramref name="TripMinDistanceKm"/> is the distance in kilometres from home that a night must be to be
/// away, or null for the one that is configured. It is read from the JSON body alone, and has to be in it: <see cref="HasTripMinDistanceKm"/> says
/// whether the body had the property at all, because null is a request (take the setting back) and a body that says nothing of it (<c>{}</c>, or
/// none) must not be taken for it. (The deserializer calls the setter only for a property that is there, null or not. The accessor is <c>set</c>,
/// not <c>init</c>, and carries <c>[DontBind]</c>, for the reasons <see cref="Sporer.Api.Features.Places.RenamePlaceRequest"/> gives.)
/// </summary>
internal sealed record PutSettingsRequest
{
    private double? _tripMinDistanceKm;

    [DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public double? TripMinDistanceKm
    {
        get => _tripMinDistanceKm;
        set
        {
            _tripMinDistanceKm = value;
            HasTripMinDistanceKm = true;
        }
    }

    [JsonIgnore, DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public bool HasTripMinDistanceKm { get; private set; }
}

/// <summary>
/// <c>PUT /api/settings</c>: sets the distance that a night must be from home to be away (a number from
/// <see cref="SettingsStore.MinTripDistanceKm"/> to <see cref="SettingsStore.MaxTripDistanceKm"/>, the ends included; anything else is a 400),
/// or, with null, takes the setting back. The trips are worked out again from the nights as they are stored, before the answer (see
/// <see cref="EditRecompute"/>): nothing is rebuilt, because the distance is no part of the algorithm's version. Answers 200 with the settings, as
/// <c>GET /api/settings</c> gives them.
/// </summary>
internal sealed class PutSettingsEndpoint(SettingsStore settings, EditRecompute recompute, DetectionOptions options)
    : Endpoint<PutSettingsRequest, SettingsResponse>
{
    public override void Configure()
    {
        Put("settings");
        AllowAnonymous();
    }

    public override async Task HandleAsync(PutSettingsRequest req, CancellationToken ct)
    {
        if (!req.HasTripMinDistanceKm)
            ValidationFailures.Add(new("tripMinDistanceKm", "The distance is missing: send null for the one that is configured."));
        else if (req.TripMinDistanceKm is { } km && !(km >= SettingsStore.MinTripDistanceKm && km <= SettingsStore.MaxTripDistanceKm))
            ValidationFailures.Add(new("tripMinDistanceKm",
                $"The distance must be from {SettingsStore.MinTripDistanceKm} to {SettingsStore.MaxTripDistanceKm} kilometres, or be null."));

        if (ValidationFailures.Count > 0)
        {
            await Send.ErrorsAsync(400, ct);
            return;
        }

        await settings.SetTripMinDistanceKmAsync(req.TripMinDistanceKm, ct);

        await recompute.RecomputeAfterEditAsync(ct);

        await Send.OkAsync(new SettingsResponse(req.TripMinDistanceKm ?? options.TripMinDistanceKm, options.TripMinDistanceKm), ct);
    }
}
