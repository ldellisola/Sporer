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

/// <summary>
/// What a simulated life holds that a test can look for: each trip's name, the local date it starts on (the morning the
/// person leaves for the airport) and how many nights it lasts at the destination, and the local date planned for the house
/// move.
/// </summary>
/// <remarks>
/// The plan is made before anything is lived, so it cannot say what a trip does to the days around it. A trip that includes
/// the day planned for the move takes it over: the person is away, and the run never moves house. The trips are placed at
/// 22 %, 40 % and 72 % of the history and the move at 57 %, so this cannot happen while all three trips fit (which takes more
/// than three months); in a history of a few weeks, with fewer trips, it can, and then the move day of the plan is not lived.
/// </remarks>
public sealed record SimulatorPlan(IReadOnlyList<(string Name, DateOnly Start, int Nights)> Trips, DateOnly MoveDay);
