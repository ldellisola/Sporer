using System.Globalization;
using FastEndpoints;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Places;

/// <summary>
/// <c>GET /api/places/{id}</c>: a place and the time spent at it, for the place view. An id that is not a positive whole number
/// is a 400; one that is no place of the timeline (it does not exist, or is not in use, see <see cref="PlaceStore.FindDetailAsync"/>)
/// is a 404. A place merged into another is served as the one it was merged into. Reads only.
/// </summary>
internal sealed class GetPlaceEndpoint(PlaceStore places) : EndpointWithoutRequest<PlaceResponse>
{
    public override void Configure()
    {
        Get("places/{id}");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
    {
        var text = Route<string>("id", isRequired: false);
        // Digits only: no sign, no space, no exponent. An id too big for a long is no id either.
        if (!long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id <= 0)
        {
            ValidationFailures.Add(new("id", "The id must be a positive whole number."));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        var place = await places.FindDetailAsync(id, ct);
        if (place is null)
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        await Send.OkAsync(new PlaceResponse(
            place.Id, place.Name, place.Address, place.City, place.Country, place.Latitude, place.Longitude,
            place.TotalSeconds, place.Visits, place.FirstVisit, place.LastVisit,
            [.. place.RecentVisits.Select(v => new PlaceVisitDto(v.StartUtc, v.EndUtc, v.Date, v.TimeZone))]), ct);
    }
}
