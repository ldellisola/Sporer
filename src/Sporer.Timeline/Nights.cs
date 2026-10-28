namespace Sporer.Timeline;

/// <summary>
/// One night of the history: where the person slept, identified by the date of its evening. The night of 22 October is
/// located at 03:00 local time on 23 October (<see cref="NightClock"/>), and <paramref name="InstantUtc"/> and
/// <paramref name="Zone"/> are that instant and the IANA zone it was read in. A null <paramref name="Position"/> means
/// the night is unknown (no stay or point near enough). <paramref name="PlaceId"/> is the place the position belongs to,
/// or null if it matches none; it is the surviving place's id, because the caller resolves merged places first.
/// </summary>
public sealed record Night(DateOnly Date, DateTime InstantUtc, string Zone, long? PlaceId, GeoPoint? Position);

/// <summary>
/// A stretch of nights during which one place was home. Both ends are inclusive night dates; a null
/// <paramref name="To"/> means the period is still open, so it is the current home.
/// </summary>
public sealed record HomePeriod(long PlaceId, DateOnly From, DateOnly? To);

/// <summary>A stay reduced to what night and trip detection need: when it began and ended, and where it was.</summary>
public sealed record StayPosition(DateTime StartUtc, DateTime EndUtc, GeoPoint Position);

/// <summary>
/// A run of consecutive away nights from <paramref name="FirstNight"/> to <paramref name="LastNight"/>
/// (<paramref name="Nights"/> counts them, unknown ones in between included). It leaves at
/// <paramref name="StartUtc"/> and returns at <paramref name="EndUtc"/>, which is null while the trip is ongoing. The
/// zones are the IANA zones of the start and the end, and the local dates are the calendar dates of them in those zones.
/// </summary>
public sealed record DetectedTrip(
    DateOnly FirstNight,
    DateOnly LastNight,
    int Nights,
    DateTime StartUtc,
    DateTime? EndUtc,
    string StartZone,
    string EndZone,
    DateOnly LocalStartDate,
    DateOnly LocalEndDate);
