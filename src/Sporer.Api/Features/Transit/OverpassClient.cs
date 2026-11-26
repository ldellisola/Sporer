using System.Globalization;
using System.Net;
using System.Text.Json;
using Sporer.Api.Configuration;
using Sporer.Timeline;

namespace Sporer.Api.Features.Transit;

/// <summary>
/// Overpass could not be used just now: it refused the request (406, 429), failed (5xx), did not answer in time, could not be reached, or
/// answered with something that is not a usable result. Worth trying again later. <see cref="StatusCode"/> is the status it answered with,
/// when it answered.
/// </summary>
public sealed class OverpassUnavailableException(string message, HttpStatusCode? statusCode = null, Exception? inner = null)
    : Exception(message, inner)
{
    public HttpStatusCode? StatusCode { get; } = statusCode;
}

/// <summary>
/// Fetches the railway or bus-route lines of one tile from the Overpass API (transit spec section 3), with the exact queries of the spec, sent
/// as a form (<c>data=</c>) in a <c>POST</c>, as Overpass prefers. It keeps only the geometry of what comes back. It does no rate limiting,
/// no retrying and no caching: that is <see cref="TransitFetcher"/>'s job. The <see cref="HttpClient"/> carries the configured
/// <c>User-Agent</c>, a timeout and a limit on the size of an answer.
/// </summary>
public sealed class OverpassClient(HttpClient http, TransitOptions options)
{
    /// <summary>
    /// The lines of <paramref name="tile"/>, each in the order of its way (none, for a tile that has none). A way that leaves the tile and
    /// comes back is cut where Overpass leaves its points out, so it can come back as several lines. Throws
    /// <see cref="OverpassUnavailableException"/> on every non-success status, on network failures and timeouts, and on an answer that is
    /// not a JSON result (Overpass also reports a query that ran out of time or memory in a 200, as a <c>remark</c>); an
    /// <see cref="OperationCanceledException"/> only when <paramref name="ct"/> is cancelled.
    /// </summary>
    public async Task<IReadOnlyList<IReadOnlyList<GeoPoint>>> FetchAsync(TransitTile tile, CancellationToken ct)
    {
        byte[] body;
        try
        {
            using var content = new FormUrlEncodedContent([new KeyValuePair<string, string>("data", Query(tile))]);
            using var response = await http.PostAsync(options.OverpassUrl, content, ct);
            if (!response.IsSuccessStatusCode)
                throw new OverpassUnavailableException($"Overpass answered {(int)response.StatusCode} {response.ReasonPhrase}", response.StatusCode);

            body = await response.Content.ReadAsByteArrayAsync(ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException)
        {
            // An answer larger than the client's buffer limit is one of these too.
            throw new OverpassUnavailableException($"Overpass could not be reached: {ex.Message}", inner: ex);
        }
        catch (OperationCanceledException ex) when (!ct.IsCancellationRequested)
        {
            throw new OverpassUnavailableException("Overpass did not answer in time", inner: ex); // the HttpClient timeout
        }

        return Parse(body);
    }

    /// <summary>
    /// The query for <paramref name="tile"/>, as the transit spec writes it, with the tile's edges (south, west, north, east) in degrees with
    /// one decimal.
    /// </summary>
    public static string Query(TransitTile tile)
    {
        var box = string.Join(',', Tenth(tile.LatIndex), Tenth(tile.LonIndex), Tenth(tile.LatIndex + 1), Tenth(tile.LonIndex + 1));
        return tile.Kind switch
        {
            TransitKind.Rail =>
                $"""
                 [out:json][timeout:90];
                 way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge|monorail|funicular)$"]
                    ["service"!~"^(yard|siding|spur|crossover)$"]["usage"!~"^(industrial|military|test)$"]({box});
                 out tags geom({box}) qt;
                 """,
            TransitKind.Bus =>
                $"""
                 [out:json][timeout:90];
                 rel["route"~"^(bus|trolleybus|coach)$"]({box});
                 way(r)({box});
                 out skel geom({box}) qt;
                 """,
            _ => throw new ArgumentOutOfRangeException(nameof(tile), tile, "Unknown kind of tile."),
        };
    }

    /// <summary>
    /// The lines in an Overpass JSON answer: one per element with a <c>geometry</c>, its points in order. A point Overpass leaves out (it
    /// writes <c>null</c> for one outside the box) or that is not a position ends the line, and the points after it start another. Throws
    /// <see cref="OverpassUnavailableException"/> when <paramref name="json"/> is not a JSON object with an <c>elements</c> list, or when its
    /// <c>remark</c> says the query failed on the server.
    /// </summary>
    public static IReadOnlyList<IReadOnlyList<GeoPoint>> Parse(ReadOnlyMemory<byte> json)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json);
        }
        catch (JsonException ex)
        {
            throw new OverpassUnavailableException("Overpass did not answer with JSON", inner: ex);
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new OverpassUnavailableException($"Overpass answered with a JSON {root.ValueKind}, not an object");

            // A query that runs out of time or memory still answers 200, with what it had and a remark that says so: that is no tile.
            if (root.TryGetProperty("remark", out var remark) && remark.ValueKind == JsonValueKind.String
                && remark.GetString() is { } text && text.Contains("error", StringComparison.OrdinalIgnoreCase))
                throw new OverpassUnavailableException($"Overpass could not run the query: {text}");

            if (!root.TryGetProperty("elements", out var elements) || elements.ValueKind != JsonValueKind.Array)
                throw new OverpassUnavailableException("Overpass answered without a list of elements");

            var lines = new List<IReadOnlyList<GeoPoint>>();
            foreach (var element in elements.EnumerateArray())
            {
                if (element.ValueKind != JsonValueKind.Object
                    || !element.TryGetProperty("geometry", out var geometry) || geometry.ValueKind != JsonValueKind.Array)
                    continue;

                var line = new List<GeoPoint>();
                foreach (var vertex in geometry.EnumerateArray())
                {
                    if (Position(vertex) is { } point)
                    {
                        line.Add(point);
                        continue;
                    }
                    if (line.Count > 0)
                        lines.Add(line);
                    line = [];
                }
                if (line.Count > 0)
                    lines.Add(line);
            }
            return lines;
        }
    }

    /// <summary><c>{"lat": .., "lon": ..}</c> with both numbers on the globe, else null.</summary>
    private static GeoPoint? Position(JsonElement vertex)
    {
        if (vertex.ValueKind != JsonValueKind.Object
            || !vertex.TryGetProperty("lat", out var lat) || lat.ValueKind != JsonValueKind.Number || !lat.TryGetDouble(out var latitude)
            || !vertex.TryGetProperty("lon", out var lon) || lon.ValueKind != JsonValueKind.Number || !lon.TryGetDouble(out var longitude))
            return null;

        return double.IsFinite(latitude) && double.IsFinite(longitude) && latitude is >= -90 and <= 90 && longitude is >= -180 and <= 180
            ? new GeoPoint(latitude, longitude)
            : null;
    }

    /// <summary>A tile edge in tenths of a degree, written exactly with one decimal (<c>-0.1</c>, <c>59.9</c>, <c>60.0</c>).</summary>
    private static string Tenth(int tenths)
    {
        var sign = tenths < 0 ? "-" : "";
        var magnitude = Math.Abs(tenths);
        return string.Create(CultureInfo.InvariantCulture, $"{sign}{magnitude / 10}.{magnitude % 10}");
    }
}
