using System.Globalization;
using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Sporer.Api.Configuration;
using Sporer.Api.Features.Transit;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// The Overpass client: the spec's queries, sent as a form in a POST with the operator's user agent, the lines read out of the answer, and every
/// way Overpass can fail turned into <see cref="OverpassUnavailableException"/>. The requests go to a <see cref="FakeOverpass"/>.
/// </summary>
[Collection("db")]
public class OverpassClientTests(DatabaseFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static OverpassClient ClientFor(FakeOverpass overpass, TransitOptions? options = null)
        => new(new HttpClient(overpass), options ?? new TransitOptions());

    private static readonly TransitTile OsloRail = new(TransitKind.Rail, 599, 107);

    [Fact]
    public void The_railway_query_is_the_specs()
    {
        Assert.Equal(
            """
            [out:json][timeout:90];
            way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge|monorail|funicular)$"]
               ["service"!~"^(yard|siding|spur|crossover)$"]["usage"!~"^(industrial|military|test)$"](59.9,10.7,60.0,10.8);
            out tags geom(59.9,10.7,60.0,10.8) qt;
            """,
            OverpassClient.Query(OsloRail));
    }

    [Fact]
    public void The_bus_route_query_is_the_specs()
    {
        Assert.Equal(
            """
            [out:json][timeout:90];
            rel["route"~"^(bus|trolleybus|coach)$"](59.9,10.7,60.0,10.8);
            way(r)(59.9,10.7,60.0,10.8);
            out skel geom(59.9,10.7,60.0,10.8) qt;
            """,
            OverpassClient.Query(OsloRail with { Kind = TransitKind.Bus }));
    }

    [Theory]
    [InlineData(-1, -1, "-0.1,-0.1,0.0,0.0")]
    [InlineData(0, 0, "0.0,0.0,0.1,0.1")]
    [InlineData(-339, -1800, "-33.9,-180.0,-33.8,-179.9")]
    [InlineData(899, 1799, "89.9,179.9,90.0,180.0")]
    [InlineData(-900, 1234, "-90.0,123.4,-89.9,123.5")]
    public void The_box_is_the_tiles_edges_with_one_decimal_whatever_the_culture(int lat, int lon, string box)
    {
        var comma = (CultureInfo)CultureInfo.InvariantCulture.Clone();
        comma.NumberFormat.NumberDecimalSeparator = ",";
        comma.NumberFormat.NegativeSign = "~";
        var original = CultureInfo.CurrentCulture;
        CultureInfo.CurrentCulture = comma;
        try
        {
            Assert.Contains($"({box});", OverpassClient.Query(new TransitTile(TransitKind.Rail, lat, lon)));
            Assert.Contains($"geom({box}) qt;", OverpassClient.Query(new TransitTile(TransitKind.Bus, lat, lon)));
        }
        finally
        {
            CultureInfo.CurrentCulture = original;
        }
    }

    [Fact]
    public async Task The_query_is_posted_as_a_form_to_the_configured_url()
    {
        var overpass = new FakeOverpass();
        overpass.ReplyLines();

        await ClientFor(overpass, new TransitOptions { OverpassUrl = "https://overpass.example.test/api/interpreter" }).FetchAsync(OsloRail, Ct);

        var request = Assert.Single(overpass.Requests);
        Assert.Equal("POST", request.Method);
        Assert.Equal("https://overpass.example.test/api/interpreter", request.Uri.AbsoluteUri);
        Assert.Equal("application/x-www-form-urlencoded", request.ContentType);
        Assert.Equal(OverpassClient.Query(OsloRail), request.Query);
    }

    [Theory]
    [InlineData("Sporer/1.0 (transit@example.invalid)", "Sporer/1.0 (naming@example.invalid)", "Sporer/1.0 (transit@example.invalid)")]
    [InlineData("", "Sporer/1.0 (naming@example.invalid)", "Sporer/1.0 (naming@example.invalid)")] // one name for the installation is enough
    [InlineData(null, "Sporer/1.0 (naming@example.invalid)", "Sporer/1.0 (naming@example.invalid)")]
    [InlineData("Sporer/1.0 (transit@example.invalid)", "", "Sporer/1.0 (transit@example.invalid)")]
    public async Task The_app_sends_the_transit_user_agent_else_the_naming_one(string? transit, string nominatim, string sent)
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var overpass = new FakeOverpass();
        await using var api = new ApiFactory(cs,
            new Dictionary<string, string?> { ["Transit:UserAgent"] = transit, ["Nominatim:UserAgent"] = nominatim },
            configureServices: services => services.AddHttpClient<OverpassClient>().ConfigurePrimaryHttpMessageHandler(() => overpass));
        overpass.ReplyLines();

        await api.Services.GetRequiredService<OverpassClient>().FetchAsync(OsloRail, Ct);

        var request = Assert.Single(overpass.Requests);
        Assert.Equal(sent, request.UserAgent);
        Assert.Equal(TransitOptions.DefaultOverpassUrl, request.Uri.AbsoluteUri);
    }

    [Fact]
    public async Task The_apps_client_waits_two_minutes_and_buffers_at_most_64_MB()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);

        var client = api.Services.GetRequiredService<IHttpClientFactory>().CreateClient(nameof(OverpassClient));

        Assert.Equal(TimeSpan.FromSeconds(120), client.Timeout);
        Assert.Equal(64L * 1024 * 1024, client.MaxResponseContentBufferSize);
    }

    [Fact]
    public async Task The_lines_are_the_geometry_of_each_way_cut_where_a_point_is_left_out()
    {
        var a = new GeoPoint(59.95, 10.71);
        var b = new GeoPoint(59.951, 10.72);
        var c = new GeoPoint(59.952, 10.73);
        var d = new GeoPoint(59.953, 10.74);
        var overpass = new FakeOverpass();
        overpass.ReplyJson(
            """
            {"version":0.6,"elements":[
              {"type":"way","id":1,"tags":{"railway":"subway"},"geometry":[{"lat":59.95,"lon":10.71},{"lat":59.951,"lon":10.72}]},
              {"type":"way","id":2,"geometry":[null,{"lat":59.951,"lon":10.72},{"lat":59.952,"lon":10.73},null,{"lat":59.953,"lon":10.74},null]},
              {"type":"way","id":3,"geometry":[{"lat":59.952,"lon":10.73},{"lat":"x","lon":10.74},{"lat":91,"lon":10.74},{"lon":10.74},{"lat":59.953,"lon":10.74}]},
              {"type":"way","id":4,"geometry":[null,null]},
              {"type":"way","id":5},
              {"type":"relation","id":6,"members":[]},
              {"type":"node","id":7,"lat":59.9,"lon":10.7},
              7
            ]}
            """);

        var lines = await ClientFor(overpass).FetchAsync(OsloRail, Ct);

        Assert.Equal(
            new IReadOnlyList<GeoPoint>[] { [a, b], [b, c], [d], [c], [d] },
            lines);
    }

    [Fact]
    public async Task A_tile_with_no_way_has_no_line()
    {
        var overpass = new FakeOverpass();
        overpass.ReplyJson("""{"version":0.6,"generator":"Overpass API","elements":[]}""");

        Assert.Empty(await ClientFor(overpass).FetchAsync(OsloRail, Ct));
    }

    [Theory]
    [InlineData(HttpStatusCode.NotAcceptable)] // no user agent, by the rules of 2026
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.BadGateway)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    [InlineData(HttpStatusCode.GatewayTimeout)]
    public async Task A_refusal_or_a_failure_is_unavailable(HttpStatusCode status)
    {
        var overpass = new FakeOverpass();
        overpass.Reply(status, "<html>busy</html>");

        var error = await Assert.ThrowsAsync<OverpassUnavailableException>(() => ClientFor(overpass).FetchAsync(OsloRail, Ct));

        Assert.Equal(status, error.StatusCode);
        Assert.Contains(((int)status).ToString(CultureInfo.InvariantCulture), error.Message);
    }

    [Fact]
    public async Task Network_failures_and_timeouts_are_unavailable()
    {
        var overpass = new FakeOverpass();
        overpass.Throw(new HttpRequestException("connection refused"));
        overpass.Throw(new TaskCanceledException("the request timed out", new TimeoutException()));
        overpass.Throw(new IOException("connection reset"));
        var client = ClientFor(overpass);

        for (var i = 0; i < 3; i++)
            Assert.Null((await Assert.ThrowsAsync<OverpassUnavailableException>(() => client.FetchAsync(OsloRail, Ct))).StatusCode);
    }

    [Fact]
    public async Task An_answer_over_the_buffer_limit_is_unavailable()
    {
        var overpass = new FakeOverpass();
        overpass.ReplyLines(TransitMap.Along(new GeoPoint(59.95, 10.71), new GeoPoint(59.95, 10.79)));
        var client = new OverpassClient(new HttpClient(overpass) { MaxResponseContentBufferSize = 1024 }, new TransitOptions());

        await Assert.ThrowsAsync<OverpassUnavailableException>(() => client.FetchAsync(OsloRail, Ct));
    }

    [Fact]
    public async Task A_cancellation_is_let_through()
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        var overpass = new FakeOverpass();
        overpass.Throw(new OperationCanceledException(cts.Token));
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ClientFor(overpass).FetchAsync(OsloRail, cts.Token));
    }

    [Theory]
    [InlineData("")]
    [InlineData("<?xml version=\"1.0\"?><osm/>")]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("""{"version":0.6}""")]
    [InlineData("""{"elements":{}}""")]
    // A query that ran out of time or memory still answers 200, with the elements it had and a remark.
    [InlineData("""{"elements":[],"remark":"runtime error: Query timed out in \"query\" at line 3 after 91 seconds."}""")]
    [InlineData("""{"elements":[{"type":"way","geometry":[{"lat":59.95,"lon":10.71}]}],"remark":"runtime error: Query run out of memory using about 2048 MB of RAM."}""")]
    public async Task An_answer_that_is_no_result_is_unavailable(string body)
    {
        var overpass = new FakeOverpass();
        overpass.ReplyJson(body);

        await Assert.ThrowsAsync<OverpassUnavailableException>(() => ClientFor(overpass).FetchAsync(OsloRail, Ct));
    }

    // --- How the lines are stored -------------------------------------------------------------------------------

    [Fact]
    public void Stored_lines_read_back_to_the_microdegree()
    {
        IReadOnlyList<GeoPoint>[] lines =
        [
            [new GeoPoint(59.9512345678, 10.7123456789), new GeoPoint(-33.9, -179.9999996)],
            [new GeoPoint(90, 180)],
            [new GeoPoint(-90, -180), new GeoPoint(0.0000004, -0.0000006), new GeoPoint(1, 1)],
        ];

        var blob = TransitLineBlob.Encode(lines);
        var read = TransitLineBlob.Decode(blob);

        Assert.Equal(3, TransitLineBlob.CountLines(blob));
        Assert.Equal(1 + 4 + (4 + 2 * 8) + (4 + 8) + (4 + 3 * 8), blob.Length);
        Assert.Equal(lines.Select(l => l.Count), read.Select(l => l.Count));
        foreach (var (line, back) in lines.Zip(read))
        {
            foreach (var (p, q) in line.Zip(back))
            {
                Assert.InRange(Math.Abs(p.Latitude - q.Latitude), 0, 0.0000005);
                Assert.InRange(Math.Abs(p.Longitude - q.Longitude), 0, 0.0000005);
            }
        }
        Assert.Equal(new GeoPoint(59.951235, 10.712346), read[0][0]);
    }

    [Fact]
    public void A_point_off_the_globe_is_not_stored_and_cuts_its_line()
    {
        var a = new GeoPoint(59.95, 10.71);
        var b = new GeoPoint(59.96, 10.72);

        var read = TransitLineBlob.Decode(TransitLineBlob.Encode(
        [
            [a, new GeoPoint(double.NaN, 10), b],
            [new GeoPoint(91, 10), new GeoPoint(10, 181), new GeoPoint(10, double.PositiveInfinity)],
            [],
        ]));

        Assert.Equal(new IReadOnlyList<GeoPoint>[] { [a], [b] }, read);
        Assert.Empty(TransitLineBlob.Decode(TransitLineBlob.Encode([])));
    }

    [Theory]
    [InlineData(new byte[0])]
    [InlineData(new byte[] { 1, 0, 0 })]
    [InlineData(new byte[] { 2, 0, 0, 0, 0 })] // another version
    [InlineData(new byte[] { 1, 255, 255, 255, 255 })] // a negative count
    [InlineData(new byte[] { 1, 1, 0, 0, 0 })] // a line that is not there
    [InlineData(new byte[] { 1, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0 })] // two points promised, one there
    [InlineData(new byte[] { 1, 0, 0, 0, 0, 7 })] // something after the end
    public void Stored_lines_that_cannot_be_read_are_a_format_error(byte[] blob)
        => Assert.Throws<FormatException>(() => TransitLineBlob.Decode(blob));
}
