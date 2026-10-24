using System.Net;
using System.Text.Json;
using static Sporer.Api.Tests.TimelineSeeder;

namespace Sporer.Api.Tests;

[Collection("db")]
public class PlaceEndpointTests(DatabaseFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime Utc(int year, int month, int day, int hour = 0, int minute = 0)
        => new(year, month, day, hour, minute, 0, DateTimeKind.Utc);

    private static DateOnly D(int year, int month, int day) => new(year, month, day);

    /// <summary>GETs a place, expects 200 and returns the parsed body (the caller disposes it).</summary>
    private static async Task<JsonDocument> GetPlaceAsync(HttpClient client, long id)
    {
        var response = await client.GetAsync($"/api/places/{id}", Ct);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"GET /api/places/{id} returned {(int)response.StatusCode}: {text}");
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        return JsonDocument.Parse(text);
    }

    private static async Task<HttpStatusCode> StatusOfAsync(HttpClient client, string path)
        => (await client.GetAsync(path, Ct)).StatusCode;

    [Fact]
    public async Task Place_returns_totals_and_recent_visits()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // starting the host runs the migrations
        var place = await InsertPlaceAsync(cs, userName: "Storgata 5", osmName: "Some shop", address: "Storgata 5, Oslo", city: "Oslo",
            country: "Norway", lat: 59.92, lon: 10.75);
        var other = await InsertPlaceAsync(cs, userName: "Elsewhere");

        // Three stays, added in no order of time. The first is long before the others and not in the range of anything: the totals
        // are over all of the place's time. The second crosses midnight, 22:00 to 08:00 in Oslo (UTC+2): it is a visit of the 22nd.
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 22, 20), Utc(2026, 10, 23, 6), D(2026, 10, 22), D(2026, 10, 23), placeId: place);
        await InsertSegmentAsync(cs, "stay", Utc(2024, 3, 3, 9), Utc(2024, 3, 3, 10, 30), D(2024, 3, 3), D(2024, 3, 3), placeId: place);
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 25, 10), Utc(2026, 10, 25, 11), D(2026, 10, 25), D(2026, 10, 25), placeId: place);
        // What is not the place's time: a stay elsewhere, and the moves and the gap around the visits, which are no visit (not even
        // where a row names the place, which the app does not write but the schema allows).
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 26, 8), Utc(2026, 10, 26, 18), D(2026, 10, 26), D(2026, 10, 26), placeId: other);
        await InsertSegmentAsync(cs, "move", Utc(2026, 10, 25, 11), Utc(2026, 10, 25, 12), D(2026, 10, 25), D(2026, 10, 25), mode: "walk", distance: 900);
        await InsertSegmentAsync(cs, "move", Utc(2026, 10, 27, 11), Utc(2026, 10, 27, 12), D(2026, 10, 27), D(2026, 10, 27), mode: "walk", distance: 900, placeId: place);
        await InsertSegmentAsync(cs, "gap", Utc(2026, 10, 25, 12), Utc(2026, 10, 25, 14), D(2026, 10, 25), D(2026, 10, 25));
        await InsertSegmentAsync(cs, "gap", Utc(2026, 10, 28, 12), Utc(2026, 10, 28, 14), D(2026, 10, 28), D(2026, 10, 28), placeId: place);

        using var body = await GetPlaceAsync(client, place);

        var root = body.RootElement;
        Assert.Equal(
            new[] { "id", "name", "address", "city", "country", "lat", "lon", "totalSeconds", "visits", "firstVisit", "lastVisit", "recentVisits" },
            root.EnumerateObject().Select(p => p.Name));
        Assert.Equal(place, root.GetProperty("id").GetInt64());
        Assert.Equal("Storgata 5", root.GetProperty("name").GetString()); // the owner's name wins over OpenStreetMap's
        Assert.Equal("Storgata 5, Oslo", root.GetProperty("address").GetString());
        Assert.Equal("Oslo", root.GetProperty("city").GetString());
        Assert.Equal("Norway", root.GetProperty("country").GetString());
        Assert.Equal(59.92, root.GetProperty("lat").GetDouble());
        Assert.Equal(10.75, root.GetProperty("lon").GetDouble());
        Assert.Equal((10 * 3600) + (90 * 60) + 3600, root.GetProperty("totalSeconds").GetInt64());
        Assert.Equal(3, root.GetProperty("visits").GetInt32());
        // First and last visit are when the first and the latest visit began, as the visits' own starts are.
        Assert.Equal("2024-03-03T09:00:00Z", root.GetProperty("firstVisit").GetString());
        Assert.Equal("2026-10-25T10:00:00Z", root.GetProperty("lastVisit").GetString());

        var visits = root.GetProperty("recentVisits").EnumerateArray().ToList();
        Assert.Equal(3, visits.Count);
        Assert.All(visits, v => Assert.Equal(new[] { "start", "end", "date", "timeZone" }, v.EnumerateObject().Select(p => p.Name)));
        Assert.Equal(
            new[] { "2026-10-25T10:00:00Z", "2026-10-22T20:00:00Z", "2024-03-03T09:00:00Z" },
            visits.Select(v => v.GetProperty("start").GetString()));
        Assert.Equal(
            new[] { "2026-10-25T11:00:00Z", "2026-10-23T06:00:00Z", "2024-03-03T10:30:00Z" },
            visits.Select(v => v.GetProperty("end").GetString()));
        Assert.Equal(new[] { "2026-10-25", "2026-10-22", "2024-03-03" }, visits.Select(v => v.GetProperty("date").GetString()));
        Assert.All(visits, v => Assert.Equal("Europe/Oslo", v.GetProperty("timeZone").GetString()));
    }

    [Fact]
    public async Task Place_shows_the_date_and_zone_the_stay_started_in()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await InsertPlaceAsync(cs, lat: 35.68, lon: 139.76);
        // 01:00 on the 23rd in Tokyo (UTC+9) is still the 22nd in UTC: the date is the stored local date, in the stay's zone.
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 22, 16), Utc(2026, 10, 22, 20), D(2026, 10, 23), D(2026, 10, 23), "Asia/Tokyo", placeId: place);

        using var body = await GetPlaceAsync(client, place);

        var visit = Assert.Single(body.RootElement.GetProperty("recentVisits").EnumerateArray());
        Assert.Equal("2026-10-22T16:00:00Z", visit.GetProperty("start").GetString());
        Assert.Equal("2026-10-23", visit.GetProperty("date").GetString());
        Assert.Equal("Asia/Tokyo", visit.GetProperty("timeZone").GetString());
    }

    [Fact]
    public async Task Place_without_names_has_explicit_nulls()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await InsertPlaceAsync(cs);
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 22, 6), Utc(2026, 10, 22, 7), D(2026, 10, 22), D(2026, 10, 22), placeId: place);

        using var body = await GetPlaceAsync(client, place);

        Assert.All(new[] { "name", "address", "city", "country" }, name => Assert.Equal(JsonValueKind.Null, body.RootElement.GetProperty(name).ValueKind));
        Assert.Equal(3600, body.RootElement.GetProperty("totalSeconds").GetInt64());
    }

    [Fact]
    public async Task Place_merged_id_resolves_to_survivor()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var survivor = await InsertPlaceAsync(cs, userName: "Survivor", osmName: "Survivor OSM", address: "1 Main St", city: "Oslo", country: "Norway", lat: 59.5, lon: 10.5);
        var middle = await InsertPlaceAsync(cs, userName: "Middle", city: "Bergen", country: "Norway", lat: 60.1, lon: 5.3, mergedInto: survivor);
        var absorbed = await InsertPlaceAsync(cs, userName: "Absorbed", osmName: "Absorbed OSM", city: "Tromso", country: "Norway", lat: 69.6, lon: 18.9, mergedInto: middle);
        // Merged into the survivor but with no stay of its own any more: its id still leads to the survivor.
        var bare = await InsertPlaceAsync(cs, userName: "Bare", mergedInto: survivor);
        var other = await InsertPlaceAsync(cs, userName: "Other");
        // One hour at the place merged into the middle one, two at the middle one, three at the survivor, one elsewhere. The stays
        // keep the place ids they were given before the merges: they are what the totals are made of.
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 22, 6), Utc(2026, 10, 22, 7), D(2026, 10, 22), D(2026, 10, 22), placeId: absorbed);
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 22, 8), Utc(2026, 10, 22, 10), D(2026, 10, 22), D(2026, 10, 22), placeId: middle);
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 23, 11), Utc(2026, 10, 23, 14), D(2026, 10, 23), D(2026, 10, 23), placeId: survivor);
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 24, 15), Utc(2026, 10, 24, 16), D(2026, 10, 24), D(2026, 10, 24), placeId: other);

        foreach (var id in new[] { survivor, middle, absorbed, bare })
        {
            using var body = await GetPlaceAsync(client, id);

            var root = body.RootElement;
            Assert.True(survivor == root.GetProperty("id").GetInt64(), $"{id} gave {root.GetProperty("id").GetInt64()}, not {survivor}");
            Assert.Equal("Survivor", root.GetProperty("name").GetString());
            Assert.Equal("1 Main St", root.GetProperty("address").GetString());
            Assert.Equal("Oslo", root.GetProperty("city").GetString());
            Assert.Equal(59.5, root.GetProperty("lat").GetDouble());
            Assert.Equal(10.5, root.GetProperty("lon").GetDouble());
            Assert.Equal(6 * 3600, root.GetProperty("totalSeconds").GetInt64());
            Assert.Equal(3, root.GetProperty("visits").GetInt32());
            Assert.Equal("2026-10-22T06:00:00Z", root.GetProperty("firstVisit").GetString());
            Assert.Equal("2026-10-23T11:00:00Z", root.GetProperty("lastVisit").GetString());
            Assert.Equal(
                new[] { "2026-10-23T11:00:00Z", "2026-10-22T08:00:00Z", "2026-10-22T06:00:00Z" },
                root.GetProperty("recentVisits").EnumerateArray().Select(v => v.GetProperty("start").GetString()));
            Assert.DoesNotContain("Absorbed", root.GetRawText());
            Assert.DoesNotContain("Middle", root.GetRawText());
        }
    }

    [Fact]
    public async Task Place_unknown_or_orphan_is_404()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var shown = await InsertPlaceAsync(cs, userName: "Shown");
        // A reprocessing that moved the stay left this place behind with no segment: it is not on the timeline.
        var orphan = await InsertPlaceAsync(cs, userName: "Orphan");
        // Merged into an orphan: it leads to a place that is not in use.
        var intoOrphan = await InsertPlaceAsync(cs, userName: "Into orphan", mergedInto: orphan);
        // Not something the app writes, but the schema allows it: a merge cycle leaves no place that survives, stays or not.
        var first = await InsertPlaceAsync(cs, userName: "First");
        var second = await InsertPlaceAsync(cs, userName: "Second", mergedInto: first);
        await Sql.ExecAsync(cs, "update place set merged_into_id = @second where id = @first", new { first, second }, Ct);
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 22, 6), Utc(2026, 10, 22, 7), D(2026, 10, 22), D(2026, 10, 22), placeId: shown);
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 22, 8), Utc(2026, 10, 22, 9), D(2026, 10, 22), D(2026, 10, 22), placeId: first);
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 22, 10), Utc(2026, 10, 22, 11), D(2026, 10, 22), D(2026, 10, 22), placeId: second);

        Assert.Equal(HttpStatusCode.OK, await StatusOfAsync(client, $"/api/places/{shown}"));
        Assert.Equal(HttpStatusCode.NotFound, await StatusOfAsync(client, $"/api/places/{orphan}"));
        Assert.Equal(HttpStatusCode.NotFound, await StatusOfAsync(client, $"/api/places/{intoOrphan}"));
        Assert.Equal(HttpStatusCode.NotFound, await StatusOfAsync(client, $"/api/places/{first}"));
        Assert.Equal(HttpStatusCode.NotFound, await StatusOfAsync(client, $"/api/places/{second}"));
        Assert.Equal(HttpStatusCode.NotFound, await StatusOfAsync(client, "/api/places/999999"));
        Assert.Equal(HttpStatusCode.NotFound, await StatusOfAsync(client, "/api/places/9223372036854775807"));
    }

    [Fact]
    public async Task Place_is_in_use_when_it_or_any_place_merged_into_it_has_a_segment()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // The day and range views show the surviving place of a stay, whatever id the stay still carries, so the place view serves
        // it too: a place is in use when it, or a place merged into it however indirectly, is named by a segment. All the time of
        // this one is at the place merged into it.
        var lonely = await InsertPlaceAsync(cs, userName: "Lonely");
        var child = await InsertPlaceAsync(cs, userName: "Child", mergedInto: lonely);
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 22, 6), Utc(2026, 10, 22, 7), D(2026, 10, 22), D(2026, 10, 22), placeId: child);
        // The same three links down: only the last has a stay, and every id on the way leads to the survivor.
        var root = await InsertPlaceAsync(cs, userName: "Root");
        var middle = await InsertPlaceAsync(cs, userName: "Middle", mergedInto: root);
        var leaf = await InsertPlaceAsync(cs, userName: "Leaf", mergedInto: middle);
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 23, 6), Utc(2026, 10, 23, 9), D(2026, 10, 23), D(2026, 10, 23), placeId: leaf);
        // A group that no segment names at all is not in use, whichever of its ids is asked for.
        var hollow = await InsertPlaceAsync(cs, userName: "Hollow");
        var hollowChild = await InsertPlaceAsync(cs, userName: "Hollow child", mergedInto: hollow);
        // A place named by no stay, only by a move (the app does not write that, the schema allows it) has no visit to show.
        var moveOnly = await InsertPlaceAsync(cs, userName: "Move only");
        await InsertSegmentAsync(cs, "move", Utc(2026, 10, 22, 8), Utc(2026, 10, 22, 9), D(2026, 10, 22), D(2026, 10, 22), mode: "walk", placeId: moveOnly);

        foreach (var (id, survivor, seconds) in new[] { (lonely, lonely, 3600L), (child, lonely, 3600L), (root, root, 3 * 3600L), (middle, root, 3 * 3600L), (leaf, root, 3 * 3600L) })
        {
            using var body = await GetPlaceAsync(client, id);
            Assert.True(survivor == body.RootElement.GetProperty("id").GetInt64(), $"{id} gave {body.RootElement.GetProperty("id").GetInt64()}, not {survivor}");
            Assert.Equal(seconds, body.RootElement.GetProperty("totalSeconds").GetInt64());
            Assert.Equal(1, body.RootElement.GetProperty("visits").GetInt32());
            Assert.Equal(1, body.RootElement.GetProperty("recentVisits").GetArrayLength());
        }

        Assert.Equal(HttpStatusCode.NotFound, await StatusOfAsync(client, $"/api/places/{hollow}"));
        Assert.Equal(HttpStatusCode.NotFound, await StatusOfAsync(client, $"/api/places/{hollowChild}"));
        Assert.Equal(HttpStatusCode.NotFound, await StatusOfAsync(client, $"/api/places/{moveOnly}"));

        // A segment of the survivor's own adds to the time of the places merged into it.
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 24, 6), Utc(2026, 10, 24, 8), D(2026, 10, 24), D(2026, 10, 24), placeId: lonely);
        foreach (var id in new[] { lonely, child })
        {
            using var body = await GetPlaceAsync(client, id);
            Assert.Equal(lonely, body.RootElement.GetProperty("id").GetInt64());
            Assert.Equal(3 * 3600, body.RootElement.GetProperty("totalSeconds").GetInt64());
            Assert.Equal(2, body.RootElement.GetProperty("visits").GetInt32());
        }
    }

    [Fact]
    public async Task Place_recent_visits_capped_at_50()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await InsertPlaceAsync(cs, userName: "Home");
        // 60 visits of an hour, one on each of the 60 days from 2026-08-01, added in the order of the days.
        var first = new DateOnly(2026, 8, 1);
        for (var k = 0; k < 60; k++)
        {
            var day = first.AddDays(k);
            await InsertSegmentAsync(cs, "stay", new DateTime(day.Year, day.Month, day.Day, 8, 0, 0, DateTimeKind.Utc),
                new DateTime(day.Year, day.Month, day.Day, 9, 0, 0, DateTimeKind.Utc), day, day, placeId: place);
        }

        using var body = await GetPlaceAsync(client, place);

        var root = body.RootElement;
        // The totals are over all the visits, the list is the latest 50, newest first: the 60th day down to the 11th.
        Assert.Equal(60, root.GetProperty("visits").GetInt32());
        Assert.Equal(60 * 3600, root.GetProperty("totalSeconds").GetInt64());
        Assert.Equal("2026-08-01T08:00:00Z", root.GetProperty("firstVisit").GetString());
        Assert.Equal("2026-09-29T08:00:00Z", root.GetProperty("lastVisit").GetString());
        var dates = root.GetProperty("recentVisits").EnumerateArray().Select(v => v.GetProperty("date").GetString()).ToList();
        Assert.Equal(50, dates.Count);
        Assert.Equal(Enumerable.Range(10, 50).Reverse().Select(k => first.AddDays(k).ToString("yyyy-MM-dd")), dates);
    }

    [Fact]
    public async Task Place_recent_visits_of_a_merged_group_are_the_latest_of_all_of_it()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var survivor = await InsertPlaceAsync(cs, userName: "Survivor");
        var absorbed = await InsertPlaceAsync(cs, userName: "Absorbed", mergedInto: survivor);
        // 30 visits at each, the days alternating between them: the latest 50 take from both.
        var first = new DateOnly(2026, 8, 1);
        for (var k = 0; k < 60; k++)
        {
            var day = first.AddDays(k);
            await InsertSegmentAsync(cs, "stay", new DateTime(day.Year, day.Month, day.Day, 8, 0, 0, DateTimeKind.Utc),
                new DateTime(day.Year, day.Month, day.Day, 9, 0, 0, DateTimeKind.Utc), day, day, placeId: k % 2 == 0 ? survivor : absorbed);
        }

        using var body = await GetPlaceAsync(client, absorbed);

        var root = body.RootElement;
        Assert.Equal(survivor, root.GetProperty("id").GetInt64());
        Assert.Equal(60, root.GetProperty("visits").GetInt32());
        Assert.Equal(50, root.GetProperty("recentVisits").GetArrayLength());
        Assert.Equal("2026-09-29", root.GetProperty("recentVisits")[0].GetProperty("date").GetString());
        Assert.Equal("2026-08-11", root.GetProperty("recentVisits")[49].GetProperty("date").GetString());
    }

    [Fact]
    public async Task Place_rejects_an_id_that_is_not_a_positive_whole_number()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await InsertPlaceAsync(cs);
        await InsertSegmentAsync(cs, "stay", Utc(2026, 10, 22, 6), Utc(2026, 10, 22, 7), D(2026, 10, 22), D(2026, 10, 22), placeId: place);

        foreach (var id in new[] { "abc", "0", "-1", "1.5", "+1", "%201", "1%20", "1e3", "0x10", "99999999999999999999", "%EF%BC%91" })
        {
            var status = await StatusOfAsync(client, $"/api/places/{id}");
            Assert.True(status == HttpStatusCode.BadRequest, $"/api/places/{id} gave {(int)status}");
        }

        Assert.Equal(HttpStatusCode.OK, await StatusOfAsync(client, $"/api/places/{place}"));
    }
}
