namespace Sporer.Timeline;

/// <summary>
/// Thresholds for point cleaning, stay/move segmentation, mode classification, place matching and the home and trip
/// rules (spec section 6). Bound from configuration section <c>Detection</c>; the defaults are the spec's.
/// </summary>
public sealed record DetectionOptions
{
    /// <summary>Points with a reported horizontal accuracy worse than this are dropped.</summary>
    public double MaxAccuracyMeters { get; init; } = 100;

    /// <summary>An out-and-back jump implying more than this speed is treated as a GPS glitch.</summary>
    public double GlitchSpeedKmh { get; init; } = 300;

    /// <summary>Points within this distance of a stay's first point belong to the stay.</summary>
    public double StayRadiusMeters { get; init; } = 100;

    /// <summary>Minimum time within <see cref="StayRadiusMeters"/> to count as a stay.</summary>
    public TimeSpan StayMinDuration { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>A silent gap whose implied speed is below this still counts as stationary.</summary>
    public double StationaryGapMaxSpeedMps { get; init; } = 1.0;

    /// <summary>Speed assumed when the person left after a silent stay (end of stay = next point minus distance / this).</summary>
    public double WalkingSpeedMps { get; init; } = 1.4;

    /// <summary>A pause in logging at least this long, outside a stay, is a gap segment.</summary>
    public TimeSpan GapMinDuration { get; init; } = TimeSpan.FromMinutes(30);

    /// <summary>A hop at least this fast may be part of a flight.</summary>
    public double FlightSpeedKmh { get; init; } = 200;

    /// <summary>A run of fast hops must cover at least this distance to be a flight.</summary>
    public double FlightMinDistanceKm { get; init; } = 100;

    /// <summary>Median speed below this is walking.</summary>
    public double WalkMaxKmh { get; init; } = 7;

    /// <summary>Median speed below this (and at least <see cref="WalkMaxKmh"/>) is cycling; above it is driving.</summary>
    public double CycleMaxKmh { get; init; } = 25;

    /// <summary>A stay within this distance of a known place is matched to it.</summary>
    public double PlaceRadiusMeters { get; init; } = 75;

    /// <summary>Line simplification tolerance for the detailed track.</summary>
    public double DetailToleranceMeters { get; init; } = 5;

    /// <summary>Line simplification tolerance for the coarse track.</summary>
    public double CoarseToleranceMeters { get; init; } = 50;

    /// <summary>
    /// The hour of local time (24-hour clock) a night is located at: the night of a date is placed at this hour on the
    /// next day, in the zone the person was in then (spec 6.6, 03:00).
    /// </summary>
    public int NightHour { get; init; } = 3;

    /// <summary>
    /// When no stay covers a night's instant, the nearest raw point within this long of it locates the night; if there
    /// is none, the night is unknown.
    /// </summary>
    public TimeSpan NightPointWindow { get; init; } = TimeSpan.FromHours(12);

    /// <summary>A new home is judged over this many consecutive calendar nights.</summary>
    public int HomeWindowNights { get; init; } = 90;

    /// <summary>
    /// A place becomes home once it, with the places within <see cref="HomeRadiusMeters"/> of it, is the night location on at
    /// least this many of the last <see cref="HomeWindowNights"/> nights; unknown nights count against it. Keep it above half
    /// the window, so that only one home can qualify at a time.
    /// </summary>
    public int HomeMinNights { get; init; } = 60;

    /// <summary>
    /// Places within this distance of each other count as one home, because GPS drift can split a home into several places
    /// a hundred metres or so apart (a stay matches a place within <see cref="PlaceRadiusMeters"/> or makes its own). Two
    /// homes closer than this are one home: a move next door is not detected. That is harmless, because it is far below
    /// <see cref="TripMinDistanceKm"/>.
    /// </summary>
    public double HomeRadiusMeters { get; init; } = 250;

    /// <summary>A night is away when its location is at least this far from the home in effect that night.</summary>
    public double TripMinDistanceKm { get; init; } = 50;
}
