using System.Globalization;
using System.Text.Json.Serialization;
using FastEndpoints;
using Sporer.Api.Features.Places;
using Sporer.Timeline;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// The body of <c>PUT /api/trips/{id}</c>: <paramref name="Name"/> is the owner's name for the trip, and <paramref name="StartDate"/> and
/// <paramref name="EndDate"/> (<c>yyyy-MM-dd</c>) the local dates it begins and ends on. Null, for each of them, is as detected. All three are
/// read from the JSON body alone, and all three have to be in it: a body that says nothing of one is a 400, because it asks for nothing
/// that null does not (<c>"name": null</c> is the automatic name), and a request that asks for no change must not take back what the owner
/// set. <see cref="HasName"/>, <see cref="HasStartDate"/> and <see cref="HasEndDate"/> say whether the body had the property at all; the
/// deserializer calls the setter only for a property that is there, null or not, which is what tells the two apart. (The accessors are
/// <c>set</c>, not <c>init</c>, and carry <c>[DontBind]</c>, for the reasons <see cref="RenamePlaceRequest"/> gives.) The dates are read as
/// text, so that exactly <c>yyyy-MM-dd</c> is a date and the answer to any other is a 400 of this endpoint's own.
/// </summary>
internal sealed record EditTripRequest
{
    private string? _name;
    private string? _startDate;
    private string? _endDate;

