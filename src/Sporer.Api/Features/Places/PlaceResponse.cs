using System.Text.Json.Serialization;
using Sporer.Api.Features.Timeline;

namespace Sporer.Api.Features.Places;

/// <summary>
/// A place and the time spent at it, as served by <c>GET /api/places/{id}</c>. <paramref name="Id"/> is the one that survives a
/// merge, whichever id was asked for. <paramref name="Name"/> is the owner's, else OpenStreetMap's, else null; the address, city
/// and country are null until the place is named. <paramref name="TotalSeconds"/> and <paramref name="Visits"/> are over all of
/// its stays, and those of the places merged into it, and <paramref name="FirstVisit"/> and <paramref name="LastVisit"/> are when
/// the earliest and the latest of those began (ISO-8601 UTC, <c>Z</c>). <paramref name="RecentVisits"/> are the latest 50 stays,
/// newest first. <paramref name="Merged"/> are the places merged directly into it, each by its id and its name (the owner's, else
/// OpenStreetMap's, else null), so that one of them can be separated from it again: ordered by name, whatever the case, then by id;
/// one with no name comes last.
/// </summary>
public sealed record PlaceResponse(
    long Id,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Address,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? City,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Country,
    double Lat,
    double Lon,
    long TotalSeconds,
    int Visits,
    DateTime FirstVisit,
    DateTime LastVisit,
    IReadOnlyList<PlaceVisitDto> RecentVisits,
    IReadOnlyList<MergedPlaceDto> Merged)
{
    /// <summary>The answer for <paramref name="place"/>, as <c>GET /api/places/{id}</c> and the writes to a place give it.</summary>
    public static PlaceResponse From(PlaceDetail place) => new(
        place.Id, place.Name, place.Address, place.City, place.Country, place.Latitude, place.Longitude,
        place.TotalSeconds, place.Visits, place.FirstVisit, place.LastVisit,
        [.. place.RecentVisits.Select(v => new PlaceVisitDto(v.StartUtc, v.EndUtc, v.Date, v.TimeZone))],
        [.. place.Merged.Select(m => new MergedPlaceDto(m.Id, m.Name))]);
}

/// <summary>A place that was merged into another: its <paramref name="Id"/>, and its <paramref name="Name"/> or null.</summary>
public sealed record MergedPlaceDto(long Id, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Name);

/// <summary>
/// A place that a place can be merged with, as served by <c>GET /api/places/{id}/candidates</c>: <paramref name="Name"/> is the owner's,
/// else OpenStreetMap's, else null, <paramref name="Address"/> is null until the place is named, <paramref name="DistanceM"/> is the
/// distance in metres from the place asked about, and <paramref name="Visits"/> the stays there were at it and at the places merged into it.
/// </summary>
public sealed record PlaceCandidateDto(
    long Id,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Address,
    double DistanceM,
    int Visits);

/// <summary>
/// A place in use, as served by <c>GET /api/places/search</c>: <paramref name="Name"/> is the owner's, else OpenStreetMap's, else null,
/// <paramref name="Address"/> is null until the place is named, and <paramref name="Visits"/> is the stays there were at it and at the places
/// merged into it.
/// </summary>
public sealed record PlaceSearchDto(
    long Id,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Address,
    int Visits);

/// <summary>
/// A stay at a place. <paramref name="Date"/> is the local date it started on (<c>yyyy-MM-dd</c>), in <paramref name="TimeZone"/>,
/// the IANA zone it started in, so that a client shows the times of the visit on the clock of the place it was at.
/// </summary>
public sealed record PlaceVisitDto(DateTime Start, DateTime End, string Date, string TimeZone);
