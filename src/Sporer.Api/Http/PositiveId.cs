using System.Globalization;

namespace Sporer.Api.Http;

/// <summary>
/// An id in a route that is a positive whole number (<c>/api/places/{id}</c>, <c>/api/homes/{id}</c>), as every endpoint that takes one reads
/// it. A place and a home period are numbered alike, so they are read alike.
/// </summary>
internal static class PositiveId
{
    /// <summary>What an endpoint tells a client whose id is not one (a 400, with this as the failure of the id's name).</summary>
    public const string InvalidMessage = "The id must be a positive whole number.";

    /// <summary>
    /// Whether <paramref name="text"/> is an id: digits only, with no sign, no space and no exponent, positive, and not too big for a long.
    /// </summary>
    public static bool TryParse(string? text, out long id)
        => long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out id) && id > 0;
}
