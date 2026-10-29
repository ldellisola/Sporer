using FastEndpoints;
using Sporer.Api.Features.Trips;

namespace Sporer.Api.Features.Homes;

/// <summary>
/// <c>GET /api/homes</c>: the home periods as they are stored, those detection found and those the owner set, in date order, each with the name
/// of the place that survives merges (see <see cref="HomeStore.ListAsync"/>). It is not the homes in effect: where an owner's period covers a
/// detected one, both are listed, and the owner's wins (see <see cref="Sporer.Timeline.HomeOverrides"/>). Reads only.
/// </summary>
internal sealed class GetHomesEndpoint(HomeStore homes) : EndpointWithoutRequest<HomesResponse>
{
    public override void Configure()
    {
        Get("homes");
        AllowAnonymous();
    }

    public override async Task HandleAsync(CancellationToken ct)
        => await Send.OkAsync(new HomesResponse([.. (await homes.ListAsync(ct)).Select(ToDto)]), ct);

    internal static HomeDto ToDto(HomeEntry entry) => new(
        entry.Id, entry.PlaceId, entry.PlaceName, TripMapping.Text(entry.From), entry.To is { } to ? TripMapping.Text(to) : null, entry.Source);
}
