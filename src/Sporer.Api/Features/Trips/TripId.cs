using System.Globalization;

namespace Sporer.Api.Features.Trips;

/// <summary>The id of a trip in a route, as every endpoint under <c>/api/trips</c> reads it: the date of its first night.</summary>
internal static class TripId
{
    /// <summary>
    /// Whether <paramref name="text"/> is a trip id: exactly <c>yyyy-MM-dd</c>, as the ids are written. No other form of a date names a
    /// trip, so what is not one is no trip, and the endpoints answer it as they answer a date no trip began on (404).
    /// </summary>
    public static bool TryParse(string? text, out DateOnly id)
        => DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out id);
}
