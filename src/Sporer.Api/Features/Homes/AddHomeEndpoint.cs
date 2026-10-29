using System.Globalization;
using System.Text.Json.Serialization;
using FastEndpoints;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;

namespace Sporer.Api.Features.Homes;

/// <summary>
/// The body of <c>POST /api/homes</c>: the <paramref name="PlaceId"/> that was home, and the night dates (<c>yyyy-MM-dd</c>) it was from
/// <paramref name="From"/> to <paramref name="To"/>, null for a home that goes on. All three are read from the JSON body alone, and all three have
/// to be in it: a body that says nothing of <c>to</c> is a 400 and not a home with no end, because a period that was never closed is not
/// what a form that left one out meant. <see cref="HasTo"/> says whether the body had it at all: the deserializer calls the setter only for a
/// property that is there, null or not (the accessor is <c>set</c>, not <c>init</c>, and carries <c>[DontBind]</c>, for the reasons
/// <see cref="Sporer.Api.Features.Places.RenamePlaceRequest"/> gives). The dates are read as text, so that exactly <c>yyyy-MM-dd</c> is a
/// date and the answer to any other is a 400 of this endpoint's own.
/// </summary>
internal sealed record AddHomeRequest
{
    private string? _to;

    [DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public long? PlaceId { get; init; }

    [DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public string? From { get; init; }

    [DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public string? To
    {
        get => _to;
        set
        {
            _to = value;
            HasTo = true;
        }
    }

    [JsonIgnore, DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public bool HasTo { get; private set; }
}

/// <summary>
/// <c>POST /api/homes</c>: the owner says that a place was home from one night date to another, which replaces what detection found for
/// those dates (see <see cref="Sporer.Timeline.HomeOverrides"/>) and holds across refreshes and rebuilds of the timeline. The trips are
/// worked out again before the answer (see <see cref="EditRecompute"/>). Answers 201 with the period, as <c>GET /api/homes</c> lists it.
/// </summary>
/// <remarks>
/// <para>
/// <b>The place</b> is as <c>GET /api/places/{id}</c> reads an id: one that was merged into another is the one it was merged into, and that is
/// the place the period is stored at. A place that is no place of the timeline (see <see cref="PlaceStore.FindDetailAsync"/>) is a 404.
/// </para>
/// <para>
/// <b>The dates</b> are <c>yyyy-MM-dd</c> and no other form, from <see cref="EditTripEndpoint.EarliestDate"/> to
/// <see cref="EditTripEndpoint.LatestDate"/>. <c>from</c> may be the same date as <c>to</c> (one night) but not after it: that is a 400. A period
/// that shares a date with another one of the owner's is a 409, whatever the place; touching (one ends the day before the next begins) is not
/// sharing. A detected period may be overlapped: the owner's wins on its dates.
/// </para>
/// <para>
/// The 400s come before the 404 and the 409. The recompute is as for every edit: if it fails, the period is stored, the answer is still 201,
/// and the worker is asked to do it.
/// </para>
/// </remarks>
internal sealed class AddHomeEndpoint(HomeStore homes, PlaceStore places, EditRecompute recompute) : Endpoint<AddHomeRequest, HomeDto>
{
    public override void Configure()
    {
        Post("homes");
        AllowAnonymous();
    }

    public override async Task HandleAsync(AddHomeRequest req, CancellationToken ct)
    {
        if (req.PlaceId is not { } placeId || placeId <= 0)
            ValidationFailures.Add(new("placeId", "The place must be given, as a positive whole number."));

        var from = ParseDate(req.From, "from", required: true);
        if (!req.HasTo)
            ValidationFailures.Add(new("to", "The end date is missing: send null for a home that goes on."));
        var to = ParseDate(req.To, "to", required: false);

        if (ValidationFailures.Count == 0 && from > to)
            ValidationFailures.Add(new("from", "The first date must not be after the last."));
        if (ValidationFailures.Count > 0)
        {
            await Send.ErrorsAsync(400, ct);
            return;
        }

        var place = await places.FindDetailAsync(req.PlaceId!.Value, ct);
        if (place is null)
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        // The place that survives merges is the place of the period.
        var id = await homes.AddUserAsync(place.Id, from!.Value, to, ct);
        if (id is null)
        {
            ValidationFailures.Add(new("from", "Another home you set has a night in these dates."));
            await Send.ErrorsAsync(409, ct);
            return;
        }

        await recompute.RecomputeAfterEditAsync(ct);

        await Send.ResponseAsync(new HomeDto(
            id.Value, place.Id, place.Name, TripMapping.Text(from.Value), to is { } end ? TripMapping.Text(end) : null, "user"), 201, ct);
    }

    /// <summary>
    /// The date <paramref name="text"/> says, or null for none, which is a failure of <paramref name="property"/> where one is
    /// <paramref name="required"/>, and so is a text that is not a date or is out of range.
    /// </summary>
    private DateOnly? ParseDate(string? text, string property, bool required)
    {
        if (text is null)
        {
            if (required)
                ValidationFailures.Add(new(property, "The date must be given, as yyyy-MM-dd."));
            return null;
        }

        if (!DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            || date < EditTripEndpoint.EarliestDate || date > EditTripEndpoint.LatestDate)
        {
            ValidationFailures.Add(new(property,
                $"The date must be written yyyy-MM-dd, from {TripMapping.Text(EditTripEndpoint.EarliestDate)} to {TripMapping.Text(EditTripEndpoint.LatestDate)}"
                + (required ? "." : ", or be null.")));
            return null;
        }

        return date;
    }
}
