using System.Globalization;

namespace Sporer.Api.Features.Day;

/// <summary>The date of a local day in a route (<c>/api/day/{date}</c>, <c>/api/day/{date}/points</c>), as every endpoint under <c>/api/day</c> reads and writes it.</summary>
internal static class DayDate
{
    private const string Format = "yyyy-MM-dd";

    /// <summary>What an endpoint tells a client whose date is not one (a 400, with this as the failure of <c>date</c>).</summary>
    public const string InvalidMessage = "The date must be a calendar date written yyyy-MM-dd.";

    /// <summary>Whether <paramref name="text"/> is a calendar date written <c>yyyy-MM-dd</c>, exactly.</summary>
    public static bool TryParse(string? text, out DateOnly date)
        => DateOnly.TryParseExact(text, Format, CultureInfo.InvariantCulture, DateTimeStyles.None, out date);

    public static string ToText(DateOnly date) => date.ToString(Format, CultureInfo.InvariantCulture);
}
