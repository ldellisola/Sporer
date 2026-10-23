using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using Sporer.Api.Configuration;
using Sporer.Timeline;

namespace Sporer.Api.Features.Places;

/// <summary>What Nominatim knows about a spot. <paramref name="RawJson"/> is the response as received, for the cache.</summary>
public sealed record NominatimResult(string? Name, string? Address, string? City, string? Country, string RawJson);

/// <summary>
/// Nominatim could not be used just now: it is rate limiting us, down or unreachable, or it answered with something
/// that is not what it should be. Worth trying again later.
/// </summary>
public sealed class NominatimUnavailableException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// Reverse geocoding through Nominatim (<c>/reverse</c>), in English. It does no rate limiting and no caching: that is
/// <see cref="PlaceNamer"/>'s job. The <see cref="HttpClient"/> carries the configured <c>User-Agent</c> and a timeout.
/// </summary>
public sealed class NominatimClient(HttpClient http, NominatimOptions options)
{
    /// <summary>
    /// What Nominatim knows about <paramref name="point"/>, or <c>null</c> when it knows nothing (404, or an answer
    /// without a result). Throws <see cref="NominatimUnavailableException"/> on 429, 5xx and any other refusal, on
    /// network failures and timeouts, and on an answer that is not a JSON object; an <see cref="OperationCanceledException"/>
    /// only when <paramref name="ct"/> is cancelled.
    /// </summary>
    public async Task<NominatimResult?> ReverseAsync(GeoPoint point, CancellationToken ct)
    {
        var url = string.Create(CultureInfo.InvariantCulture,
            $"{options.BaseUrl.TrimEnd('/')}/reverse?format=jsonv2&lat={Format(point.Latitude)}&lon={Format(point.Longitude)}&zoom=18&addressdetails=1&accept-language=en");

        string body;
        try
        {
            using var response = await http.GetAsync(url, ct);
            if (response.StatusCode == HttpStatusCode.NotFound)
                return null;
            if (!response.IsSuccessStatusCode)
                throw new NominatimUnavailableException($"Nominatim answered {(int)response.StatusCode} {response.ReasonPhrase}");

            // Bytes, not ReadAsStringAsync: the answer is UTF-8 whatever charset the response claims.
            body = Encoding.UTF8.GetString(await response.Content.ReadAsByteArrayAsync(ct));
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException)
        {
            throw new NominatimUnavailableException($"Nominatim could not be reached: {ex.Message}", ex);
        }
        catch (OperationCanceledException ex) when (!ct.IsCancellationRequested)
        {
            throw new NominatimUnavailableException("Nominatim did not answer in time", ex); // the HttpClient timeout
        }

        return Parse(body);
    }

    /// <summary>
    /// Reads a <c>jsonv2</c> answer. <c>null</c> when there is no result (empty, <c>null</c>, or <c>{"error": ...}</c>).
    /// Missing, null, empty and non-string values are all just "not there". Throws <see cref="NominatimUnavailableException"/>
    /// when <paramref name="json"/> is not a JSON object.
    /// </summary>
    public static NominatimResult? Parse(string json)
    {
        if (string.IsNullOrWhiteSpace(json))
            return null;

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json);
        }
        catch (JsonException ex)
        {
            throw new NominatimUnavailableException("Nominatim did not answer with JSON", ex);
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Null)
                return null;
            if (root.ValueKind != JsonValueKind.Object)
                throw new NominatimUnavailableException($"Nominatim answered with a JSON {root.ValueKind}, not an object");
            if (root.TryGetProperty("error", out _))
                return null; // "Unable to geocode": nothing at this spot

            root.TryGetProperty("address", out var address);
            var road = Text(address, "road");
            var houseNumber = Text(address, "house_number");
            var city = Text(address, "city") ?? Text(address, "town") ?? Text(address, "village") ?? Text(address, "municipality");

            var street = road is null ? null : Join(" ", road, houseNumber); // a house number alone is no name
            var name = Text(root, "name") ?? street ?? Text(address, "suburb");
            return new NominatimResult(name, Join(", ", Join(" ", road, houseNumber), city), city, Text(address, "country"), json);
        }
    }

    /// <summary>Digits for about a centimetre, always with a point, never in exponent form.</summary>
    private static string Format(double degrees) => degrees.ToString("0.#######", CultureInfo.InvariantCulture);

    /// <summary>The string property <paramref name="name"/> of <paramref name="element"/>, trimmed; <c>null</c> when it is missing, empty or not a string.</summary>
    private static string? Text(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            return null;

        // A NUL cannot be stored in the database's text columns.
        var text = value.GetString()?.Replace("\0", "").Trim();
        return string.IsNullOrEmpty(text) ? null : text;
    }

    /// <summary>The parts that are there, joined; <c>null</c> when none is.</summary>
    private static string? Join(string separator, params string?[] parts)
    {
        var present = parts.Where(p => !string.IsNullOrEmpty(p)).ToArray();
        return present.Length == 0 ? null : string.Join(separator, present);
    }
}
