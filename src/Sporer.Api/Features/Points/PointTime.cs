namespace Sporer.Api.Features.Points;

/// <summary>
/// The time of a point as it travels: whole microseconds since the Unix epoch, which is <c>timestamptz</c>'s precision, so it is the stored
/// time exactly, and a whole number that a JavaScript number holds exactly (it stays below 2^53 until the year 2255). A point is told from
/// another by its device and this time; a time in milliseconds, or one rounded by the client, would miss the stored row.
/// </summary>
internal static class PointTime
{
    private const long TicksPerMicrosecond = 10;

    /// <summary><see cref="DateTime.MinValue"/> in microseconds: Npgsql writes it as -infinity, so no point has it and a time must be after it.</summary>
    private static readonly long MinMicros = (DateTime.MinValue.Ticks - DateTime.UnixEpoch.Ticks) / TicksPerMicrosecond;

    private static readonly long MaxMicros = (DateTime.MaxValue.Ticks - DateTime.UnixEpoch.Ticks) / TicksPerMicrosecond;

    /// <summary>The time, UTC, as microseconds since the epoch. Exact for a time of a stored point, which has no more than microseconds.</summary>
    public static long ToMicros(DateTime utc) => (utc.Ticks - DateTime.UnixEpoch.Ticks) / TicksPerMicrosecond;

    /// <summary>The UTC time <paramref name="micros"/> after the epoch, unless that is not a time a point can have.</summary>
    public static bool TryFromMicros(long micros, out DateTime utc)
    {
        if (micros <= MinMicros || micros > MaxMicros)
        {
            utc = default;
            return false;
        }

        utc = DateTime.UnixEpoch.AddTicks(micros * TicksPerMicrosecond);
        return true;
    }
}
