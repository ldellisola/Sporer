using System.Globalization;

namespace Sporer.Api.Features.Range;

/// <summary>
/// The local calendar days from <see cref="From"/> to <see cref="To"/>, both included, as a client asks for them (the range
/// and heat APIs): plain dates, with no zone, as the segments' own local dates are.
/// </summary>
public readonly record struct DateRange(DateOnly From, DateOnly To)
{
    /// <summary>The most days one request may cover, counting both ends.</summary>
    public const int MaxDays = 400;

    /// <summary>The number of days, counting both ends: one for a range of a single date.</summary>
    public int Days => To.DayNumber - From.DayNumber + 1;

    /// <summary>
    /// Reads <paramref name="from"/> and <paramref name="to"/> as dates written exactly <c>yyyy-MM-dd</c> (no other shape, no
    /// spaces, no time) that make a range: <paramref name="from"/> is not after <paramref name="to"/>, and at most
    /// <see cref="MaxDays"/> days lie between them, both ends counted. On failure <paramref name="range"/> is the default
    /// value and <paramref name="error"/> says what is wrong, for the client.
    /// </summary>
    public static bool TryParse(string? from, string? to, out DateRange range, out string? error)
    {
        range = default;
        if (!TryParseDate(from, nameof(from), out var start, out error) || !TryParseDate(to, nameof(to), out var end, out error))
            return false;

        if (end < start)
        {
            error = "from must not be after to.";
            return false;
        }

        var parsed = new DateRange(start, end);
        if (parsed.Days > MaxDays)
        {
            error = $"A range covers at most {MaxDays} days; this one covers {parsed.Days}.";
            return false;
        }

        range = parsed;
        error = null;
        return true;
    }

    private static bool TryParseDate(string? text, string name, out DateOnly date, out string? error)
    {
        if (DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date))
        {
            error = null;
            return true;
        }

        error = text is null
            ? $"{name} is required: a calendar date written yyyy-MM-dd."
            : $"{name} must be a calendar date written yyyy-MM-dd.";
        return false;
    }
}
