using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Sporer.Api.Features.Timeline;
using static Sporer.Api.Tests.TimelineSeeder;

namespace Sporer.Api.Tests;

/// <summary>
/// The rules every write under <c>/api</c> shares: its body is JSON (<see cref="Sporer.Api.Http.JsonWritesMiddleware"/>), and what
/// the owner has set is not undone by the rebuild of the timeline (<see cref="ProcessingQueue.RestartBackfillAsync"/>).
/// </summary>
[Collection("db")]
public class WritesTests(DatabaseFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime Utc(int month, int day, int hour = 0) => new(2026, month, day, hour, 0, 0, DateTimeKind.Utc);

    private static DateOnly D(int month, int day) => new(2026, month, day);

    /// <summary>A place that is on the timeline (so that it can be renamed), with the owner's name for it if it has one.</summary>
    private static async Task<long> OnTheTimelineAsync(string cs, string? userName = null)
    {
        var place = await InsertPlaceAsync(cs, userName: userName, osmName: "OpenStreetMap's name");
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: place);
        return place;
    }

    private static Task<string?> UserNameAsync(string cs, long place) =>
        Sql.ScalarAsync<string?>(cs, "select user_name from place where id = @place", new { place }, Ct);

    /// <summary>A body with exactly the <c>Content-Type</c> given, however odd (none for null), where <see cref="StringContent"/> would tidy it.</summary>
    private static HttpContent Raw(string body, string? contentType)
    {
        var content = new StringContent(body, Encoding.UTF8);
        content.Headers.Remove("Content-Type");
        if (contentType is not null)
            Assert.True(content.Headers.TryAddWithoutValidation("Content-Type", contentType));
        return content;
    }

    [Fact]
    public async Task Write_with_a_form_body_is_415()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // starting the host runs the migrations
        var place = await OnTheTimelineAsync(cs);

        // What a page of another site can make a browser send without asking first: a form, and JSON passed off as plain text.
        // None of them may reach the endpoint, whichever of the three methods is used, and whatever the body says.
        var bodies = new (string Name, Func<HttpContent> Make)[]
        {
            ("urlencoded form", () => Raw("name=Hacked", "application/x-www-form-urlencoded")),
            ("multipart form", () => new MultipartFormDataContent { { new StringContent("Hacked"), "name" } }),
            ("json as text/plain", () => Raw("""{"name":"Hacked"}""", "text/plain")),
            ("json with no content type", () => Raw("""{"name":"Hacked"}""", null)),
            ("a type that only starts like json", () => Raw("""{"name":"Hacked"}""", "application/jsonx")),
            ("a type that is not one", () => Raw("""{"name":"Hacked"}""", "json")),
            ("an empty form", () => Raw("", "application/x-www-form-urlencoded")),
        };
        foreach (var method in new[] { HttpMethod.Post, HttpMethod.Put, HttpMethod.Patch })
        {
            foreach (var (name, make) in bodies)
            {
                using var request = new HttpRequestMessage(method, $"/api/places/{place}/name") { Content = make() };
                using var response = await client.SendAsync(request, Ct);

                var text = await response.Content.ReadAsStringAsync(Ct);
                Assert.True(response.StatusCode == HttpStatusCode.UnsupportedMediaType, $"{method} with {name} gave {(int)response.StatusCode}: {text}");
                Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
                using var problem = JsonDocument.Parse(text);
                Assert.Equal("Unsupported Media Type", problem.RootElement.GetProperty("title").GetString());
                Assert.Contains("application/json", problem.RootElement.GetProperty("detail").GetString());
            }
        }

        Assert.Null(await UserNameAsync(cs, place)); // nothing was written

        // The check is of the request, not of what it is for: there need not be an endpoint.
        using var elsewhere = new HttpRequestMessage(HttpMethod.Post, "/api/there-is-no-such-endpoint") { Content = Raw("a=b", "application/x-www-form-urlencoded") };
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await client.SendAsync(elsewhere, Ct)).StatusCode);
    }

    [Fact]
    public async Task Write_with_json_passes()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs);

        // With the charset a client adds, without it, and in the case a client might write it.
        var types = new[] { "application/json; charset=utf-8", "application/json", "Application/JSON", "application/json;charset=UTF-8" };
        foreach (var (type, index) in types.Select((t, i) => (t, i)))
        {
            using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/places/{place}/name") { Content = Raw($$"""{"name":"Mine {{index}}"}""", type) };
            using var response = await client.SendAsync(request, Ct);

            Assert.True(response.StatusCode == HttpStatusCode.OK, $"{type} gave {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(Ct)}");
            Assert.Equal($"Mine {index}", await UserNameAsync(cs, place));
        }
    }

    [Fact]
    public async Task Write_with_no_body_and_no_content_type_is_left_to_the_endpoint()
    {
        // Some writes take no body at all (a retry, a restore). A form always comes with a content type, so a request with
        // neither is not one: the middleware says nothing, and what answers is whatever is routed there (here, nothing is).
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        using var response = await client.PostAsync("/api/there-is-no-such-endpoint", null, Ct);

        Assert.NotEqual(HttpStatusCode.UnsupportedMediaType, response.StatusCode);
    }

    [Fact]
    public async Task Reads_are_left_alone()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/status") { Content = Raw("a=b", "application/x-www-form-urlencoded") };
        using var response = await client.SendAsync(request, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Overland_keeps_its_own_rules()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, new Dictionary<string, string?> { ["OVERLAND_TOKEN"] = "s3cret" });
        var client = api.CreateClient();
        var json = Payload.One(time: "2026-10-22T07:00:00Z", lon: 10.75, lat: 59.91, speed: 1, altitude: 12, device: "phone");

        // Who may send is its own rule (the token), whatever the type of the body.
        using var unauthorized = await client.PostAsync("/api/overland?token=wrong", Raw(json, "application/json"), Ct);
        Assert.Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode);

        // So is what it takes: its binder reads any JSON type, the suffix ones too, which the middleware's rule (exactly
        // application/json) would turn away. Nothing is lost to the middleware: the point of every one of them is stored.
        foreach (var type in new[] { "application/json", "application/json; charset=utf-8", "application/vnd.overland+json" })
        {
            using var accepted = await client.PostAsync("/api/overland?token=s3cret", Raw(json, type), Ct);
            Assert.True(accepted.StatusCode == HttpStatusCode.OK, $"{type} gave {(int)accepted.StatusCode}");
            Assert.Equal("""{"result":"ok"}""", await accepted.Content.ReadAsStringAsync(Ct));
        }
        Assert.Equal(3, await Sql.ScalarAsync<long>(cs, "select count(*) from locationlog", ct: Ct)); // sent three times, kept three times

        // And a body that is no JSON gets the answer its own binder gives, not the middleware's problem details.
        using var form = await client.PostAsync("/api/overland?token=s3cret", Raw("a=b", "application/x-www-form-urlencoded"), Ct);
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, form.StatusCode);
        Assert.NotEqual("application/problem+json", form.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task RestartBackfill_keeps_owner_data()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        _ = api.Services; // starting the host runs the migrations

        // What the owner set: a name, a merge, a removed point, an edit of a trip, a home, a setting.
        var named = await InsertPlaceAsync(cs, userName: "Mine", osmName: "OpenStreetMap's name", city: "Oslo", country: "Norway");
        var merged = await InsertPlaceAsync(cs, mergedInto: named, lat: 59.93, lon: 10.76);
        var home = await InsertPlaceAsync(cs, lat: 60.0, lon: 11.0);
        await Sql.ExecAsync(cs,
            """
            insert into excluded_point (device, time, batch_id) values ('phone', '2026-10-22T07:00:00.123456Z', '3b1d8e0a-6f35-4c43-9e0c-2f6a7d1a9c11');
            insert into trip_edit (detected_id, detected_last_night, name, start_date, end_date, deleted, deleted_label)
            values ('2026-09-12', '2026-09-13', 'Lisbon weekend', '2026-09-11', null, true, 'Lisbon · 12 – 14 Sep 2026');
            insert into home_period (place_id, from_date, to_date, source) values (@home, '2026-01-01', null, 'user');
            insert into app_setting (key, value) values ('tripMinDistanceKm', '80'::jsonb);
            """, new { home }, Ct);

        // What is derived from the timeline, which the rebuild does clear: a segment, a night, a trip, a detected home.
        await InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 7), D(10, 22), D(10, 22), placeId: named);
        await Sql.ExecAsync(cs,
            """
            insert into night (date, instant_utc, zone, source, place_id, latitude, longitude)
            values ('2026-10-21', '2026-10-22T01:00:00Z', 'Europe/Oslo', 'stay', @named, 59.9, 10.7);
            insert into trip (id, last_night, nights, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date)
            values ('2026-09-12', '2026-09-13', 2, '2026-09-12T08:00:00Z', '2026-09-14T10:00:00Z', 'Europe/Oslo', 'Europe/Oslo', '2026-09-12', '2026-09-14');
            insert into home_period (place_id, from_date, to_date, source) values (@home, '2025-01-01', '2025-12-31', 'detected');
            """, new { named, home }, Ct);

        // Whole rows, as the database writes them, so that a change to any column shows.
        async Task<string[]> OwnerDataAsync()
        {
            var rows = new List<string>();
            foreach (var query in new[]
            {
                "select to_jsonb(p)::text from place p order by id",
                "select to_jsonb(e)::text from excluded_point e order by device, time",
                "select to_jsonb(t)::text from trip_edit t order by detected_id",
                "select to_jsonb(h)::text from home_period h where source = 'user' order by id",
                "select to_jsonb(s)::text from app_setting s order by key",
            })
                rows.AddRange(await Sql.QueryAsync<string>(cs, query, ct: Ct));
            return [.. rows];
        }

        var before = await OwnerDataAsync();
        Assert.Equal(3 + 1 + 1 + 1 + 1, before.Length);

        await api.Services.GetRequiredService<ProcessingQueue>().RestartBackfillAsync("a new version", Utc(1, 1), Utc(10, 28), Ct);

        Assert.Equal(before, await OwnerDataAsync());
        Assert.Equal(named, await Sql.ScalarAsync<long>(cs, "select merged_into_id from place where id = @merged", new { merged }, Ct));
        foreach (var table in new[] { "segment", "night", "trip" })
            Assert.Equal(0, await Sql.ScalarAsync<long>(cs, $"select count(*) from {table}", ct: Ct));
        Assert.Equal(0, await Sql.ScalarAsync<long>(cs, "select count(*) from home_period where source = 'detected'", ct: Ct));
        Assert.Equal("a new version", await Sql.ScalarAsync<string>(cs, "select algorithm_version from processing_state where id = 1", ct: Ct));
    }
}
