using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using Npgsql;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;
using Sporer.Testing;
using Sporer.Timeline;
using static Sporer.Api.Tests.TripSeeder;

namespace Sporer.Api.Tests;

/// <summary>
/// What the owner does to places: naming one (<c>PUT /api/places/{id}/name</c>), merging one into another
/// (<c>POST /api/places/{id}/merge</c>), separating them again (<c>DELETE /api/places/{id}/merged/{other}</c>) and looking for a place
/// to merge with (<c>GET /api/places/{id}/candidates</c>). A name is the owner's own and is shown in place of OpenStreetMap's wherever
/// the place is, so it is set on the one row of the place that survives merges and is read from there. A merge only sets
/// <c>merged_into_id</c>: the stays keep the place they were given, and what is read follows the merges.
/// </summary>
[Collection("db")]
public class RenameMergeTests(DatabaseFixture db)
{
    private const string Lisbon = "Europe/Lisbon";

    private static readonly TimeSpan Every10s = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan Every2min = TimeSpan.FromMinutes(2);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Task<HttpResponseMessage> RenameAsync(HttpClient client, object id, string? name) =>
        client.PutAsJsonAsync($"/api/places/{id}/name", new { name }, Ct);

    private static async Task<JsonDocument> JsonOf(HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{response.RequestMessage?.RequestUri} gave {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text);
    }

    private static async Task<JsonDocument> GetAsync(HttpClient client, string url) => await JsonOf(await client.GetAsync(url, Ct));

    private static Task<string?> UserNameAsync(string cs, long place) =>
        Sql.ScalarAsync<string?>(cs, "select user_name from place where id = @place", new { place }, Ct);

    /// <summary>A place that is on the timeline (one stay at it), so that it can be asked for.</summary>
    private static async Task<long> OnTheTimelineAsync(
        string cs, string? userName = null, string? osmName = null, long? mergedInto = null, int day = 22)
    {
        var place = await TimelineSeeder.InsertPlaceAsync(cs, userName: userName, osmName: osmName, mergedInto: mergedInto);
        await TimelineSeeder.InsertSegmentAsync(
            cs, "stay", Utc(10, day, 6), Utc(10, day, 7), D(10, day), D(10, day), placeId: place);
        return place;
    }

    // ---- the name is shown wherever the place is ---------------------------------------------------------------------

