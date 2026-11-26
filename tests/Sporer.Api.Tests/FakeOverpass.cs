using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>What <see cref="FakeOverpass"/> was asked: the URL, the method, the <c>User-Agent</c>, the content type and the query sent as <c>data</c>.</summary>
public sealed record OverpassRequest(Uri Uri, string Method, string UserAgent, string? ContentType, string? Query);

/// <summary>
/// Stands in for the Overpass API, so that no test asks the real one: records every request and answers from a queue (500 when it is empty).
/// <see cref="Json"/> writes an answer in Overpass's shape for the lines a test draws.
/// </summary>
public sealed class FakeOverpass : HttpMessageHandler
{
    private readonly ConcurrentQueue<Func<HttpResponseMessage>> _replies = new();
    private readonly ConcurrentQueue<OverpassRequest> _seen = new();

    public int Calls => _seen.Count;

    public IReadOnlyList<OverpassRequest> Requests => [.. _seen];

    public void Reply(HttpStatusCode status, string body = "")
        => _replies.Enqueue(() => new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") });

    public void ReplyJson(string body) => Reply(HttpStatusCode.OK, body);

    /// <summary>Answers with <paramref name="lines"/>, one way each (none: a tile with no line).</summary>
    public void ReplyLines(params IReadOnlyList<GeoPoint>[] lines) => ReplyJson(Json(lines));

    public void Throw(Exception error) => _replies.Enqueue(() => throw error);

    /// <summary>
    /// An Overpass JSON answer with one way per line, its points as <c>geometry</c>, as <c>out geom</c> writes them. A null point is written
    /// as <c>null</c>, as Overpass writes a point of a way that lies outside the box.
    /// </summary>
    public static string Json(IEnumerable<IReadOnlyList<GeoPoint>?> lines)
    {
        var elements = lines.Select((line, k) => new Dictionary<string, object?>
        {
            ["type"] = "way",
            ["id"] = 1000 + k,
            ["geometry"] = line?.Select(p => (object?)new Dictionary<string, double> { ["lat"] = p.Latitude, ["lon"] = p.Longitude }).ToArray(),
        });
        return JsonSerializer.Serialize(new Dictionary<string, object?>
        {
            ["version"] = 0.6,
            ["generator"] = "Overpass API (fake)",
            ["osm3s"] = new Dictionary<string, string> { ["timestamp_osm_base"] = "2026-11-26T00:00:00Z" },
            ["elements"] = elements.ToArray(),
        });
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        string? query = null;
        if (request.Content is { } content)
        {
            var form = await content.ReadAsStringAsync(cancellationToken);
            query = form.Split('&')
                .Select(pair => pair.Split('=', 2))
                .Where(pair => pair.Length == 2 && pair[0] == "data")
                .Select(pair => WebUtility.UrlDecode(pair[1]))
                .FirstOrDefault();
        }

        _seen.Enqueue(new OverpassRequest(
            request.RequestUri!, request.Method.Method, request.Headers.UserAgent.ToString(),
            request.Content?.Headers.ContentType?.MediaType, query));
        return _replies.TryDequeue(out var reply)
            ? reply()
            : new HttpResponseMessage(HttpStatusCode.InternalServerError) { Content = new StringContent("no reply was queued") };
    }
}
