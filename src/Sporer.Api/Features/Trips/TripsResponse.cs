using System.Text.Json.Serialization;

namespace Sporer.Api.Features.Trips;

/// <summary>The trips of the timeline, newest first, as served by <c>GET /api/trips</c>. Empty when there are none.</summary>
public sealed record TripsResponse(IReadOnlyList<TripDto> Trips);

/// <summary>
/// What a trip is described by wherever it is served: the list and the trip's own page both begin with it, and are made
/// from it (see <see cref="TripMapping.Summary"/>). <paramref name="Id"/> is its first night (<c>yyyy-MM-dd</c>), which is the
/// same after every rebuild as long as the trip starts the same night; <paramref name="FirstNight"/> and
/// <paramref name="LastNight"/> are the dates of the evenings of its first and last away night, and <paramref name="Nights"/>
/// counts every night between, those with no known position too. <paramref name="Start"/> and <paramref name="End"/> are when
/// the person left and came back (ISO-8601 UTC, <c>Z</c>); <paramref name="End"/> is always there, and null while the trip is
/// <paramref name="Ongoing"/>. The local dates are those of the start and end in <paramref name="StartTimeZone"/> and
/// <paramref name="EndTimeZone"/>, the IANA zones they were in (for an ongoing trip the end date is the day after its last
/// night; for a trip whose end date the owner set, the trip ends at the midnight after that date, so the end date is the one the
/// owner gave and not the date of <paramref name="End"/>). <paramref name="Name"/> is the owner's name for the trip where it has one, and made up when asked for where not (see
/// <see cref="TripNaming"/>), as are <paramref name="Cities"/>. <paramref name="Edited"/> says the owner has edited the trip: named it,
/// or changed its dates (an edit of the dates is why <paramref name="Id"/> may not be the night detection found it on).
/// <paramref name="OwnName"/> is the owner's name alone: <c>null</c> (present in the JSON, and null) when the owner has given none, so that
/// <paramref name="Name"/> is made up. <paramref name="Name"/> does not say which it is, and a form that sends a name back must know, or it
/// would make the made-up one the owner's. <paramref name="StartEdited"/> and <paramref name="EndEdited"/> say that the owner's edit has a start
/// date, and an end date, each of its own, which <paramref name="Edited"/> does not (a name is an edit too): a date that is not an edit is detection's
/// and may move on (the end of a trip that is still going on does), and a trip that has either can be put back to the dates that detection found it with.
/// </summary>
/// <remarks>
/// Not abstract, so that <see cref="TripMapping.Summary"/> can make one to build the others from; what the others add to it is
/// ordered after it (<c>JsonPropertyOrder(1)</c>), so that the JSON reads these fields first, in this order.
/// </remarks>
public record TripSummary(
    string Id,
    string Name,
    string FirstNight,
    string LastNight,
    int Nights,
    DateTime Start,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] DateTime? End,
    string StartTimeZone,
    string EndTimeZone,
    string LocalStartDate,
    string LocalEndDate,
    bool Ongoing,
    IReadOnlyList<TripCityDto> Cities,
    bool Edited,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? OwnName,
    bool StartEdited,
    bool EndEdited);

/// <summary>
/// A trip of the list: its <see cref="TripSummary"/>, and its <see cref="Thumbnail"/>, the line to draw for the trip,
/// <c>[[lon,lat],...]</c>: home, the places it slept at, home (see <see cref="TripThumbnail"/>); an ongoing trip has not come
/// back, so its line stops at the last place.
/// </summary>
public sealed record TripDto : TripSummary
{
    public TripDto(TripSummary summary, double[][] thumbnail) : base(summary) => Thumbnail = thumbnail;

    [JsonPropertyOrder(1)]
    public double[][] Thumbnail { get; }
}

/// <summary>
/// A city a trip stayed in: its <paramref name="Name"/> (the country, for nights whose place has no city), the number of its
/// known <paramref name="Nights"/> and the mean of their positions. <paramref name="Country"/> is null when the place has none.
/// </summary>
public sealed record TripCityDto(
    string Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Country,
    int Nights,
    double Lat,
    double Lon);
