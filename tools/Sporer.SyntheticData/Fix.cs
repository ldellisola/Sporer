namespace Sporer.SyntheticData;

/// <summary>
/// One logged location, as a row of <c>locationlog</c>. <paramref name="Accuracy"/> and <paramref name="Motion"/> are
/// filled only for the most recent days, as in real history (Overland sent them from a later version on).
/// </summary>
public readonly record struct Fix(
    DateTime TimeUtc,
    double Latitude,
    double Longitude,
    double? Speed,
    double Altitude,
    double? Accuracy,
    string[]? Motion);

/// <summary>What to simulate. <see cref="To"/> is the last local day (inclusive); <see cref="MovingInterval"/> is the time between two fixes while moving.</summary>
public sealed record SimulatorOptions(DateOnly From, DateOnly To, TimeSpan MovingInterval, int Seed)
{
    /// <summary>Accuracy and motion are recorded for this long before the end of the history.</summary>
    public static readonly TimeSpan AccuracyWindow = TimeSpan.FromDays(90);

    public void Validate()
    {
        if (To < From)
            throw new ArgumentException("--to must not be before --from.");
        if (MovingInterval < TimeSpan.FromMilliseconds(100) || MovingInterval > TimeSpan.FromMinutes(1))
            throw new ArgumentException("--moving-interval must be between 100ms and 1m.");
    }
}
