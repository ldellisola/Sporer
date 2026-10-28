using System.Globalization;

namespace Sporer.Api.Features.Places;

/// <summary>The id of a place in a route, as every endpoint under <c>/api/places</c> reads it.</summary>
internal static class PlaceId
{
    /// <summary>What an endpoint tells a client whose id is not one (a 400, with this as the failure of <c>id</c>).</summary>
    public const string InvalidMessage = "The id must be a positive whole number.";

    /// <summary>
    /// Whether <paramref name="text"/> is a place id: digits only, with no sign, no space and no exponent, positive, and not too big
    /// for a long.
    /// </summary>
    public static bool TryParse(string? text, out long id)
        => long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out id) && id > 0;
}
