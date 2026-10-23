namespace Sporer.Timeline;

/// <summary>
/// Thresholds for point cleaning, stay/move segmentation, mode classification and place matching
/// (spec section 6). Bound from configuration section <c>Detection</c>; the defaults are the spec's.
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
}