    [Fact]
    public async Task Rename_sets_the_name_everywhere()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // starting the host runs the migrations
        var hotel = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal", osmName: "Hotel Avenida");
        var market = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 500, 500), "Lisbon", "Portugal", osmName: "Mercado da Ribeira");
        await StoreAsync(api,
            [Stay(D(9, 12), hotel, Spots.Lisbon), Stay(D(9, 13), hotel, Spots.Lisbon)], [],
            Trip(D(9, 12), D(9, 13), Utc(9, 12, 8), Utc(9, 14, 10)));
        await StayAsync(cs, hotel, Utc(9, 12, 13), Utc(9, 13, 8));
        await StayAsync(cs, market, Utc(9, 13, 8, 20), Utc(9, 13, 10, 20));
        await StayAsync(cs, hotel, Utc(9, 13, 12), Utc(9, 14, 7));

        // The name of the market as each of the views gives it: its place, the day, a range with the day in it, and the line of the
        // trip's day where it is a highlight (the hotel is where the nights were spent, so it is not one).
        async Task<string?[]> NamesAsync()
        {
            using var place = await GetAsync(client, $"/api/places/{market}");
            using var day = await GetAsync(client, "/api/day/2026-09-13");
            using var range = await GetAsync(client, "/api/range?from=2026-09-13&to=2026-09-13");
            using var trip = await GetAsync(client, "/api/trips/2026-09-12");

            var onTheDay = day.RootElement.GetProperty("segments").EnumerateArray()
                .Where(s => s.GetProperty("kind").GetString() == "stay" && s.GetProperty("place").GetProperty("id").GetInt64() == market)
                .Select(s => s.GetProperty("place").GetProperty("name").GetString())
                .Single();
            var inTheRange = range.RootElement.GetProperty("places").EnumerateArray()
                .Where(p => p.GetProperty("id").GetInt64() == market)
                .Select(p => p.GetProperty("name").GetString())
                .Single();
            var highlights = trip.RootElement.GetProperty("days")[1].GetProperty("highlights").EnumerateArray().Select(h => h.GetString()).Single();
            return [place.RootElement.GetProperty("name").GetString(), onTheDay, inTheRange, highlights];
        }

        Assert.All(await NamesAsync(), name => Assert.Equal("Mercado da Ribeira", name));

        using var renamed = await JsonOf(await RenameAsync(client, market, "Time Out Market"));

        Assert.Equal("Time Out Market", renamed.RootElement.GetProperty("name").GetString());
        Assert.All(await NamesAsync(), name => Assert.Equal("Time Out Market", name));
        Assert.Equal("Time Out Market", await UserNameAsync(cs, market));
    }

    [Fact]
    public async Task Rename_answers_with_the_place_detail()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await TimelineSeeder.InsertPlaceAsync(cs, osmName: "OpenStreetMap's name", address: "1 Main St", city: "Oslo", country: "Norway", lat: 59.5, lon: 10.5);
        await TimelineSeeder.InsertSegmentAsync(cs, "stay", Utc(10, 22, 6), Utc(10, 22, 8), D(10, 22), D(10, 22), placeId: place);
        await TimelineSeeder.InsertSegmentAsync(cs, "stay", Utc(10, 25, 10), Utc(10, 25, 11), D(10, 25), D(10, 25), placeId: place);

        using var renamed = await JsonOf(await RenameAsync(client, place, "Mine"));

        // Exactly what GET /api/places/{id} says, the new name in it.
        using var read = await GetAsync(client, $"/api/places/{place}");
        Assert.Equal(read.RootElement.GetRawText(), renamed.RootElement.GetRawText());
        Assert.Equal("Mine", read.RootElement.GetProperty("name").GetString());
        Assert.Equal(3 * 3600, read.RootElement.GetProperty("totalSeconds").GetInt64());
        Assert.Equal(2, read.RootElement.GetProperty("visits").GetInt32());
    }

    [Fact]
    public async Task Rename_of_a_merged_id_names_the_survivor()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        // Merged in two steps, and each with a stay: the place that stands for them all is the survivor, whichever id is used.
        var survivor = await OnTheTimelineAsync(cs, userName: "Survivor's old name", osmName: "Survivor OSM", day: 22);
        var middle = await OnTheTimelineAsync(cs, userName: "Middle", mergedInto: survivor, day: 23);
        var absorbed = await OnTheTimelineAsync(cs, userName: "Absorbed", mergedInto: middle, day: 24);

        using var renamed = await JsonOf(await RenameAsync(client, absorbed, "New name"));

        Assert.Equal(survivor, renamed.RootElement.GetProperty("id").GetInt64());
        Assert.Equal("New name", renamed.RootElement.GetProperty("name").GetString());
        Assert.Equal(3, renamed.RootElement.GetProperty("visits").GetInt32()); // the survivor's, with the stays of those merged into it
        Assert.Equal("New name", await UserNameAsync(cs, survivor));
        Assert.Equal("Middle", await UserNameAsync(cs, middle)); // the names of the others are left as they are
        Assert.Equal("Absorbed", await UserNameAsync(cs, absorbed));
        foreach (var id in new[] { survivor, middle, absorbed })
        {
            using var read = await GetAsync(client, $"/api/places/{id}");
            Assert.Equal("New name", read.RootElement.GetProperty("name").GetString());
        }
    }

    [Fact]
    public async Task Rename_while_a_merge_lands_names_the_survivor()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        _ = api.Services; // starting the host runs the migrations
        var survivor = await OnTheTimelineAsync(cs, osmName: "Survivor OSM", day: 22);
        var merging = await OnTheTimelineAsync(cs, userName: "Merging", day: 23);
        var places = api.Services.GetRequiredService<PlaceStore>();

        // A merge of the place that is not committed yet: the rename does not see it, finds the place to be a survivor, and waits for
        // the row that it is about to name. When the merge commits, the place is no longer one, and the name must not stay on it.
        await using var merger = new NpgsqlConnection(cs);
        await merger.OpenAsync(Ct);
        await using var merge = await merger.BeginTransactionAsync(Ct);
        await using (var command = new NpgsqlCommand("update place set merged_into_id = @survivor where id = @merging", merger, merge))
        {
            command.Parameters.AddWithValue("survivor", survivor);
            command.Parameters.AddWithValue("merging", merging);
            await command.ExecuteNonQueryAsync(Ct);
        }

        var rename = places.RenameAsync(merging, "New name", Ct);
        var until = DateTime.UtcNow.AddSeconds(20);
        while (await Sql.ScalarAsync<long>(cs,
                   "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'", ct: Ct) == 0)
        {
            Assert.False(rename.IsCompleted, "the rename did not wait for the merge");
            Assert.True(DateTime.UtcNow < until, "timed out waiting for the rename to wait for the row");
            await Task.Delay(20, Ct);
        }
        await merge.CommitAsync(Ct);

        var named = await rename;

        Assert.NotNull(named);
        Assert.Equal(survivor, named.Id);
        Assert.Equal("New name", named.Name);
        Assert.Equal("New name", await UserNameAsync(cs, survivor));
        Assert.Equal("Merging", await UserNameAsync(cs, merging)); // the place that was merged is as it was
    }

    // ---- the name's own rules ----------------------------------------------------------------------------------------

    [Fact]
    public async Task Rename_empty_resets_to_the_osm_name()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs, osmName: "OpenStreetMap's name");

        // Nothing, an empty name and one of spaces all mean "back to the automatic name".
        foreach (var reset in new string?[] { null, "", "   ", " \t " })
        {
            await RenameAsync(client, place, "Mine");
            Assert.Equal("Mine", await UserNameAsync(cs, place));

            using var renamed = await JsonOf(await RenameAsync(client, place, reset));

            Assert.Equal("OpenStreetMap's name", renamed.RootElement.GetProperty("name").GetString());
            Assert.Null(await UserNameAsync(cs, place));
        }

        // A place OpenStreetMap has not named is left with no name at all.
        var unnamed = await OnTheTimelineAsync(cs, userName: "Mine", day: 23);
        using var none = await JsonOf(await RenameAsync(client, unnamed, ""));
        Assert.Equal(JsonValueKind.Null, none.RootElement.GetProperty("name").ValueKind);
        Assert.Null(await UserNameAsync(cs, unnamed));
    }

    [Fact]
    public async Task Rename_trims_the_name_and_allows_exactly_100_characters()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs);

        using var trimmed = await JsonOf(await RenameAsync(client, place, "  \tTime Out Market \n"));
        Assert.Equal("Time Out Market", trimmed.RootElement.GetProperty("name").GetString());
        Assert.Equal("Time Out Market", await UserNameAsync(cs, place));

        // The length is that of the name as it is kept: the spaces around it do not count.
        var longest = new string('x', 100);
        using var accepted = await JsonOf(await RenameAsync(client, place, $"  {longest}  "));
        Assert.Equal(longest, accepted.RootElement.GetProperty("name").GetString());
        Assert.Equal(longest, await UserNameAsync(cs, place));
    }

    [Fact]
    public async Task Rename_too_long_is_400()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs, userName: "Mine");

        using var response = await RenameAsync(client, place, new string('x', 101));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("Mine", await UserNameAsync(cs, place)); // not shortened, not set
    }

    [Fact]
    public async Task Rename_with_a_body_that_is_not_a_name_is_400()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs, userName: "Mine");

        foreach (var body in new[] { """{"name":5}""", """{"name":["a"]}""", "not json", "[" })
        {
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            using var response = await client.PutAsync($"/api/places/{place}/name", content, Ct);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"{body} gave {(int)response.StatusCode}");
        }

        Assert.Equal("Mine", await UserNameAsync(cs, place));
    }

    [Fact]
    public async Task Rename_without_a_name_is_400()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs, userName: "Mine");

        // Taking the name back is asked for with "name": null. A body that says nothing of it is no such request.
        var bodies = new (string What, string Body)[]
        {
            ("an empty object", "{}"), ("an empty body", ""), ("another property", """{"nom":"x"}"""), ("an array", "[]"),
        };
        foreach (var (what, body) in bodies)
        {
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            using var response = await client.PutAsync($"/api/places/{place}/name", content, Ct);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"{what} gave {(int)response.StatusCode}");
        }

        Assert.Equal("Mine", await UserNameAsync(cs, place));

        using var reset = await client.PutAsync(
            $"/api/places/{place}/name", new StringContent("""{"name":null}""", Encoding.UTF8, "application/json"), Ct);
        Assert.Equal(HttpStatusCode.OK, reset.StatusCode);
        Assert.Null(await UserNameAsync(cs, place));
    }

    [Fact]
    public async Task Rename_does_not_take_the_name_from_the_query()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs, osmName: "OpenStreetMap's name");

        // The body says "no name"; a query that says another is no part of the request.
        using var response = await client.PutAsJsonAsync($"/api/places/{place}/name?name=Hacked", new { name = (string?)null }, Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Null(await UserNameAsync(cs, place));
    }

    // ---- which place -------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Rename_unknown_is_404()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await OnTheTimelineAsync(cs);
        // A place that exists, but is on no day: no segment shows it, as with the place's own view.
        var orphan = await TimelineSeeder.InsertPlaceAsync(cs, osmName: "Left behind");

        using var unknown = await RenameAsync(client, 999_999, "Mine");
        using var notOnTheTimeline = await RenameAsync(client, orphan, "Mine");

        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, notOnTheTimeline.StatusCode);
        Assert.Null(await UserNameAsync(cs, orphan));
    }

    [Fact]
    public async Task Rename_rejects_an_id_that_is_not_a_positive_whole_number()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs);

        foreach (var id in new[] { "abc", "0", "-1", "1.5", "+1", "%201", "1%20", "1e3", "99999999999999999999" })
        {
            using var response = await client.PutAsJsonAsync($"/api/places/{id}/name", new { name = "Mine" }, Ct);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"/api/places/{id}/name gave {(int)response.StatusCode}");
        }

        Assert.Null(await UserNameAsync(cs, place));
    }

    // ---- the name outlasts the timeline ------------------------------------------------------------------------------

    private static readonly DateTime Day = new(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc);

    /// <summary>Home 1 h -> walk to the cafe -> cafe 25 min -> cycle to the office -> office 8 h, starting 07:00 UTC on a day of October.</summary>
    private static List<TrackPoint> CommuteDay(int day) => new TrackBuilder(Day.AddDays(day).AddHours(7), Spots.Home)
        .Stay(TimeSpan.FromHours(1), Every2min)
        .Travel(Spots.Cafe, 5, Every10s)
        .Stay(TimeSpan.FromMinutes(25), Every2min)
        .Travel(Spots.Office, 18, Every10s)
        .Stay(TimeSpan.FromHours(8), Every2min)
        .Build();

    /// <summary>Runs passes of the worker until one finds nothing to do: the backfill is finished.</summary>
    private static async Task FinishBackfillAsync(ApiFactory api)
    {
        var worker = api.Services.GetRequiredService<TimelineWorker>();
        for (var pass = 0; await worker.RunOnceAsync(Ct); pass++)
            Assert.True(pass < 100, "the worker keeps finding work");
    }

    [Fact]
    public async Task Rename_survives_a_rebuild()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(Day.AddDays(22)));

        long office;
        string firstVersion;
        await using (var first = new ApiFactory(cs, time: clock))
        {
            var client = first.CreateClient(); // starting the host runs the migrations
            await PointSeeder.InsertAsync(cs, Enumerable.Range(0, 3).SelectMany(CommuteDay), Ct);
            await FinishBackfillAsync(first);
            office = await Sql.ScalarAsync<long>(cs, "select place_id from segment where kind = 'stay' order by start_utc desc limit 1", ct: Ct);
            firstVersion = (await Sql.ScalarAsync<string>(cs, "select algorithm_version from processing_state where id = 1", ct: Ct))!;

            using var renamed = await JsonOf(await RenameAsync(client, office, "My office"));
            Assert.Equal("My office", renamed.RootElement.GetProperty("name").GetString());
        }
        var places = await Sql.ScalarAsync<long>(cs, "select count(*) from place", ct: Ct);
        Assert.Equal(3, places);

        // Another algorithm version: the segments, nights and trips are cleared and the timeline is built again from the points.
        clock.Advance(TimeSpan.FromHours(1));
        await using var second = new ApiFactory(cs, new Dictionary<string, string?> { ["Detection:StayRadiusMeters"] = "150" }, clock);
        var client2 = second.CreateClient();
        await FinishBackfillAsync(second);

        Assert.NotEqual(firstVersion, await Sql.ScalarAsync<string>(cs, "select algorithm_version from processing_state where id = 1", ct: Ct));
        Assert.Equal(3, await Sql.ScalarAsync<long>(cs, "select count(distinct place_id) from segment where kind = 'stay'", ct: Ct)); // it was rebuilt
        Assert.Equal(places, await Sql.ScalarAsync<long>(cs, "select count(*) from place", ct: Ct));
        Assert.Equal("My office", await UserNameAsync(cs, office));
        using var place = await GetAsync(client2, $"/api/places/{office}");
        Assert.Equal("My office", place.RootElement.GetProperty("name").GetString());
        using var day = await GetAsync(client2, "/api/day/2026-10-01");
        var names = day.RootElement.GetProperty("segments").EnumerateArray()
            .Where(s => s.GetProperty("kind").GetString() == "stay")
            .Select(s => s.GetProperty("place").GetProperty("name").GetString());
        Assert.Equal([null, null, "My office"], names);
    }

    // ---- merge -------------------------------------------------------------------------------------------------------

    private static Task<HttpResponseMessage> MergeAsync(HttpClient client, object id, object body) =>
        client.PostAsJsonAsync($"/api/places/{id}/merge", body, Ct);

    private static Task<HttpResponseMessage> MergeAsync(HttpClient client, object id, long place, string? name) =>
        MergeAsync(client, id, new { place, name });

    private static Task<HttpResponseMessage> SeparateAsync(HttpClient client, object id, object other) =>
        client.DeleteAsync($"/api/places/{id}/merged/{other}", Ct);

    private static Task<long?> MergedIntoAsync(string cs, long place) =>
        Sql.ScalarAsync<long?>(cs, "select merged_into_id from place where id = @place", new { place }, Ct);

    private static async Task<HttpStatusCode> PostRawAsync(HttpClient client, string url, string body)
    {
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        using var response = await client.PostAsync(url, content, Ct);
        return response.StatusCode;
    }

    /// <summary>
    /// The hotel (two long stays) and the market (one of two hours) of Lisbon, 500 m apart, each as OpenStreetMap names it: the market
    /// is visited on the 13th between the hotel's two stays.
    /// </summary>
    private static async Task<(long Hotel, long Market)> HotelAndMarketAsync(string cs)
    {
        var hotel = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal", osmName: "Hotel Avenida");
        var market = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 500, 500), "Lisbon", "Portugal", osmName: "Mercado da Ribeira");
        await StayAsync(cs, hotel, Utc(9, 12, 13), Utc(9, 13, 8));
        await StayAsync(cs, market, Utc(9, 13, 8, 20), Utc(9, 13, 10, 20));
        await StayAsync(cs, hotel, Utc(9, 13, 12), Utc(9, 14, 7));
        return (hotel, market);
    }

    /// <summary>The ids of the places the stays of a day are at, in the order the day gives them.</summary>
    private static async Task<long[]> StayPlacesOfDayAsync(HttpClient client, string date)
    {
        using var day = await GetAsync(client, $"/api/day/{date}");
        return [.. day.RootElement.GetProperty("segments").EnumerateArray()
            .Where(s => s.GetProperty("kind").GetString() == "stay")
            .Select(s => s.GetProperty("place").GetProperty("id").GetInt64())];
    }

    [Fact]
    public async Task Merge_moves_visits_and_keeps_the_chosen_name()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // starting the host runs the migrations
        var (hotel, market) = await HotelAndMarketAsync(cs);

        // What there is before: two places, and what each of the views says of them.
        Assert.Equal([hotel, market, hotel], await StayPlacesOfDayAsync(client, "2026-09-13"));
        double hotelSeconds, marketSeconds;
        int hotelVisits, marketVisits;
        using (var range = await GetAsync(client, "/api/range?from=2026-09-13&to=2026-09-13"))
        {
            var places = range.RootElement.GetProperty("places").EnumerateArray().ToDictionary(p => p.GetProperty("id").GetInt64());
            Assert.Equal(2, places.Count);
            (hotelSeconds, hotelVisits) = (places[hotel].GetProperty("seconds").GetDouble(), places[hotel].GetProperty("visits").GetInt32());
            (marketSeconds, marketVisits) = (places[market].GetProperty("seconds").GetDouble(), places[market].GetProperty("visits").GetInt32());
        }
        using (var before = await GetAsync(client, $"/api/places/{market}"))
        {
            Assert.Equal(1, before.RootElement.GetProperty("visits").GetInt32());
            Assert.Equal(2 * 3600, before.RootElement.GetProperty("totalSeconds").GetInt64());
        }

        // The market is merged into the hotel, which is the place the owner is on, and the owner chose the market's name to keep.
        using var merged = await JsonOf(await MergeAsync(client, hotel, market, "Mercado da Ribeira"));

        // The answer is the survivor's detail, as GET gives it, with the new name and all the time spent at both.
        using var read = await GetAsync(client, $"/api/places/{hotel}");
        Assert.Equal(read.RootElement.GetRawText(), merged.RootElement.GetRawText());
        Assert.Equal(hotel, merged.RootElement.GetProperty("id").GetInt64());
        Assert.Equal("Mercado da Ribeira", merged.RootElement.GetProperty("name").GetString());
        Assert.Equal(3, merged.RootElement.GetProperty("visits").GetInt32());
        Assert.Equal((19 + 19 + 2) * 3600, merged.RootElement.GetProperty("totalSeconds").GetInt64());
        Assert.Equal("2026-09-12T13:00:00Z", merged.RootElement.GetProperty("firstVisit").GetString());
        Assert.Equal("2026-09-13T12:00:00Z", merged.RootElement.GetProperty("lastVisit").GetString());
        Assert.Equal(3, merged.RootElement.GetProperty("recentVisits").GetArrayLength());

        // Only the merge was written: the stays keep the place they were given, the survivor has the chosen name, the other place its own.
        Assert.Equal(hotel, await MergedIntoAsync(cs, market));
        Assert.Null(await MergedIntoAsync(cs, hotel));
        Assert.Equal("Mercado da Ribeira", await UserNameAsync(cs, hotel));
        Assert.Null(await UserNameAsync(cs, market));
        Assert.Equal(1, await Sql.ScalarAsync<long>(cs, "select count(*) from segment where place_id = @market", new { market }, Ct));

        // The day, the range and the place read all of it as the one place.
        Assert.Equal([hotel, hotel, hotel], await StayPlacesOfDayAsync(client, "2026-09-13"));
        using (var range = await GetAsync(client, "/api/range?from=2026-09-13&to=2026-09-13"))
        {
            var place = Assert.Single(range.RootElement.GetProperty("places").EnumerateArray());
            Assert.Equal(hotel, place.GetProperty("id").GetInt64());
            Assert.Equal("Mercado da Ribeira", place.GetProperty("name").GetString());
            Assert.Equal(hotelSeconds + marketSeconds, place.GetProperty("seconds").GetDouble());
            Assert.Equal(hotelVisits + marketVisits, place.GetProperty("visits").GetInt32());
        }
        using (var viaTheMergedId = await GetAsync(client, $"/api/places/{market}"))
            Assert.Equal(read.RootElement.GetRawText(), viaTheMergedId.RootElement.GetRawText());

        // No name in the body: the survivor keeps the one it has. (A third place, at no stay of the others.)
        var annex = await OnTheTimelineAsync(cs, userName: "Annex", day: 15);
        using var kept = await JsonOf(await MergeAsync(client, hotel, new { place = annex }));
        Assert.Equal("Mercado da Ribeira", kept.RootElement.GetProperty("name").GetString());
        Assert.Equal(4, kept.RootElement.GetProperty("visits").GetInt32());
        Assert.Equal("Mercado da Ribeira", await UserNameAsync(cs, hotel));
        Assert.Equal("Annex", await UserNameAsync(cs, annex));
    }

    [Fact]
    public async Task Merge_answers_with_the_places_merged_into_the_survivor()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var survivor = await OnTheTimelineAsync(cs, osmName: "Survivor", day: 22);
        var first = await OnTheTimelineAsync(cs, osmName: "First", day: 23);
        var second = await OnTheTimelineAsync(cs, userName: "Second, by the owner", osmName: "Second", day: 24);
        var unnamed = await OnTheTimelineAsync(cs, day: 25);
        var viaFirst = await OnTheTimelineAsync(cs, osmName: "Merged into the first", day: 26);

        using (var before = await GetAsync(client, $"/api/places/{survivor}"))
            Assert.Empty(before.RootElement.GetProperty("merged").EnumerateArray());

        foreach (var place in new[] { first, second, unnamed })
            (await MergeAsync(client, survivor, place, null)).Dispose();
        (await MergeAsync(client, first, viaFirst, null)).Dispose(); // by the id of a place merged on: the survivor's

        // The places merged directly into it, each by its id and its name, which is the owner's, else OpenStreetMap's, else none. They are
        // listed by that name (see Merged_places_are_listed_by_name_then_id); the one with none comes last.
        using var detail = await GetAsync(client, $"/api/places/{survivor}");
        var merged = detail.RootElement.GetProperty("merged").EnumerateArray().ToList();
        Assert.Equal(["id", "name"], merged[0].EnumerateObject().Select(p => p.Name));
        Assert.Equal([first, viaFirst, second, unnamed], merged.Select(m => m.GetProperty("id").GetInt64()));
        Assert.Equal(["First", "Merged into the first", "Second, by the owner", null], merged.Select(m => m.GetProperty("name").GetString()));
        Assert.Equal(JsonValueKind.Null, merged[3].GetProperty("name").ValueKind);
        Assert.Equal(5, detail.RootElement.GetProperty("visits").GetInt32());
        // A place merged by the id of a place that was merged on is merged into the survivor, not into the one in the middle.
        Assert.Equal(survivor, await MergedIntoAsync(cs, viaFirst));
    }

    [Fact]
    public async Task Merged_places_are_listed_by_name_then_id()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var survivor = await OnTheTimelineAsync(cs, osmName: "Survivor", day: 22);

        // Merged in an order that is not the order of their names. The name is the one that shows: the owner's, else OpenStreetMap's.
        async Task<long> MergedAsync(string? userName, string? osmName)
            => await TimelineSeeder.InsertPlaceAsync(cs, userName: userName, osmName: osmName, mergedInto: survivor);
        var banana = await MergedAsync(null, "banana");
        var cherry = await MergedAsync("Cherry", "Aardvark"); // the owner's name wins: it sorts as "Cherry", not as "Aardvark"
        var none = await MergedAsync(null, null);
        var dupFirst = await MergedAsync(null, "Dup");
        var apple = await MergedAsync(null, "Apple");
        var lowerApple = await MergedAsync(null, "apple"); // the case makes no difference to the order, so the ids decide
        var dupSecond = await MergedAsync("Dup", null);

        using var detail = await GetAsync(client, $"/api/places/{survivor}");

        var merged = detail.RootElement.GetProperty("merged").EnumerateArray().ToList();
        Assert.Equal([apple, lowerApple, banana, cherry, dupFirst, dupSecond, none], merged.Select(m => m.GetProperty("id").GetInt64()));
        Assert.Equal(["Apple", "apple", "banana", "Cherry", "Dup", "Dup", null], merged.Select(m => m.GetProperty("name").GetString()));
    }

    [Fact]
    public async Task Merge_chain_reads_as_the_last_survivor()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var a = await OnTheTimelineAsync(cs, osmName: "A", day: 21);
        var b = await OnTheTimelineAsync(cs, osmName: "B", day: 22);
        var c = await OnTheTimelineAsync(cs, osmName: "C", day: 23);
        var d = await OnTheTimelineAsync(cs, osmName: "D", day: 24);
        var e = await OnTheTimelineAsync(cs, osmName: "E", day: 25);

        // B into A, then A (the survivor of B) into C: B -> A -> C.
        (await JsonOf(await MergeAsync(client, a, b, null))).Dispose();
        using var chained = await JsonOf(await MergeAsync(client, c, a, null));
        Assert.Equal(c, chained.RootElement.GetProperty("id").GetInt64());
        Assert.Equal(3, chained.RootElement.GetProperty("visits").GetInt32());
        Assert.Equal(c, await MergedIntoAsync(cs, a));
        Assert.Equal(a, await MergedIntoAsync(cs, b)); // the middle of the chain is as it was

        foreach (var id in new[] { a, b, c })
        {
            using var read = await GetAsync(client, $"/api/places/{id}");
            Assert.Equal(c, read.RootElement.GetProperty("id").GetInt64());
            Assert.Equal("C", read.RootElement.GetProperty("name").GetString());
            Assert.Equal(3, read.RootElement.GetProperty("visits").GetInt32());
            // The places merged directly into C: A. B is merged into A.
            Assert.Equal([a], read.RootElement.GetProperty("merged").EnumerateArray().Select(m => m.GetProperty("id").GetInt64()));
        }
        Assert.Equal([c], await RangePlaceIdsAsync(client, "2026-10-21", "2026-10-23"));

        // Both ids of a merge stand for their survivors: D joins the chain at its end (the id given is B, which is C's), and the chain's
        // survivor itself is merged into E (the place given is B, whose survivor is C).
        using var intoTheChain = await JsonOf(await MergeAsync(client, b, d, null));
        Assert.Equal(c, intoTheChain.RootElement.GetProperty("id").GetInt64());
        Assert.Equal(c, await MergedIntoAsync(cs, d));
        using var chainMerged = await JsonOf(await MergeAsync(client, e, b, null));
        Assert.Equal(e, chainMerged.RootElement.GetProperty("id").GetInt64());
        Assert.Equal(5, chainMerged.RootElement.GetProperty("visits").GetInt32());
        Assert.Equal(e, await MergedIntoAsync(cs, c));
        Assert.Equal(a, await MergedIntoAsync(cs, b)); // the places in between are never touched
        Assert.Null(await MergedIntoAsync(cs, e));
        foreach (var id in new[] { a, b, c, d, e })
        {
            using var read = await GetAsync(client, $"/api/places/{id}");
            Assert.Equal(e, read.RootElement.GetProperty("id").GetInt64());
        }
    }

    [Fact]
    public async Task Merge_into_itself_is_409()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var (hotel, market) = await HotelAndMarketAsync(cs);

        using var itself = await MergeAsync(client, hotel, hotel, "Renamed");
        Assert.Equal(HttpStatusCode.Conflict, itself.StatusCode);
        Assert.Null(await UserNameAsync(cs, hotel)); // nothing was written, the name neither

        (await MergeAsync(client, hotel, market, null)).Dispose();

        // The same survivor on both sides, whichever id of each is used.
        foreach (var (id, place) in new[] { (hotel, market), (market, hotel), (market, market), (hotel, hotel) })
        {
            using var again = await MergeAsync(client, id, place, "Renamed");
            Assert.True(again.StatusCode == HttpStatusCode.Conflict, $"merge {place} into {id} gave {(int)again.StatusCode}");
        }

        Assert.Equal(hotel, await MergedIntoAsync(cs, market));
        Assert.Null(await MergedIntoAsync(cs, hotel));
        Assert.Null(await UserNameAsync(cs, hotel));
    }

    [Fact]
    public async Task Merge_unknown_is_404()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var place = await OnTheTimelineAsync(cs, osmName: "On the timeline");
        // A place that exists, but is on no day: no segment shows it, as with the place's own view.
        var orphan = await TimelineSeeder.InsertPlaceAsync(cs, osmName: "Left behind");

        var cases = new (string What, long Id, long Other)[]
        {
            ("an unknown place to merge into", 999_999, place), ("an unknown place to merge", place, 999_999),
            ("a place that is on no day, to merge into", orphan, place), ("a place that is on no day, to merge", place, orphan),
            ("two unknown places", 999_998, 999_999),
        };
        foreach (var (what, id, other) in cases)
        {
            using var response = await MergeAsync(client, id, other, "Renamed");
            Assert.True(response.StatusCode == HttpStatusCode.NotFound, $"{what} gave {(int)response.StatusCode}");
        }

        Assert.Equal(0, await Sql.ScalarAsync<long>(cs, "select count(*) from place where merged_into_id is not null", ct: Ct));
        Assert.Null(await UserNameAsync(cs, place));
    }

    [Fact]
    public async Task Merge_rejects_a_request_that_is_not_valid()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var survivor = await OnTheTimelineAsync(cs, userName: "Mine", day: 22);
        var other = await OnTheTimelineAsync(cs, day: 23);

        // The place is needed, and is a positive whole number; the name is text.
        var bodies = new[]
        {
            "", "{}", "[]", "not json", """{"name":"x"}""", """{"place":null}""", """{"place":0}""", """{"place":-3}""",
            """{"place":"abc"}""", """{"place":1.5}""", """{"place":[1]}""", """{"place":{}}""",
            $$"""{"place":{{other}},"name":5}""", $$"""{"place":{{other}},"name":["a"]}""",
            $$"""{"place":{{other}},"name":"{{new string('x', 101)}}"}""",
        };
        foreach (var body in bodies)
        {
            var status = await PostRawAsync(client, $"/api/places/{survivor}/merge", body);
            Assert.True(status == HttpStatusCode.BadRequest, $"{body} gave {(int)status}");
        }

        // The id is a positive whole number too.
        foreach (var id in new[] { "abc", "0", "-1", "1.5", "+1", "1e3", "99999999999999999999" })
        {
            var status = await PostRawAsync(client, $"/api/places/{id}/merge", $$"""{"place":{{other}}}""");
            Assert.True(status == HttpStatusCode.BadRequest, $"/api/places/{id}/merge gave {(int)status}");
        }

        // The body is the whole of the request: a place or a name in the query is no part of it.
        Assert.Equal(HttpStatusCode.BadRequest, await PostRawAsync(client, $"/api/places/{survivor}/merge?place={other}", "{}"));
        using (var ok = await client.PostAsJsonAsync($"/api/places/{survivor}/merge?name=Hacked&place=999999", new { place = other }, Ct))
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Equal("Mine", await UserNameAsync(cs, survivor));
        Assert.Equal(survivor, await MergedIntoAsync(cs, other));
    }

    [Fact]
    public async Task Merge_name_is_trimmed_and_empty_means_the_automatic_one()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var survivor = await OnTheTimelineAsync(cs, userName: "Mine", osmName: "OpenStreetMap's name", day: 22);

        async Task<JsonDocument> MergeNewAsync(object? name, int day)
        {
            var other = await OnTheTimelineAsync(cs, day: day);
            return await JsonOf(await MergeAsync(client, survivor, new Dictionary<string, object?> { ["place"] = other, ["name"] = name }));
        }

        using (var trimmed = await MergeNewAsync("  \tTime Out Market \n", 23))
            Assert.Equal("Time Out Market", trimmed.RootElement.GetProperty("name").GetString());
        Assert.Equal("Time Out Market", await UserNameAsync(cs, survivor));

        var longest = new string('x', 100);
        using (var accepted = await MergeNewAsync($"  {longest}  ", 24))
            Assert.Equal(longest, accepted.RootElement.GetProperty("name").GetString());

        // "name": null keeps the name, and so does a body with none (that is the test above).
        using (var kept = await MergeNewAsync(null, 25))
            Assert.Equal(longest, kept.RootElement.GetProperty("name").GetString());

        // A name that is empty once trimmed is the one the app makes: OpenStreetMap's shows again.
        using (var reset = await MergeNewAsync("   ", 26))
            Assert.Equal("OpenStreetMap's name", reset.RootElement.GetProperty("name").GetString());
        Assert.Null(await UserNameAsync(cs, survivor));

        // A name that is too long is turned away before anything is merged.
        var late = await OnTheTimelineAsync(cs, day: 27);
        using var tooLong = await MergeAsync(client, survivor, late, new string('x', 101));
        Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
        Assert.Null(await MergedIntoAsync(cs, late));
    }

    [Fact]
    public async Task Merged_place_response_id_differs_from_route_id()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var (hotel, market) = await HotelAndMarketAsync(cs);
        (await JsonOf(await MergeAsync(client, hotel, market, null))).Dispose();

        // The place asked for is a merged one: the answer is the place it stands for, and says so with its id.
        using var viaTheMerged = await GetAsync(client, $"/api/places/{market}");
        Assert.Equal(hotel, viaTheMerged.RootElement.GetProperty("id").GetInt64());
        Assert.NotEqual(market, viaTheMerged.RootElement.GetProperty("id").GetInt64());

        // So are the answers of the writes, whichever id they were asked with.
        using var named = await JsonOf(await RenameAsync(client, market, "Hotel and market"));
        Assert.Equal(hotel, named.RootElement.GetProperty("id").GetInt64());
        var other = await OnTheTimelineAsync(cs, day: 20);
        using var merged = await JsonOf(await MergeAsync(client, market, other, null));
        Assert.Equal(hotel, merged.RootElement.GetProperty("id").GetInt64());
        Assert.Equal(4, merged.RootElement.GetProperty("visits").GetInt32());
    }

    // ---- separate ----------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Separate_restores_both_places()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var (hotel, market) = await HotelAndMarketAsync(cs);
        string hotelBefore, marketBefore;
        using (var before = await GetAsync(client, $"/api/places/{hotel}"))
            hotelBefore = before.RootElement.GetRawText();
        using (var before = await GetAsync(client, $"/api/places/{market}"))
            marketBefore = before.RootElement.GetRawText();
        (await JsonOf(await MergeAsync(client, hotel, market, null))).Dispose();
        Assert.Equal([hotel, hotel, hotel], await StayPlacesOfDayAsync(client, "2026-09-13"));

        using var separated = await SeparateAsync(client, hotel, market);

        Assert.Equal(HttpStatusCode.NoContent, separated.StatusCode);
        Assert.Equal(string.Empty, await separated.Content.ReadAsStringAsync(Ct));
        Assert.Null(await MergedIntoAsync(cs, market));
        // Each is the place it was: its own stays and its own name, and the day shows them apart again.
        Assert.Equal([hotel, market, hotel], await StayPlacesOfDayAsync(client, "2026-09-13"));
        using (var after = await GetAsync(client, $"/api/places/{market}"))
            Assert.Equal(marketBefore, after.RootElement.GetRawText());
        using (var after = await GetAsync(client, $"/api/places/{hotel}"))
        {
            Assert.Equal(hotelBefore, after.RootElement.GetRawText());
            Assert.Empty(after.RootElement.GetProperty("merged").EnumerateArray());
        }
        Assert.Equal([hotel, market], await RangePlaceIdsAsync(client, "2026-09-13", "2026-09-13"));

        // And they can be merged again.
        using var again = await MergeAsync(client, market, hotel, null);
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
        Assert.Equal(market, await MergedIntoAsync(cs, hotel));
    }

    [Fact]
    public async Task Separate_leaves_the_name_chosen_at_the_merge_with_the_survivor()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var survivor = await OnTheTimelineAsync(cs, userName: "Survivor's own", day: 22);
        var absorbed = await OnTheTimelineAsync(cs, userName: "Absorbed's own", day: 23);
        (await JsonOf(await MergeAsync(client, survivor, absorbed, "The name chosen"))).Dispose();

        (await SeparateAsync(client, survivor, absorbed)).Dispose();

        // The merge named the survivor, and nothing remembers what the name was: the places are separate, each with the name it has now.
        Assert.Equal("The name chosen", await UserNameAsync(cs, survivor));
        Assert.Equal("Absorbed's own", await UserNameAsync(cs, absorbed));
    }

    [Fact]
    public async Task Separate_a_place_not_merged_here_is_404()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var a = await OnTheTimelineAsync(cs, osmName: "A", day: 21);
        var b = await OnTheTimelineAsync(cs, osmName: "B", day: 22);
        var c = await OnTheTimelineAsync(cs, osmName: "C", day: 23);
        var lone = await OnTheTimelineAsync(cs, osmName: "Merged into none", day: 24);
        (await MergeAsync(client, a, b, null)).Dispose(); // B into A
        (await MergeAsync(client, c, a, null)).Dispose(); // A into C: B -> A -> C

        var cases = new (string What, object Id, object Other)[]
        {
            ("a place that is not merged", c, lone), ("a place that is merged into no place at all", lone, a),
            ("a place merged into another place", b, c), ("a place merged indirectly", c, b),
            ("the place itself", c, c), ("a merged place from itself", a, a),
            ("an unknown place", c, 999_999), ("from an unknown place", 999_999, a),
        };
        foreach (var (what, id, other) in cases)
        {
            using var response = await SeparateAsync(client, id, other);
            Assert.True(response.StatusCode == HttpStatusCode.NotFound, $"{what} gave {(int)response.StatusCode}");
        }

        foreach (var (id, other) in new[] { ("abc", "1"), ("0", "1"), ("1", "abc"), ("1", "0"), ("1", "-1"), ("1", "1.5") })
        {
            using var response = await SeparateAsync(client, id, other);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"/api/places/{id}/merged/{other} gave {(int)response.StatusCode}");
        }

        // Nothing was separated: B -> A -> C.
        Assert.Equal(a, await MergedIntoAsync(cs, b));
        Assert.Equal(c, await MergedIntoAsync(cs, a));
        Assert.Null(await MergedIntoAsync(cs, lone));

        // Only a place merged directly into the place can be separated from it: A from C, which takes B with it.
        using var separated = await SeparateAsync(client, c, a);
        Assert.Equal(HttpStatusCode.NoContent, separated.StatusCode);
        Assert.Null(await MergedIntoAsync(cs, a));
        Assert.Equal(a, await MergedIntoAsync(cs, b));
        using (var read = await GetAsync(client, $"/api/places/{b}"))
            Assert.Equal(a, read.RootElement.GetProperty("id").GetInt64());
        using var twice = await SeparateAsync(client, c, a); // it is not merged here any more
        Assert.Equal(HttpStatusCode.NotFound, twice.StatusCode);
    }

    private static async Task<long[]> RangePlaceIdsAsync(HttpClient client, string from, string to)
    {
        using var range = await GetAsync(client, $"/api/range?from={from}&to={to}");
        return [.. range.RootElement.GetProperty("places").EnumerateArray().Select(p => p.GetProperty("id").GetInt64()).Order()];
    }

    [Fact]
    public async Task Merge_survives_a_rebuild_and_future_stays_go_to_the_survivor()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(Day.AddDays(22)));

        long home, cafe, office;
        await using (var first = new ApiFactory(cs, time: clock))
        {
            var client = first.CreateClient(); // starting the host runs the migrations
            await PointSeeder.InsertAsync(cs, Enumerable.Range(0, 3).SelectMany(CommuteDay), Ct);
            await FinishBackfillAsync(first);
            var stays = await Sql.QueryAsync<long>(cs, "select place_id from segment where kind = 'stay' order by start_utc limit 3", ct: Ct);
            (home, cafe, office) = (stays[0], stays[1], stays[2]);
            Assert.Equal(3, new[] { home, cafe, office }.Distinct().Count());

            // The cafe is merged into the office: the owner is on the office's page and chose its name.
            using var merged = await JsonOf(await MergeAsync(client, office, cafe, "Office and cafe"));
            Assert.Equal(office, merged.RootElement.GetProperty("id").GetInt64());
            Assert.Equal(6, merged.RootElement.GetProperty("visits").GetInt32()); // the office's three, and the cafe's three
        }

        // Another algorithm version: the segments, nights and trips are cleared and the timeline is built again from the points.
        // The places are not, and a stay at the cafe is now a stay at the office, which is the place the cafe's centre stands for.
        clock.Advance(TimeSpan.FromHours(1));
        await using var second = new ApiFactory(cs, new Dictionary<string, string?> { ["Detection:StayRadiusMeters"] = "150" }, clock);
        var client2 = second.CreateClient();
        await FinishBackfillAsync(second);

        Assert.Equal(3, await Sql.ScalarAsync<long>(cs, "select count(*) from place", ct: Ct)); // the merge was kept, and no place was made
        Assert.Equal(office, await MergedIntoAsync(cs, cafe));
        Assert.Equal([home, office, office, home, office, office, home, office, office],
            await Sql.QueryAsync<long>(cs, "select place_id from segment where kind = 'stay' order by start_utc", ct: Ct));
        Assert.Equal("Office and cafe", await UserNameAsync(cs, office));

        // Stays that come later are matched the same way: three days more, none of them at a place of their own.
        await PointSeeder.InsertAsync(cs, Enumerable.Range(3, 3).SelectMany(CommuteDay), Ct);
        await second.Services.GetRequiredService<ITimelineProcessor>().ReprocessAsync(Day.AddDays(3), Day.AddDays(7), Ct);

        Assert.Equal(3, await Sql.ScalarAsync<long>(cs, "select count(*) from place", ct: Ct));
        Assert.Equal(
            [home, office, office, home, office, office, home, office, office, home, office, office, home, office, office, home, office, office],
            await Sql.QueryAsync<long>(cs, "select place_id from segment where kind = 'stay' order by start_utc", ct: Ct));
        // The day of the 5th: the stay at the office that began the evening before, and the three of the day (the cafe's is the office's).
        Assert.Equal([office, home, office, office], await StayPlacesOfDayAsync(client2, "2026-10-05"));
        using var place = await GetAsync(client2, $"/api/places/{cafe}");
        Assert.Equal(office, place.RootElement.GetProperty("id").GetInt64());
        Assert.Equal(12, place.RootElement.GetProperty("visits").GetInt32()); // two stays a day, over six days
    }

    // ---- when the homes and trips cannot be worked out ---------------------------------------------------------------

    /// <summary>The Error entries of what is logged, as <see cref="EditRecompute"/> writes them when a recompute fails.</summary>
    private sealed class ErrorLog : ILoggerProvider
    {
        private readonly ConcurrentQueue<(string Category, string Message, Exception? Exception)> _errors = new();

        public IReadOnlyCollection<(string Category, string Message, Exception? Exception)> Errors => _errors;

        public ILogger CreateLogger(string categoryName) => new Capture(categoryName, _errors);

        public void Dispose()
        {
        }

        private sealed class Capture(string category, ConcurrentQueue<(string, string, Exception?)> errors) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            {
                if (logLevel >= LogLevel.Error)
                    errors.Enqueue((category, formatter(state, exception), exception));
            }
        }
    }

    private static ApiFactory ApiWithAFailingRefresher(string cs, ErrorLog log, TimeProvider? time = null, FailingRefresher? refresher = null)
        => new(cs, time: time, configureServices: services =>
        {
            services.RemoveAll<ITripRefresher>();
            services.AddSingleton<ITripRefresher>(refresher ?? new FailingRefresher());
            services.AddSingleton<ILoggerProvider>(log);
        });

    [Fact]
    public async Task Merge_whose_recompute_fails_still_answers_200_and_leaves_the_homes_and_trips_to_the_worker()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var log = new ErrorLog();
        var refresher = new FailingRefresher();
        await using var api = ApiWithAFailingRefresher(cs, log, refresher: refresher);
        var client = api.CreateClient();
        var (hotel, market) = await HotelAndMarketAsync(cs);
        await StoreAsync(api, [Stay(D(9, 12), hotel, Spots.Lisbon), Stay(D(9, 13), market, Geo.Offset(Spots.Lisbon, 500, 500))], []);
        var trips = api.Services.GetRequiredService<TripStore>();
        Assert.Null(await trips.TakePendingAsync(Ct));

        using var merged = await JsonOf(await MergeAsync(client, hotel, market, "Both"));

        // The edit is done, and says so.
        Assert.Equal(1, refresher.Recomputes);
        Assert.Equal(hotel, merged.RootElement.GetProperty("id").GetInt64());
        Assert.Equal("Both", merged.RootElement.GetProperty("name").GetString());
        Assert.Equal(hotel, await MergedIntoAsync(cs, market));
        // The failure is logged as an error, with what failed.
        var error = Assert.Single(log.Errors);
        Assert.IsType<InvalidOperationException>(error.Exception);
        Assert.Equal(typeof(EditRecompute).FullName, error.Category);
        // And the worker is asked to work the homes and trips out on its next pass: a window of the day of the latest stored night.
        Assert.Equal((Utc(9, 13), Utc(9, 13)), await trips.TakePendingAsync(Ct));
    }

    [Fact]
    public async Task Merge_whose_recompute_fails_with_no_night_stored_asks_the_worker_for_today()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var log = new ErrorLog();
        var now = new DateTimeOffset(2026, 10, 28, 12, 30, 0, TimeSpan.Zero);
        await using var api = ApiWithAFailingRefresher(cs, log, new FakeTimeProvider(now));
        var client = api.CreateClient();
        var (hotel, market) = await HotelAndMarketAsync(cs);

        using var merged = await MergeAsync(client, hotel, market, null);

        Assert.Equal(HttpStatusCode.OK, merged.StatusCode);
        Assert.Equal(hotel, await MergedIntoAsync(cs, market));
        Assert.Single(log.Errors);
        Assert.Equal((now.UtcDateTime, now.UtcDateTime), await api.Services.GetRequiredService<TripStore>().TakePendingAsync(Ct));
    }

    [Fact]
    public async Task Separate_whose_recompute_fails_still_answers_204_and_leaves_the_homes_and_trips_to_the_worker()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var log = new ErrorLog();
        await using var api = ApiWithAFailingRefresher(cs, log);
        var client = api.CreateClient();
        var (hotel, market) = await HotelAndMarketAsync(cs);
        await StoreAsync(api, [Stay(D(9, 12), hotel, Spots.Lisbon), Stay(D(9, 13), hotel, Spots.Lisbon)], []);
        await Sql.ExecAsync(cs, "update place set merged_into_id = @hotel where id = @market", new { hotel, market }, Ct);

        using var separated = await SeparateAsync(client, hotel, market);

        Assert.Equal(HttpStatusCode.NoContent, separated.StatusCode);
        Assert.Null(await MergedIntoAsync(cs, market));
        Assert.Single(log.Errors);
        Assert.Equal((Utc(9, 13), Utc(9, 13)), await api.Services.GetRequiredService<TripStore>().TakePendingAsync(Ct));
    }

    // ---- candidates --------------------------------------------------------------------------------------------------

    private sealed record Candidate(long Id, string? Name, string? Address, double DistanceM, int Visits);

    private static async Task<IReadOnlyList<Candidate>> CandidatesAsync(HttpClient client, object id, string? q = null)
    {
        var url = $"/api/places/{id}/candidates" + (q is null ? "" : $"?q={Uri.EscapeDataString(q)}");
        using var body = await GetAsync(client, url);
        Assert.Equal(JsonValueKind.Array, body.RootElement.ValueKind);
        return [.. body.RootElement.EnumerateArray().Select(c =>
        {
            Assert.Equal(["id", "name", "address", "distanceM", "visits"], c.EnumerateObject().Select(p => p.Name));
            return new Candidate(
                c.GetProperty("id").GetInt64(), c.GetProperty("name").GetString(), c.GetProperty("address").GetString(),
                c.GetProperty("distanceM").GetDouble(), c.GetProperty("visits").GetInt32());
        })];
    }

    /// <summary>A place at <paramref name="at"/> with <paramref name="stays"/> stays, one a day from the 1st of November.</summary>
    private static async Task<long> VisitedAsync(
        string cs, GeoPoint at, string? osmName = null, string? userName = null, string? address = null, int stays = 1, long? mergedInto = null)
    {
        var place = await TimelineSeeder.InsertPlaceAsync(
            cs, userName: userName, osmName: osmName, address: address, lat: at.Latitude, lon: at.Longitude, mergedInto: mergedInto);
        for (var i = 0; i < stays; i++)
            await StayAsync(cs, place, Utc(11, 1 + i, 9), Utc(11, 1 + i, 10));
        return place;
    }

    [Fact]
    public async Task Candidates_nearest_first_and_by_name()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var here = Spots.Lisbon;
        var me = await VisitedAsync(cs, here, osmName: "Hotel Avenida", address: "Avenida da Liberdade 1");
        var far = await VisitedAsync(cs, Geo.Offset(here, -900, 0), osmName: "Livraria", address: "Rua do Cafe 7");
        var near = await VisitedAsync(cs, Geo.Offset(here, 100, 0), osmName: "Cafe Central", address: "Rua Augusta 10, Lisbon");
        var mid = await VisitedAsync(cs, Geo.Offset(here, 0, 300), userName: "Mercado", osmName: "Cafe Mercado", address: "Rua da Prata 3");
        var unnamed = await VisitedAsync(cs, Geo.Offset(here, 0, -400));
        // Not candidates: a place merged into another (its stays count for the other's visits: 1 + 2 for `near`), a place merged into this
        // one, a place no stay shows, and a place that is only a position.
        await VisitedAsync(cs, Geo.Offset(here, 50, 0), osmName: "Old Cafe", stays: 2, mergedInto: near);
        var annex = await VisitedAsync(cs, Geo.Offset(here, 20, 20), osmName: "Hotel Annex", mergedInto: me);
        await TimelineSeeder.InsertPlaceAsync(cs, osmName: "Left behind", lat: here.Latitude, lon: here.Longitude);

        // No query: all of them, the nearest first.
        var all = await CandidatesAsync(client, me);
        Assert.Equal([near, mid, unnamed, far], all.Select(c => c.Id));
        Assert.Equal(["Cafe Central", "Mercado", null, "Livraria"], all.Select(c => c.Name)); // the owner's name wins over OpenStreetMap's
        Assert.Equal(["Rua Augusta 10, Lisbon", "Rua da Prata 3", null, "Rua do Cafe 7"], all.Select(c => c.Address));
        Assert.Equal([3, 1, 1, 1], all.Select(c => c.Visits));
        Assert.Equal(
            [Geo.DistanceMeters(here, Geo.Offset(here, 100, 0)), Geo.DistanceMeters(here, Geo.Offset(here, 0, 300)),
             Geo.DistanceMeters(here, Geo.Offset(here, 0, -400)), Geo.DistanceMeters(here, Geo.Offset(here, -900, 0))],
            all.Select(c => c.DistanceM), (expected, actual) => Math.Abs(expected - actual) < 0.001);

        // A query: those whose name, as it shows, or whose address contains it, whatever the case, the nearest first. "Cafe Mercado" is
        // OpenStreetMap's name for the place the owner calls "Mercado": it is not found by it.
        Assert.Equal([near, far], (await CandidatesAsync(client, me, "CAFE")).Select(c => c.Id));
        Assert.Equal([near, far], (await CandidatesAsync(client, me, "cafe")).Select(c => c.Id));
        Assert.Equal([mid], (await CandidatesAsync(client, me, "  mercado ")).Select(c => c.Id));
        Assert.Equal([near, mid, far], (await CandidatesAsync(client, me, "rua")).Select(c => c.Id)); // the addresses
        Assert.Equal([near], (await CandidatesAsync(client, me, "10, l")).Select(c => c.Id));
        Assert.Equal(all.Select(c => c.Id), (await CandidatesAsync(client, me, "")).Select(c => c.Id)); // no query
        Assert.Equal(all.Select(c => c.Id), (await CandidatesAsync(client, me, "   ")).Select(c => c.Id));
        Assert.Empty(await CandidatesAsync(client, me, "no such place"));
        // What a query means is text, not a pattern.
        Assert.Empty(await CandidatesAsync(client, me, "%"));
        Assert.Empty(await CandidatesAsync(client, me, "_"));
        Assert.Empty(await CandidatesAsync(client, me, "\\"));

        // Asked of a place that was merged into this one: the same list, for the place it stands for.
        Assert.Equal(all.Select(c => c.Id), (await CandidatesAsync(client, annex)).Select(c => c.Id));
        // Asked of `near`, which has a place merged into it: neither it nor that one is in the list, and the hotel is.
        var fromNear = await CandidatesAsync(client, near);
        Assert.Equal(new[] { me, mid, unnamed, far }.Order(), fromNear.Select(c => c.Id).Order());
        Assert.Equal(Geo.DistanceMeters(Geo.Offset(here, 100, 0), here), fromNear.Single(c => c.Id == me).DistanceM, 3);
    }

    [Fact]
    public async Task Candidates_are_at_most_twenty_of_the_nearest()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var me = await VisitedAsync(cs, Spots.Lisbon, osmName: "Me");
        var others = new List<long>();
        // Added from the farthest to the nearest, so that the order of the ids is not the order that is asked for.
        for (var i = 25; i >= 1; i--)
            others.Add(await VisitedAsync(cs, Geo.Offset(Spots.Lisbon, 100 * i, 0), osmName: $"Place {i}"));
        others.Reverse(); // the nearest first

        var candidates = await CandidatesAsync(client, me);

        Assert.Equal(20, candidates.Count);
        Assert.Equal(others.Take(20), candidates.Select(c => c.Id));
        Assert.Equal(others.Take(20).Count(), (await CandidatesAsync(client, me, "Place")).Count);
        Assert.Equal([others[24]], (await CandidatesAsync(client, me, "Place 25")).Select(c => c.Id)); // beyond the nearest 20, and found
    }

    [Fact]
    public async Task Candidates_of_an_unknown_place_is_404_and_of_an_id_that_is_not_one_400()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await VisitedAsync(cs, Spots.Lisbon, osmName: "A place");
        var orphan = await TimelineSeeder.InsertPlaceAsync(cs, osmName: "Left behind");

        foreach (var id in new object[] { 999_999, orphan })
        {
            using var response = await client.GetAsync($"/api/places/{id}/candidates", Ct);
            Assert.True(response.StatusCode == HttpStatusCode.NotFound, $"{id} gave {(int)response.StatusCode}");
        }

        foreach (var id in new[] { "abc", "0", "-1", "1.5", "99999999999999999999" })
        {
            using var response = await client.GetAsync($"/api/places/{id}/candidates", Ct);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"/api/places/{id}/candidates gave {(int)response.StatusCode}");
        }
    }

    // ---- two merges at once ------------------------------------------------------------------------------------------

    /// <summary>How many sessions of the database wait for a lock a transaction of the test holds.</summary>
    private static Task<long> LockWaitersAsync(string cs) => Sql.ScalarAsync<long>(cs,
        "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'", ct: Ct);

    private static async Task WaitForLockWaitersAsync(string cs, int count, params Task[] notDone)
    {
        var until = DateTime.UtcNow.AddSeconds(20);
        while (await LockWaitersAsync(cs) < count)
        {
            Assert.All(notDone, task => Assert.False(task.IsCompleted, "the request did not wait for the lock"));
            Assert.True(DateTime.UtcNow < until, "timed out waiting for the request to wait for the row");
            await Task.Delay(20, Ct);
        }
    }

    [Fact]
    public async Task Merges_in_opposite_directions_make_no_cycle_while_one_is_waiting_for_the_other()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var a = await OnTheTimelineAsync(cs, osmName: "A", day: 22);
        var b = await OnTheTimelineAsync(cs, osmName: "B", day: 23);

        // A merge of A into B that is not committed yet. It holds both places, and the other merge (B into A) has found, as far as it can
        // see, two places that are their own survivors, so it asks for both and waits.
        await using var merger = new NpgsqlConnection(cs);
        await merger.OpenAsync(Ct);
        await using var merge = await merger.BeginTransactionAsync(Ct);
        await using (var lockRows = new NpgsqlCommand("select id from place where id in (@a, @b) order by id for update", merger, merge))
        {
            lockRows.Parameters.AddWithValue("a", a);
            lockRows.Parameters.AddWithValue("b", b);
            await lockRows.ExecuteNonQueryAsync(Ct);
        }
        await using (var set = new NpgsqlCommand("update place set merged_into_id = @b where id = @a", merger, merge))
        {
            set.Parameters.AddWithValue("a", a);
            set.Parameters.AddWithValue("b", b);
            await set.ExecuteNonQueryAsync(Ct);
        }

        var opposite = MergeAsync(client, a, b, "B into A");
        await WaitForLockWaitersAsync(cs, 1, opposite);
        await merge.CommitAsync(Ct);

        // The other merge now finds A merged into B: the same survivor on both sides. It does not turn it round into a cycle.
        using var response = await opposite;
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(b, await MergedIntoAsync(cs, a));
        Assert.Null(await MergedIntoAsync(cs, b));
        Assert.Null(await UserNameAsync(cs, a)); // and it named nothing
        Assert.Null(await UserNameAsync(cs, b));
    }

    [Fact]
    public async Task Merges_in_opposite_directions_at_once_leave_one_survivor_each()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var pairs = new List<(long A, long B)>();
        for (var i = 0; i < 12; i++)
            pairs.Add((await OnTheTimelineAsync(cs, day: 1 + i), await OnTheTimelineAsync(cs, day: 14 + i)));

        // Each pair is merged both ways at once, and all the pairs together.
        var attempts = pairs.SelectMany(p => new[]
        {
            (Pair: p, Response: Task.Run(() => MergeAsync(client, p.A, p.B, null))), // B into A
            (Pair: p, Response: Task.Run(() => MergeAsync(client, p.B, p.A, null))), // A into B
        }).ToList();
        await Task.WhenAll(attempts.Select(a => a.Response));

        foreach (var pair in pairs)
        {
            var statuses = new List<HttpStatusCode>();
            foreach (var attempt in attempts.Where(a => a.Pair == pair))
            {
                using var response = await attempt.Response;
                statuses.Add(response.StatusCode);
            }

            // One wins. The other finds the same survivor on both sides, and so no cycle is made.
            Assert.Equal([HttpStatusCode.OK, HttpStatusCode.Conflict], statuses.Order());
            var (a, b) = (await MergedIntoAsync(cs, pair.A), await MergedIntoAsync(cs, pair.B));
            Assert.True((a == pair.B && b is null) || (b == pair.A && a is null), $"places {pair.A} and {pair.B} are merged into {a} and {b}");
        }
    }

    /// <summary>A stay at <paramref name="place"/>, with the local dates of its start and end in Lisbon.</summary>
    private static Task<long> StayAsync(string cs, long place, DateTime start, DateTime end) =>
        TimelineSeeder.InsertSegmentAsync(
            cs, "stay", start, end, LocalTime.LocalDate(start, Lisbon), LocalTime.LocalDate(end, Lisbon), Lisbon, placeId: place);
}
