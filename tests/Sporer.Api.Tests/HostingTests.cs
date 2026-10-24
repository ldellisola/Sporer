using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Npgsql;

namespace Sporer.Api.Tests;

/// <summary>
/// How the API is hosted: the single-page app it serves from its web root, the headers behind the reverse proxy,
/// compression, conditional GET and the map configuration. Every test that needs static files serves them from a
/// temporary directory (see <see cref="TempWebRoot"/>): the project's own wwwroot belongs to the web build.
/// </summary>
[Collection("db")]
public class HostingTests(DatabaseFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static StringContent Json(string body) => new(body, Encoding.UTF8, "application/json");

    private static async Task<HttpResponseMessage> GetAsync(
        HttpClient client, string url, string? acceptEncoding = null, string? ifNoneMatch = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        if (acceptEncoding is not null)
            request.Headers.TryAddWithoutValidation("Accept-Encoding", acceptEncoding);
        if (ifNoneMatch is not null)
            request.Headers.TryAddWithoutValidation("If-None-Match", ifNoneMatch);
        return await client.SendAsync(request, Ct);
    }

    private static async Task<string> DecompressAsync(HttpResponseMessage response, Func<Stream, Stream> decompressor)
    {
        await using var compressed = new MemoryStream(await response.Content.ReadAsByteArrayAsync(Ct));
        await using var plain = decompressor(compressed);
        using var reader = new StreamReader(plain, Encoding.UTF8);
        return await reader.ReadToEndAsync(Ct);
    }

    /// <summary>A directory with the files a web build leaves behind: <c>index.html</c> and, under <c>assets</c>, hashed ones.</summary>
    private sealed class TempWebRoot : IDisposable
    {
        public const string IndexHtml = "<!doctype html><html><head><title>Sporer</title></head><body><div id=\"root\"></div></body></html>";
        public const string HashedScript = "export const answer = 42; // a hashed bundle, long enough to be worth compressing. ";
        public const string HashedScriptPath = "/assets/index-0a1b2c3d.js";

        public string Path { get; } = Directory.CreateTempSubdirectory("sporer-webroot-").FullName;

        public TempWebRoot()
        {
            Directory.CreateDirectory(System.IO.Path.Combine(Path, "assets"));
            Directory.CreateDirectory(System.IO.Path.Combine(Path, "api"));
            File.WriteAllText(System.IO.Path.Combine(Path, "index.html"), IndexHtml);
            File.WriteAllText(System.IO.Path.Combine(Path, "assets", "index-0a1b2c3d.js"), string.Concat(Enumerable.Repeat(HashedScript, 40)));
            File.WriteAllText(System.IO.Path.Combine(Path, "assets", "index-4e5f6a7b.css"), string.Concat(Enumerable.Repeat("body { margin: 0; } ", 40)));
            File.WriteAllText(System.IO.Path.Combine(Path, "favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/></svg>");
            // A file where only the API has a say: it must never be served.
            File.WriteAllText(System.IO.Path.Combine(Path, "api", "stray.json"), "{\"stray\":true}");
        }

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    // --- the single-page app -------------------------------------------------------------------------------------------

    [Theory]
    [InlineData("/api/nope")]
    [InlineData("/api/nope/deeper")]
    [InlineData("/api")]
    [InlineData("/api/")]
    [InlineData("/API/nope")]
    public async Task Unknown_api_route_is_404_not_index(string url)
    {
        // With an index.html to fall back on, so that only the routing keeps the fallback away from the API.
        using var webRoot = new TempWebRoot();
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, webRoot: webRoot.Path);

        var response = await GetAsync(api.CreateClient(), url);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.NotEqual("text/html", response.Content.Headers.ContentType?.MediaType);
        Assert.DoesNotContain("<html", await response.Content.ReadAsStringAsync(Ct), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Static_file_under_api_is_never_served()
    {
        using var webRoot = new TempWebRoot();
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, webRoot: webRoot.Path);

        var response = await GetAsync(api.CreateClient(), "/api/stray.json");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.DoesNotContain("stray", await response.Content.ReadAsStringAsync(Ct), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/day/2026-10-22")]
    [InlineData("/week/2026-10-19")]
    [InlineData("/month/2026-10")]
    [InlineData("/year/2026")]
    [InlineData("/range/2026-10-01..2026-10-22")] // dots in the last segment, yet an app route and not a file
    [InlineData("/place/42")]
    [InlineData("/apiary")] // starts with api, but is not under /api
    public async Task Deep_link_serves_index_html(string url)
    {
        using var webRoot = new TempWebRoot();
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, webRoot: webRoot.Path);

        var response = await GetAsync(api.CreateClient(), url);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/html", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal(TempWebRoot.IndexHtml, await response.Content.ReadAsStringAsync(Ct));
        // The page names the hashed bundles of the current build: it is checked every time, so a new build is seen at once.
        Assert.Equal("no-cache", response.Headers.CacheControl?.ToString());
    }

    [Fact]
    public async Task Index_html_asked_for_by_name_is_not_cached_either()
    {
        using var webRoot = new TempWebRoot();
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, webRoot: webRoot.Path);

        var response = await GetAsync(api.CreateClient(), "/index.html");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-cache", response.Headers.CacheControl?.ToString());
    }

    [Fact]
    public async Task A_route_under_assets_is_still_the_page_and_never_immutable()
    {
        using var webRoot = new TempWebRoot();
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, webRoot: webRoot.Path);

        var response = await GetAsync(api.CreateClient(), "/assets/some-route");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(TempWebRoot.IndexHtml, await response.Content.ReadAsStringAsync(Ct));
        Assert.Equal("no-cache", response.Headers.CacheControl?.ToString());
    }

    [Fact]
    public async Task Hashed_assets_are_cached_for_a_year_as_immutable()
    {
        using var webRoot = new TempWebRoot();
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, webRoot: webRoot.Path);
        var client = api.CreateClient();

        foreach (var url in new[] { TempWebRoot.HashedScriptPath, "/assets/index-4e5f6a7b.css" })
        {
            var response = await GetAsync(client, url);

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("public, max-age=31536000, immutable", response.Headers.CacheControl?.ToString());
        }
    }

    [Fact]
    public async Task Other_static_files_are_revalidated()
    {
        using var webRoot = new TempWebRoot();
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, webRoot: webRoot.Path);

        var response = await GetAsync(api.CreateClient(), "/favicon.svg");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-cache", response.Headers.CacheControl?.ToString());
    }

    [Theory]
    [InlineData("/assets/missing-0a1b2c3d.js")]
    [InlineData("/assets/missing-0a1b2c3d.css")]
    [InlineData("/missing.png")]
    public async Task Missing_file_is_404_not_index(string url)
    {
        // A script that is missing must not come back as a page: the browser would try to run it.
        using var webRoot = new TempWebRoot();
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, webRoot: webRoot.Path);

        var response = await GetAsync(api.CreateClient(), url);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.NotEqual("text/html", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Static_files_are_compressed_when_accepted()
    {
        using var webRoot = new TempWebRoot();
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, webRoot: webRoot.Path);
        var client = api.CreateClient();

        var script = await GetAsync(client, TempWebRoot.HashedScriptPath, acceptEncoding: "gzip");
        Assert.Equal("gzip", Assert.Single(script.Content.Headers.ContentEncoding));
        Assert.Equal(string.Concat(Enumerable.Repeat(TempWebRoot.HashedScript, 40)),
            await DecompressAsync(script, s => new GZipStream(s, CompressionMode.Decompress)));

        var page = await GetAsync(client, "/day/2026-10-22", acceptEncoding: "br");
        Assert.Equal("br", Assert.Single(page.Content.Headers.ContentEncoding));
        Assert.Equal(TempWebRoot.IndexHtml, await DecompressAsync(page, s => new BrotliStream(s, CompressionMode.Decompress)));

        var icon = await GetAsync(client, "/favicon.svg", acceptEncoding: "br");
        Assert.Equal("br", Assert.Single(icon.Content.Headers.ContentEncoding));
    }

    // --- map configuration ---------------------------------------------------------------------------------------------

    [Fact]
    public async Task Config_returns_map_styles()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var defaults = new ApiFactory(cs);
        var response = await GetAsync(defaults.CreateClient(), "/api/config");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using (var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct)))
        {
            Assert.Equal("https://tiles.openfreemap.org/styles/liberty", body.RootElement.GetProperty("mapStyleLight").GetString());
            Assert.Equal("https://tiles.openfreemap.org/styles/dark", body.RootElement.GetProperty("mapStyleDark").GetString());
        }

        var overridden = await db.CreateDatabaseAsync(Ct);
        await using var custom = new ApiFactory(overridden, new Dictionary<string, string?>
        {
            ["Map:StyleLight"] = "https://tiles.example.test/light.json",
            ["Map:StyleDark"] = "https://tiles.example.test/dark.json",
        });
        using var echoed = JsonDocument.Parse(await custom.CreateClient().GetStringAsync("/api/config", Ct));
        Assert.Equal("https://tiles.example.test/light.json", echoed.RootElement.GetProperty("mapStyleLight").GetString());
        Assert.Equal("https://tiles.example.test/dark.json", echoed.RootElement.GetProperty("mapStyleDark").GetString());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task Config_with_a_blank_style_keeps_the_default(string blank)
    {
        // A compose file that passes Map__StyleLight through from an unset variable gives an empty value, not a missing one.
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, new Dictionary<string, string?>
        {
            ["Map:StyleLight"] = blank,
            ["Map:StyleDark"] = "https://tiles.example.test/dark.json",
        });

        using var body = JsonDocument.Parse(await api.CreateClient().GetStringAsync("/api/config", Ct));

        Assert.Equal("https://tiles.openfreemap.org/styles/liberty", body.RootElement.GetProperty("mapStyleLight").GetString());
        Assert.Equal("https://tiles.example.test/dark.json", body.RootElement.GetProperty("mapStyleDark").GetString());
    }

    // --- forwarded headers ---------------------------------------------------------------------------------------------

    [Fact]
    public async Task Forwarded_headers_of_any_proxy_are_honoured()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);

        // The proxy is not on loopback: the app is reachable only through it, so it is trusted wherever it is.
        var context = await api.Server.SendAsync(c =>
        {
            c.Request.Method = "GET";
            c.Request.Path = "/api/config";
            c.Connection.RemoteIpAddress = IPAddress.Parse("10.20.30.40");
            c.Request.Headers["X-Forwarded-For"] = "203.0.113.7";
            c.Request.Headers["X-Forwarded-Proto"] = "https";
        }, Ct);

        Assert.Equal("https", context.Request.Scheme);
        Assert.Equal(IPAddress.Parse("203.0.113.7"), context.Connection.RemoteIpAddress);
    }

    // --- conditional GET -----------------------------------------------------------------------------------------------

    [Fact]
    public async Task Api_get_has_etag_and_no_cache()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);

        var response = await GetAsync(api.CreateClient(), "/api/status");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var etag = response.Headers.ETag;
        Assert.NotNull(etag);
        Assert.False(etag.IsWeak);
        Assert.Matches("^\"[A-Za-z0-9_-]{22}\"$", etag.Tag);
        Assert.Equal("no-cache", response.Headers.CacheControl?.ToString());
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct)); // still the whole document
        Assert.True(body.RootElement.TryGetProperty("backfill", out _));
    }

    [Fact]
    public async Task Matching_if_none_match_returns_304()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var first = await GetAsync(client, "/api/status");
        var etag = first.Headers.ETag!.ToString();

        var second = await GetAsync(client, "/api/status", ifNoneMatch: etag);

        Assert.Equal(HttpStatusCode.NotModified, second.StatusCode);
        Assert.Equal(string.Empty, await second.Content.ReadAsStringAsync(Ct));
        Assert.Equal(etag, second.Headers.ETag?.ToString()); // a 304 repeats the validator and the caching rule
        Assert.Equal("no-cache", second.Headers.CacheControl?.ToString());
        Assert.Null(second.Content.Headers.ContentType);
        Assert.True(second.Content.Headers.ContentLength is null or 0);
    }

    [Theory]
    [InlineData("{0}", HttpStatusCode.NotModified)]
    [InlineData("W/{0}", HttpStatusCode.NotModified)] // If-None-Match compares weakly
    [InlineData("\"other\", {0}", HttpStatusCode.NotModified)]
    [InlineData("\"other\",{0},\"another\"", HttpStatusCode.NotModified)]
    [InlineData("*", HttpStatusCode.NotModified)]
    [InlineData("\"other\"", HttpStatusCode.OK)]
    [InlineData("{0}x", HttpStatusCode.OK)]
    [InlineData("garbage", HttpStatusCode.OK)]
    public async Task If_none_match_is_compared_against_every_listed_tag(string header, HttpStatusCode expected)
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var etag = (await GetAsync(client, "/api/status")).Headers.ETag!.ToString();

        var response = await GetAsync(client, "/api/status", ifNoneMatch: string.Format(header, etag));

        Assert.Equal(expected, response.StatusCode);
        if (expected == HttpStatusCode.OK)
            Assert.NotEqual(string.Empty, await response.Content.ReadAsStringAsync(Ct));
    }

    [Fact]
    public async Task Etag_follows_the_body()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var before = await GetAsync(client, "/api/status");
        var again = await GetAsync(client, "/api/status");
        Assert.Equal(before.Headers.ETag, again.Headers.ETag); // the same body, the same tag

        await Sql.ExecAsync(cs, "insert into dirty_range (from_utc, to_utc) values ('2026-10-22T08:00:00Z', '2026-10-22T09:00:00Z')", ct: Ct);
        var after = await GetAsync(client, "/api/status", ifNoneMatch: before.Headers.ETag!.ToString());

        // The status changed, so the old tag no longer matches and the new body comes with a new tag.
        Assert.Equal(HttpStatusCode.OK, after.StatusCode);
        Assert.NotEqual(before.Headers.ETag, after.Headers.ETag);
        using var body = JsonDocument.Parse(await after.Content.ReadAsStringAsync(Ct));
        Assert.Equal(1, body.RootElement.GetProperty("pendingRanges").GetInt32());
    }

    [Fact]
    public async Task Api_responses_that_are_not_ok_are_left_alone()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        var invalid = await GetAsync(client, "/api/day/not-a-date", ifNoneMatch: "*");

        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode); // not turned into a 304 by the wildcard either
        Assert.False(invalid.Headers.Contains("ETag"));
        Assert.Null(invalid.Headers.CacheControl);
        using var body = JsonDocument.Parse(await invalid.Content.ReadAsStringAsync(Ct)); // and still its own error document
        Assert.Contains("date", body.RootElement.GetRawText(), StringComparison.Ordinal);

        var unknown = await GetAsync(client, "/api/nope");
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.False(unknown.Headers.Contains("ETag"));
    }

    [Fact]
    public async Task A_failing_endpoint_still_gets_the_default_exception_handler()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await GetAsync(client, "/api/status")).StatusCode);

        // The status reads the database, so a database that is gone makes the endpoint throw.
        var admin = new NpgsqlConnectionStringBuilder(cs) { Database = "postgres" }.ConnectionString;
        var name = new NpgsqlConnectionStringBuilder(cs).Database!;
        await Sql.ExecAsync(admin, $"drop database {name} with (force)", ct: Ct);

        var response = await GetAsync(client, "/api/status");

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.False(response.Headers.Contains("ETag"));
        Assert.Contains("json", response.Content.Headers.ContentType?.MediaType, StringComparison.Ordinal);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct)); // FastEndpoints' own error document
        Assert.Equal(500, body.RootElement.GetProperty("code").GetInt32());
    }

    [Fact]
    public async Task Ingest_is_not_buffered_or_tagged()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);

        var response = await api.CreateClient().PostAsync("/api/overland",
            Json(Payload.One(time: "2026-10-22T07:00:00Z", lon: 10.75, lat: 59.91, speed: 1, altitude: 12, device: "phone")), Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.False(response.Headers.Contains("ETag"));
        Assert.Null(response.Headers.CacheControl);
        Assert.Equal("""{"result":"ok"}""", await response.Content.ReadAsStringAsync(Ct));
    }

    [Fact]
    public async Task Ingest_ignores_if_none_match()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/overland")
        {
            Content = Json(Payload.One(time: "2026-10-22T07:00:00Z", lon: 10.75, lat: 59.91, speed: 1, altitude: 12, device: "phone")),
        };
        request.Headers.TryAddWithoutValidation("If-None-Match", "*");

        var response = await api.CreateClient().SendAsync(request, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("""{"result":"ok"}""", await response.Content.ReadAsStringAsync(Ct));
        Assert.Equal(1, await Sql.ScalarAsync<long>(cs, "select count(*) from locationlog", ct: Ct));
    }

    // --- compression ---------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Json_is_compressed_when_accepted()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        var response = await GetAsync(client, "/api/status", acceptEncoding: "br");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("br", Assert.Single(response.Content.Headers.ContentEncoding));
        Assert.Contains("Accept-Encoding", response.Headers.Vary);
        var text = await DecompressAsync(response, s => new BrotliStream(s, CompressionMode.Decompress));
        using var body = JsonDocument.Parse(text);
        Assert.True(body.RootElement.TryGetProperty("backfill", out _));

        // The tag belongs to the body, not to its encoding: it is the one of the plain response, so a client can use it either way.
        var plain = await GetAsync(client, "/api/status");
        Assert.Empty(plain.Content.Headers.ContentEncoding);
        Assert.Equal(await plain.Content.ReadAsStringAsync(Ct), text);
        Assert.Equal(plain.Headers.ETag?.Tag, response.Headers.ETag?.Tag);
    }

    [Fact]
    public async Task Json_is_gzipped_for_a_client_that_asks_for_gzip_only()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);

        var response = await GetAsync(api.CreateClient(), "/api/status", acceptEncoding: "gzip");

        Assert.Equal("gzip", Assert.Single(response.Content.Headers.ContentEncoding));
        using var body = JsonDocument.Parse(await DecompressAsync(response, s => new GZipStream(s, CompressionMode.Decompress)));
        Assert.True(body.RootElement.TryGetProperty("backfill", out _));
    }

    [Fact]
    public async Task Compressed_response_can_be_revalidated_with_its_tag()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var first = await GetAsync(client, "/api/status", acceptEncoding: "br");

        var second = await GetAsync(client, "/api/status", acceptEncoding: "br", ifNoneMatch: first.Headers.ETag!.ToString());

        Assert.Equal(HttpStatusCode.NotModified, second.StatusCode);
        Assert.Equal(string.Empty, await second.Content.ReadAsStringAsync(Ct));
        Assert.Empty(second.Content.Headers.ContentEncoding); // nothing to encode
    }

    [Fact]
    public async Task Ingest_response_is_never_compressed()
    {
        // Compression is for what is read. The answer to Overland stays the exact bytes it looks for, whatever the client accepts.
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/overland")
        {
            Content = Json(Payload.One(time: "2026-10-22T07:00:00Z", lon: 10.75, lat: 59.91, speed: 1, altitude: 12, device: "phone")),
        };
        request.Headers.TryAddWithoutValidation("Accept-Encoding", "br, gzip");

        var response = await api.CreateClient().SendAsync(request, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty(response.Content.Headers.ContentEncoding);
        Assert.Equal("""{"result":"ok"}""", await response.Content.ReadAsStringAsync(Ct));
        Assert.False(response.Headers.Contains("ETag"));
    }

    [Fact]
    public async Task Without_accept_encoding_nothing_is_compressed()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);

        var response = await GetAsync(api.CreateClient(), "/api/config");

        Assert.Empty(response.Content.Headers.ContentEncoding);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct));
        Assert.True(body.RootElement.TryGetProperty("mapStyleLight", out _));
    }
}
