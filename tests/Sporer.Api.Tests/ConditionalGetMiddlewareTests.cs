using System.Buffers;
using System.Security.Cryptography;
using System.Buffers.Text;
using System.Text;
using Microsoft.AspNetCore.Http;
using Sporer.Api.Http;

namespace Sporer.Api.Tests;

/// <summary>
/// <see cref="ConditionalGetMiddleware"/> on its own, without a server or a database: what it tags and holds back, and what it
/// leaves exactly as the endpoint wrote it.
/// </summary>
public class ConditionalGetMiddlewareTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed record Run(DefaultHttpContext Context, MemoryStream Wire, Stream OriginalBody)
    {
        public HttpResponse Response => Context.Response;
        public byte[] Sent => Wire.ToArray();
        public string SentText => Encoding.UTF8.GetString(Wire.ToArray());
    }

    /// <summary>Runs the middleware around <paramref name="endpoint"/>; <c>Wire</c> is what reached the next layer out (the client, or compression).</summary>
    private static async Task<Run> RunAsync(
        Func<HttpContext, MemoryStream, Task> endpoint, string method = "GET", string path = "/api/thing", string? ifNoneMatch = null)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;
        if (ifNoneMatch is not null)
            context.Request.Headers.IfNoneMatch = ifNoneMatch;
        var wire = new MemoryStream();
        context.Response.Body = wire;
        var original = context.Response.Body;

        await new ConditionalGetMiddleware(c => endpoint(c, wire)).InvokeAsync(context);

        return new Run(context, wire, original);
    }

    private static string TagOf(byte[] body) => $"\"{Base64Url.EncodeToString(SHA256.HashData(body))[..22]}\"";

    private static Func<HttpContext, MemoryStream, Task> WriteJson(string json, int status = 200, string contentType = "application/json; charset=utf-8")
        => async (c, _) =>
        {
            c.Response.StatusCode = status;
            c.Response.ContentType = contentType;
            await c.Response.Body.WriteAsync(Encoding.UTF8.GetBytes(json), Ct);
        };

    [Fact]
    public async Task A_json_ok_is_tagged_over_the_exact_body_it_sends()
    {
        var run = await RunAsync(async (c, _) =>
        {
            c.Response.ContentType = "application/json; charset=utf-8";
            await c.Response.Body.WriteAsync(Encoding.UTF8.GetBytes("""{"a":"""), Ct); // in pieces, as a serializer writes
            await c.Response.Body.WriteAsync(Encoding.UTF8.GetBytes("""[1,2,3]}"""), Ct);
        });

        var body = """{"a":[1,2,3]}"""u8.ToArray();
        Assert.Equal(200, run.Response.StatusCode);
        Assert.Equal(body, run.Sent);
        Assert.Equal(TagOf(body), run.Response.Headers.ETag.ToString());
        Assert.Equal("no-cache", run.Response.Headers.CacheControl.ToString());
        Assert.Equal(body.Length, run.Response.ContentLength);
        Assert.Same(run.OriginalBody, run.Response.Body); // the body the next layer gave is back in place
    }

    [Fact]
    public async Task The_body_is_held_back_until_the_endpoint_is_done()
    {
        long sentMeanwhile = -1;
        await RunAsync(async (c, wire) =>
        {
            c.Response.ContentType = "application/json";
            await c.Response.Body.WriteAsync("""{"a":1}"""u8.ToArray(), Ct);
            await c.Response.Body.FlushAsync(Ct);
            sentMeanwhile = wire.Length;
        });

        Assert.Equal(0, sentMeanwhile); // it cannot be tagged before its end is known
    }

    [Fact]
    public async Task A_large_body_is_tagged_and_sent_whole()
    {
        var chunk = new byte[64 * 1024];
        var random = new Random(7);
        var written = new MemoryStream();
        var run = await RunAsync(async (c, _) =>
        {
            c.Response.ContentType = "application/json";
            for (var i = 0; i < 48; i++) // 3 MiB
            {
                random.NextBytes(chunk);
                written.Write(chunk);
                await c.Response.Body.WriteAsync(chunk, Ct);
            }
        });

        Assert.Equal(written.ToArray(), run.Sent);
        Assert.Equal(TagOf(written.ToArray()), run.Response.Headers.ETag.ToString());
        Assert.Equal(written.Length, run.Response.ContentLength);
    }

    [Fact]
    public async Task A_body_written_through_the_pipe_writer_is_tagged_too()
    {
        var run = await RunAsync((c, _) => c.Response.WriteAsJsonAsync(new { items = new[] { 1, 2, 3 } }, Ct));

        Assert.Equal("""{"items":[1,2,3]}""", run.SentText);
        Assert.Equal(TagOf(run.Sent), run.Response.Headers.ETag.ToString());
    }

    [Fact]
    public async Task Bytes_left_in_the_pipe_writer_without_a_flush_still_arrive_and_count()
    {
        var run = await RunAsync((c, _) =>
        {
            c.Response.ContentType = "application/json";
            c.Response.BodyWriter.Write("""{"a":1}"""u8); // never flushed
            return Task.CompletedTask;
        });

        Assert.Equal("""{"a":1}""", run.SentText);
        Assert.Equal(TagOf(run.Sent), run.Response.Headers.ETag.ToString());
    }

    [Theory]
    [InlineData("application/json")]
    [InlineData("application/json; charset=utf-8")]
    [InlineData("APPLICATION/JSON")]
    [InlineData("application/vnd.sporer+json")]
    public async Task Json_content_types_are_tagged(string contentType)
    {
        var run = await RunAsync(WriteJson("""{"a":1}""", contentType: contentType));

        Assert.False(string.IsNullOrEmpty(run.Response.Headers.ETag.ToString()));
    }

    [Fact]
    public async Task A_matching_if_none_match_sends_304_with_no_body_and_keeps_the_validator()
    {
        var body = """{"a":1}"""u8.ToArray();

        var run = await RunAsync(WriteJson("""{"a":1}"""), ifNoneMatch: TagOf(body));

        Assert.Equal(304, run.Response.StatusCode);
        Assert.Empty(run.Sent);
        Assert.Equal(TagOf(body), run.Response.Headers.ETag.ToString());
        Assert.Equal("no-cache", run.Response.Headers.CacheControl.ToString());
        Assert.Null(run.Response.ContentType);
        Assert.Null(run.Response.ContentLength);
    }

    [Theory]
    [InlineData("W/\"{tag}\"")]
    [InlineData("*")]
    [InlineData("\"other\", \"{tag}\", \"another\"")]
    public async Task Any_listed_tag_may_match_and_matching_is_weak(string header)
    {
        var tag = TagOf("""{"a":1}"""u8.ToArray()).Trim('"');

        var run = await RunAsync(WriteJson("""{"a":1}"""), ifNoneMatch: header.Replace("{tag}", tag));

        Assert.Equal(304, run.Response.StatusCode);
        Assert.Empty(run.Sent);
    }

    [Theory]
    [InlineData("\"other\"")]
    [InlineData("garbage")]
    [InlineData("")]
    public async Task A_tag_that_does_not_match_gets_the_body(string header)
    {
        var run = await RunAsync(WriteJson("""{"a":1}"""), ifNoneMatch: header);

        Assert.Equal(200, run.Response.StatusCode);
        Assert.Equal("""{"a":1}""", run.SentText);
    }

    [Theory]
    [InlineData(201)]
    [InlineData(204)]
    [InlineData(400)]
    [InlineData(404)]
    [InlineData(500)]
    public async Task Responses_that_are_not_200_are_untouched_and_not_held_back(int status)
    {
        long sentMeanwhile = -1;
        var run = await RunAsync(async (c, wire) =>
        {
            c.Response.StatusCode = status;
            c.Response.ContentType = "application/json";
            await c.Response.Body.WriteAsync("""{"error":"x"}"""u8.ToArray(), Ct);
            sentMeanwhile = wire.Length;
        }, ifNoneMatch: "*");

        Assert.Equal(status, run.Response.StatusCode); // not even the wildcard makes a 304 of it
        Assert.Equal("""{"error":"x"}""", run.SentText);
        Assert.Equal(13, sentMeanwhile); // streamed as written
        Assert.False(run.Response.Headers.ContainsKey("ETag"));
        Assert.False(run.Response.Headers.ContainsKey("Cache-Control"));
    }

    [Theory]
    [InlineData("text/plain")]
    [InlineData("text/html")]
    [InlineData("application/octet-stream")]
    [InlineData("text/event-stream")]
    [InlineData("application/jsonx")]
    public async Task A_200_that_is_not_json_is_untouched_and_streams(string contentType)
    {
        var meanwhile = new List<long>();
        var run = await RunAsync(async (c, wire) =>
        {
            c.Response.ContentType = contentType;
            await c.Response.Body.WriteAsync("data: one\n\n"u8.ToArray(), Ct);
            await c.Response.Body.FlushAsync(Ct);
            meanwhile.Add(wire.Length);
            await c.Response.Body.WriteAsync("data: two\n\n"u8.ToArray(), Ct);
            await c.Response.Body.FlushAsync(Ct);
            meanwhile.Add(wire.Length);
        }, ifNoneMatch: "*");

        Assert.Equal(new long[] { 11, 22 }, meanwhile); // each event is out as soon as it is written
        Assert.Equal("data: one\n\ndata: two\n\n", run.SentText);
        Assert.Equal(200, run.Response.StatusCode);
        Assert.False(run.Response.Headers.ContainsKey("ETag"));
        Assert.False(run.Response.Headers.ContainsKey("Cache-Control"));
    }

    [Theory]
    [InlineData("POST", "/api/overland")]
    [InlineData("PUT", "/api/thing")]
    [InlineData("DELETE", "/api/thing")]
    [InlineData("HEAD", "/api/thing")]
    [InlineData("GET", "/")]
    [InlineData("GET", "/day/2026-10-22")]
    [InlineData("GET", "/apiary")]
    [InlineData("GET", "/swagger/v1/swagger.json")]
    public async Task Other_requests_pass_through_untouched(string method, string path)
    {
        long sentMeanwhile = -1;
        var run = await RunAsync(async (c, wire) =>
        {
            c.Response.ContentType = "application/json";
            await c.Response.Body.WriteAsync("""{"result":"ok"}"""u8.ToArray(), Ct);
            sentMeanwhile = wire.Length;
        }, method, path, ifNoneMatch: "*");

        Assert.Equal(200, run.Response.StatusCode);
        Assert.Equal("""{"result":"ok"}""", run.SentText);
        Assert.Equal(15, sentMeanwhile); // not buffered
        Assert.False(run.Response.Headers.ContainsKey("ETag"));
        Assert.False(run.Response.Headers.ContainsKey("Cache-Control"));
        Assert.Same(run.OriginalBody, run.Response.Body);
    }

    [Theory]
    [InlineData("/api")]
    [InlineData("/api/")]
    [InlineData("/api/day/2026-10-22")]
    [InlineData("/API/status")]
    public async Task Everything_under_api_is_covered(string path)
    {
        var run = await RunAsync(WriteJson("""{"a":1}"""), path: path);

        Assert.True(run.Response.Headers.ContainsKey("ETag"));
    }

    [Fact]
    public async Task A_failing_endpoint_leaves_nothing_behind_for_the_exception_handler()
    {
        var context = new DefaultHttpContext();
        context.Request.Method = "GET";
        context.Request.Path = "/api/thing";
        var wire = new MemoryStream();
        context.Response.Body = wire;
        var original = context.Response.Body;
        var middleware = new ConditionalGetMiddleware(async c =>
        {
            c.Response.ContentType = "application/json";
            await c.Response.Body.WriteAsync("""{"partial":"""u8.ToArray(), Ct);
            throw new InvalidOperationException("boom");
        });

        await Assert.ThrowsAsync<InvalidOperationException>(() => middleware.InvokeAsync(context));

        Assert.Empty(wire.ToArray()); // the half-written body is dropped, so the handler's answer stands alone
        Assert.Same(original, context.Response.Body);
        Assert.False(context.Response.Headers.ContainsKey("ETag"));
    }

    [Fact]
    public async Task A_status_changed_after_the_body_was_written_is_respected()
    {
        var run = await RunAsync(async (c, _) =>
        {
            c.Response.ContentType = "application/json";
            await c.Response.Body.WriteAsync("""{"created":true}"""u8.ToArray(), Ct);
            c.Response.StatusCode = 201;
        }, ifNoneMatch: "*");

        Assert.Equal(201, run.Response.StatusCode);
        Assert.Equal("""{"created":true}""", run.SentText);
        Assert.False(run.Response.Headers.ContainsKey("ETag"));
    }

    [Fact]
    public async Task An_ok_without_a_body_is_left_as_it_is()
    {
        var run = await RunAsync((c, _) =>
        {
            c.Response.ContentType = "application/json";
            return Task.CompletedTask;
        });

        Assert.Equal(200, run.Response.StatusCode);
        Assert.Empty(run.Sent);
        Assert.False(run.Response.Headers.ContainsKey("ETag"));
    }
}
