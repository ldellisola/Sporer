using System.Globalization;

namespace Sporer.Api.Features.Homes;

/// <summary>The id of a home period in a route, as <c>DELETE /api/homes/{id}</c> reads it.</summary>
internal static class HomeId
{
    /// <summary>What an endpoint tells a client whose id is not one (a 400, with this as the failure of <c>id</c>).</summary>
    public const string InvalidMessage = "The id must be a positive whole number.";

    /// <summary>Whether <paramref name="text"/> is a home period id: digits only, positive, and not too big for a long.</summary>
    public static bool TryParse(string? text, out long id)
        => long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out id) && id > 0;
}