    [DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public string? Name
    {
        get => _name;
        set
        {
            _name = value;
            HasName = true;
        }
    }

    [DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public string? StartDate
    {
        get => _startDate;
        set
        {
            _startDate = value;
            HasStartDate = true;
        }
    }

    [DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public string? EndDate
    {
        get => _endDate;
        set
        {
            _endDate = value;
            HasEndDate = true;
        }
    }

    [JsonIgnore, DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public bool HasName { get; private set; }

    [JsonIgnore, DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public bool HasStartDate { get; private set; }

    [JsonIgnore, DontBind(Source.QueryParam | Source.RouteParam | Source.FormField)]
    public bool HasEndDate { get; private set; }
}

/// <summary>The answer to <c>PUT /api/trips/{id}</c>: the trip's id now, which is its first night, and may have moved with its start date.</summary>
public sealed record EditTripResponse(string Id);

/// <summary>
/// <c>PUT /api/trips/{id}</c>: what the owner says the trip is, which replaces whatever they said before: a name, and the local dates it begins
/// and ends on, each of them null for as detected (see <see cref="EditTripRequest"/>). It is stored as an edit of the trip as detection found it,
/// and put on the trip again every time the trips are worked out, so it holds when new data comes in and when the timeline is rebuilt (see
/// <see cref="TripEdits"/>). Answers 200 with <see cref="EditTripResponse"/>.
/// </summary>
/// <remarks>
/// <para>
/// <b>The id</b> is the trip's own, the date of its first night, as <c>GET /api/trips</c> gives it; the edit is keyed by the first night that
/// detection gave the trip when it was edited, which is the one in the trip's <c>detected_id</c> if it has been moved. An id that is not
/// <c>yyyy-MM-dd</c>, or no trip has, is a 404.
/// </para>
/// <para>
/// <b>The name</b> is trimmed, and one that is empty afterwards is none: the automatic one shows again. At most
/// <see cref="RenamePlaceEndpoint.MaxNameLength"/> characters, else 400.
/// </para>
/// <para>
/// <b>The dates.</b> The start date is the day the trip begins and the end date the day the person is back, so the trip's nights are from the
/// evening of the first to the one before the second: the start date must be before the end date, else 400. The trip begins at midnight
/// at the start of the start date and ends at midnight at the end of the end date (see <see cref="TripEdits"/>), so the day of the journey
/// home is part of the trip. A date is <c>yyyy-MM-dd</c> and no other
/// form, from <see cref="EarliestDate"/> to <see cref="LatestDate"/>, else 400. A date the trip has already, where the owner has not given
/// it one (a form that is filled in with the trip's dates and sends them back as they are), is as detected: the trip keeps the moments detection
/// found, and does not begin or end at midnight. With only one of the dates, the trip's other end is as detected, and the nights it would
/// have are worked out against that for the checks. A trip whose new nights would share one with another trip, as the trips are now, is a 409;
/// touching is not sharing (one is over the day the next begins).
/// </para>
/// <para>
/// <b>The answer</b> comes when the trips are worked out again (see <see cref="EditRecompute"/>), and its id is the one the trip then has. When
/// that fails, the worker is asked to do it, the edit is done and answered, and the id is the one the edit says: the start date if it gave one,
/// else the first night the trip was detected on if it had a start date and has none, else the id it has.
/// </para>
/// </remarks>
internal sealed class EditTripEndpoint(TripEditStore edits, EditRecompute recompute) : Endpoint<EditTripRequest, EditTripResponse>
{
    /// <summary>The earliest date a trip can be given: nothing was ever logged before it.</summary>
    public static readonly DateOnly EarliestDate = new(1970, 1, 1);

    /// <summary>The latest date a trip can be given.</summary>
    public static readonly DateOnly LatestDate = new(2099, 12, 31);

    public override void Configure()
    {
        Put("trips/{id}");
        AllowAnonymous();
    }

    public override async Task HandleAsync(EditTripRequest req, CancellationToken ct)
    {
        if (!TripId.TryParse(Route<string>("id", isRequired: false), out var id))
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        if (!req.HasName)
            ValidationFailures.Add(new("name", "The name is missing: send null, or an empty name, for the automatic one."));
        if (!req.HasStartDate)
            ValidationFailures.Add(new("startDate", "The start date is missing: send null for the one the trip was detected with."));
        if (!req.HasEndDate)
            ValidationFailures.Add(new("endDate", "The end date is missing: send null for the one the trip was detected with."));

        var name = req.Name?.Trim();
        if (string.IsNullOrEmpty(name))
            name = null;
        if (name is { Length: > RenamePlaceEndpoint.MaxNameLength })
            ValidationFailures.Add(new("name", $"The name can be at most {RenamePlaceEndpoint.MaxNameLength} characters."));

        var start = ParseDate(req.StartDate, "startDate");
        var end = ParseDate(req.EndDate, "endDate");
        if (ValidationFailures.Count > 0)
        {
            await Send.ErrorsAsync(400, ct);
            return;
        }

        var target = await edits.FindTargetAsync(id, ct);
        if (target is null)
        {
            await Send.NotFoundAsync(ct);
            return;
        }

        // A date the trip has, where the owner has not given it one, is the trip as it was detected, and not a date to hold it to.
        if (start == target.LocalStartDate && target.Edit?.StartDate is null)
            start = null;
        if (end == target.LocalEndDate && target.Edit?.EndDate is null)
            end = null;

        // The nights the trip is to have. A date that is as detected is the detected one, which the trip row says when it has not been
        // edited, and the edit says (by its key and last night) when it has.
        var first = start ?? (target.Edit?.StartDate is null ? target.Id : target.Edit.DetectedId);
        var last = end?.AddDays(-1) ?? (target.Edit?.EndDate is null ? target.LastNight : target.Edit.DetectedLastNight);
        if (first > last)
        {
            ValidationFailures.Add(new(end is null ? "startDate" : "endDate", "The start date must be before the end date."));
            await Send.ErrorsAsync(400, ct);
            return;
        }

        if (target.Others.Any(other => other.FirstNight <= last && first <= other.LastNight))
        {
            ValidationFailures.Add(new(start is null ? "endDate" : "startDate",
                $"The trip would have nights from {TripMapping.Text(first)} to {TripMapping.Text(last)}, and another trip has one of them."));
            await Send.ErrorsAsync(409, ct);
            return;
        }

        await edits.SaveAsync(new TripEdit(target.Key, target.Edit?.DetectedLastNight ?? target.LastNight, name, start, end, Deleted: false), ct);

        var recomputed = await recompute.RecomputeAfterEditAsync(ct);

        var now = recomputed ? await edits.FindIdByKeyAsync(target.Key, ct) : null;
        await Send.OkAsync(new EditTripResponse(TripMapping.Text(
            now ?? start ?? (target.Edit?.StartDate is not null ? target.Key : target.Id))), ct);
    }

    /// <summary>
    /// The date <paramref name="text"/> says, or null for none (null is as detected), or for one that is not a date or is out of range, which is
    /// a failure of <paramref name="property"/>.
    /// </summary>
    private DateOnly? ParseDate(string? text, string property)
    {
        if (text is null)
            return null;

        if (!DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            || date < EarliestDate || date > LatestDate)
        {
            ValidationFailures.Add(new(property,
                $"The date must be written yyyy-MM-dd, from {TripMapping.Text(EarliestDate)} to {TripMapping.Text(LatestDate)}, or be null."));
            return null;
        }

        return date;
    }
}
