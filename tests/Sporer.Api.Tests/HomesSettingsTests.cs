using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;
using Sporer.Testing;
using Sporer.Timeline;
using static Sporer.Api.Tests.TripSeeder;

namespace Sporer.Api.Tests;

/// <summary>
/// What the owner says about homes and about how far away a night must be to be a trip (<c>/api/homes</c>, <c>/api/settings</c>), and
/// retrying what failed (<c>POST /api/status/retry</c>). The trips are detected for real, from stays, by the refresher, so that what
/// a home or a setting does is what it does to the trips the app has: three nights away in July, from a long stay at home.
/// </summary>
[Collection("db")]
public class HomesSettingsTests(DatabaseFixture db)
{
    private const string Oslo = "Europe/Oslo";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed record Seeded(long Home, long Away);

    private static Task<long> StayAsync(string cs, DateTime start, DateTime end, long place, GeoPoint at)
        => TimelineSeeder.InsertSegmentAsync(cs, "stay", start, end, LocalTime.LocalDate(start, Oslo), LocalTime.LocalDate(end, Oslo),
            Oslo, placeId: place, lat: at.Latitude, lon: at.Longitude);

    /// <summary>
    /// The stays of the timeline: at home from 31 March to 9 July at 07:00 Oslo time, away until the 12th at 08:00, and at home again until
    /// the 15th. That is 100 nights at home, the nights of 9, 10 and 11 July away, and three more at home.
    /// </summary>
    private static async Task SeedStaysAsync(string cs, long home, long away, GeoPoint awayAt)
    {
        await StayAsync(cs, Utc(3, 31, 12), Utc(7, 9, 7), home, Spots.Home);
        await StayAsync(cs, Utc(7, 9, 12), Utc(7, 12, 8), away, awayAt);
        await StayAsync(cs, Utc(7, 12, 14), Utc(7, 15, 12), home, Spots.Home);
    }

    private static async Task<Seeded> SeedAsync(string cs, ApiFactory api, GeoPoint awayAt)
    {
        var home = await PlaceAsync(cs, Spots.Home, city: "Oslo", country: "Norway", userName: "Home");
        var away = await PlaceAsync(cs, awayAt, city: "Lisbon", country: "Portugal", osmName: "Hotel Avenida");
        await SeedStaysAsync(cs, home, away, awayAt);
        await api.Services.GetRequiredService<ITripRefresher>().RefreshAsync(Utc(4, 1), Utc(7, 15, 12), Ct);
        return new Seeded(home, away);
    }

    private static Task RefreshAsync(ApiFactory api) => api.Services.GetRequiredService<ITripRefresher>().RefreshAsync(Utc(4, 1), Utc(7, 15, 12), Ct);

    private static async Task<JsonDocument> JsonOf(HttpResponseMessage response, HttpStatusCode expected = HttpStatusCode.OK)
    {
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == expected, $"{response.RequestMessage?.Method} {response.RequestMessage?.RequestUri} gave {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text);
    }

    private static async Task AssertStatus(HttpStatusCode expected, HttpResponseMessage response, string what)
    {
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == expected, $"{what} gave {(int)response.StatusCode}: {text}");
        if (expected is HttpStatusCode.BadRequest or HttpStatusCode.Conflict)
            Assert.True(JsonDocument.Parse(text).RootElement.GetProperty("errors").EnumerateObject().Any(), $"{what}: {text}"); // FastEndpoints' error body
    }

    /// <summary>A body with exactly the <c>Content-Type</c> application/json, whatever it says.</summary>
    private static StringContent Json(string body) => new(body, Encoding.UTF8, "application/json");

    private static Task<HttpResponseMessage> PostHomeAsync(HttpClient client, object body) => client.PostAsJsonAsync("/api/homes", body, Ct);

    private static async Task<List<JsonElement>> TripsAsync(HttpClient client)
    {
        using var body = await JsonOf(await client.GetAsync("/api/trips", Ct));
        return [.. body.RootElement.GetProperty("trips").EnumerateArray().Select(t => t.Clone())];
    }

    private static async Task<List<JsonElement>> HomesAsync(HttpClient client)
    {
        using var body = await JsonOf(await client.GetAsync("/api/homes", Ct));
        return [.. body.RootElement.GetProperty("periods").EnumerateArray().Select(t => t.Clone())];
    }

    private static (long PlaceId, string? Name, string From, string? To, string Source) Shown(JsonElement period) => (
        period.GetProperty("placeId").GetInt64(), period.GetProperty("placeName").GetString(), period.GetProperty("from").GetString()!,
        period.GetProperty("to").GetString(), period.GetProperty("source").GetString()!);

    private sealed record HomeRow(long Id, long PlaceId, string From, string? To, string Source);

    private static Task<IReadOnlyList<HomeRow>> HomeRowsAsync(string cs) => Sql.QueryAsync<HomeRow>(cs,
        "select id as Id, place_id as PlaceId, from_date::text as \"From\", to_date::text as \"To\", source as Source from home_period order by from_date, id", ct: Ct);

    private static async Task<IReadOnlyList<HomeRow>> UserRowsAsync(string cs) => [.. (await HomeRowsAsync(cs)).Where(r => r.Source == "user")];

    private static Task<double?> SettingAsync(string cs) => Sql.ScalarAsync<double?>(cs,
        "select (value #>> '{}')::double precision from app_setting where key = 'tripMinDistanceKm'", ct: Ct);

    private static async Task<(double Value, double Default)> SettingsAsync(HttpClient client)
    {
        using var body = await JsonOf(await client.GetAsync("/api/settings", Ct));
        return (body.RootElement.GetProperty("tripMinDistanceKm").GetDouble(), body.RootElement.GetProperty("tripMinDistanceKmDefault").GetDouble());
    }

    /// <summary>
    /// Takes the lock that the nights, homes and trips are written under, as a refresh does while it works, and holds it until
    /// <see cref="ReleaseAsync"/>.
    /// </summary>
    private static async Task<NpgsqlTransaction> HoldTheLockAsync(string cs)
    {
        var connection = new NpgsqlConnection(cs);
        await connection.OpenAsync(Ct);
        var transaction = await connection.BeginTransactionAsync(Ct);
        await using var command = new NpgsqlCommand("select pg_advisory_xact_lock(@key)", connection, transaction);
        command.Parameters.AddWithValue("key", TripRefresher.AdvisoryLockKey);
        await command.ExecuteNonQueryAsync(Ct);
        return transaction;
    }

    private static async Task ReleaseAsync(NpgsqlTransaction transaction)
    {
        var connection = transaction.Connection!;
        await transaction.CommitAsync(Ct);
        await connection.DisposeAsync();
    }

    /// <summary>Whether the worker is asked to work the homes and trips out, which is then done with: the window that waits is emptied.</summary>
    private static async Task<bool> TookPendingAsync(TripStore store)
    {
        if (await store.TakePendingAsync(Ct) is not { } window)
            return false;
        await store.ClearPendingAsync(window.From, window.To, Ct);
        return true;
    }

    private static async Task<HttpResponseMessage> PutSettingAsync(HttpClient client, string tripMinDistanceKm)
        => await client.PutAsync("/api/settings", Json($$"""{"tripMinDistanceKm":{{tripMinDistanceKm}}}"""), Ct);

    // ---- a home the owner sets -------------------------------------------------------------------------------------------

    [Fact]
    public async Task User_home_period_wins_and_survives_a_rebuild()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var (home, lisbon) = await SeedAsync(cs, api, Spots.Lisbon);
        Assert.Equal(["2026-07-09"], (await TripsAsync(client)).Select(t => t.GetProperty("id").GetString()));

        // The owner says that they lived in Lisbon from the 9th to the 11th: those nights are at home, not a trip.
        using var created = await JsonOf(await PostHomeAsync(client, new { placeId = lisbon, from = "2026-07-09", to = "2026-07-11" }), HttpStatusCode.Created);
        var id = created.RootElement.GetProperty("id").GetInt64();
        Assert.Equal((lisbon, "Hotel Avenida", "2026-07-09", "2026-07-11", "user"), Shown(created.RootElement));
        Assert.Empty(await TripsAsync(client));

        // The list has the detected home as detection found it, and the owner's, in date order.
        var homes = await HomesAsync(client);
        var expected = new (long PlaceId, string? Name, string From, string? To, string Source)[]
        {
            (home, "Home", "2026-03-31", null, "detected"), (lisbon, "Hotel Avenida", "2026-07-09", "2026-07-11", "user"),
        };
        Assert.Equal(expected, homes.Select(Shown));
        Assert.Equal(id, homes[1].GetProperty("id").GetInt64());
        Assert.NotEqual(id, homes[0].GetProperty("id").GetInt64());

        // A refresh that builds the nights again leaves the owner's row alone, and the trips are still worked out against it.
        await RefreshAsync(api);
        Assert.Equal([new HomeRow(id, lisbon, "2026-07-09", "2026-07-11", "user")], await UserRowsAsync(cs));
        Assert.Empty(await TripsAsync(client));

        // So does the rebuild of the whole timeline, which deletes everything derived: the owner's home is still there when the nights come back.
        await api.Services.GetRequiredService<ProcessingQueue>().RestartBackfillAsync("a new version", Utc(1, 1), Utc(10, 28), Ct);
        Assert.Equal([new HomeRow(id, lisbon, "2026-07-09", "2026-07-11", "user")], await HomeRowsAsync(cs));
        Assert.Empty(await TripsAsync(client));
        await SeedStaysAsync(cs, home, lisbon, Spots.Lisbon);
        await RefreshAsync(api);
        Assert.Empty(await TripsAsync(client));
        Assert.Equal(["detected", "user"], (await HomeRowsAsync(cs)).Select(r => r.Source));

        // Taken back, the nights in Lisbon are a trip again.
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/homes/{id}", Ct)).StatusCode);
        Assert.Empty(await UserRowsAsync(cs));
        Assert.Equal(["2026-07-09"], (await TripsAsync(client)).Select(t => t.GetProperty("id").GetString()));
    }

    [Fact]
    public async Task User_home_period_with_no_end_runs_to_the_end_of_the_history()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var (_, lisbon) = await SeedAsync(cs, api, Spots.Lisbon);

        // Home is Lisbon from the 10th on: the night of the 9th, the first away night, is still a trip, as are the ones from the 12th at Oslo.
        using var created = await JsonOf(await PostHomeAsync(client, new { placeId = lisbon, from = "2026-07-10", to = (string?)null }), HttpStatusCode.Created);

        Assert.Equal(JsonValueKind.Null, created.RootElement.GetProperty("to").ValueKind); // there, and null
        var trips = await TripsAsync(client);
        Assert.Equal(["2026-07-12", "2026-07-09"], trips.Select(t => t.GetProperty("id").GetString()));
        Assert.True(trips[0].GetProperty("ongoing").GetBoolean()); // the nights from the 12th are away from a home that goes on
        Assert.Equal("2026-07-09", trips[1].GetProperty("firstNight").GetString());
        Assert.Equal("2026-07-09", trips[1].GetProperty("lastNight").GetString());
    }

    [Fact]
    public async Task User_home_at_a_place_no_night_was_at_is_measured_from_where_it_is()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await SeedAsync(cs, api, Spots.Lisbon);
        var flatAt = Geo.Offset(Spots.Home, 7000, 0);
        var flat = await PlaceAsync(cs, flatAt, city: "Oslo", country: "Norway", osmName: "Flat");
        await StayAsync(cs, Utc(8, 1, 10), Utc(8, 1, 11), flat, flatAt); // on the timeline, and where no night was spent

        // The owner's home for the days of the trip is the flat in Oslo: Lisbon is as far from it as from the home that was found.
        await JsonOf(await PostHomeAsync(client, new { placeId = flat, from = "2026-07-09", to = "2026-07-11" }), HttpStatusCode.Created);

        Assert.Equal(["2026-07-09"], (await TripsAsync(client)).Select(t => t.GetProperty("id").GetString())); // away from a home that has a position
    }

    [Fact]
    public async Task Home_override_overlapping_user_period_is_409()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var (_, lisbon) = await SeedAsync(cs, api, Spots.Lisbon);
        var other = await PlaceAsync(cs, Geo.Offset(Spots.Home, 7000, 0), city: "Oslo", country: "Norway", osmName: "Flat");
        await StayAsync(cs, Utc(8, 1, 10), Utc(8, 1, 11), other, Geo.Offset(Spots.Home, 7000, 0)); // the place is on the timeline
        await JsonOf(await PostHomeAsync(client, new { placeId = lisbon, from = "2026-07-10", to = "2026-07-20" }), HttpStatusCode.Created);

        // Overlapping the owner's period: at either end, inside it, around it, or open at the end. Each shares a date with it.
        var overlapping = new (string From, string? To)[]
        {
            ("2026-07-01", "2026-07-10"), ("2026-07-20", "2026-07-25"), ("2026-07-12", "2026-07-13"), ("2026-07-01", "2026-07-31"),
            ("2026-07-15", null), ("2026-06-01", null),
        };
        foreach (var (from, to) in overlapping)
            await AssertStatus(HttpStatusCode.Conflict, await PostHomeAsync(client, new { placeId = other, from, to }), $"{from} to {to}");
        Assert.Single(await UserRowsAsync(cs));

        // Touching is not sharing, and a detected period overlapped is no conflict: the owner's wins. A closed one before an open one is fine too.
        using var after = await JsonOf(await PostHomeAsync(client, new { placeId = other, from = "2026-07-21", to = (string?)null }), HttpStatusCode.Created);
        using var before = await JsonOf(await PostHomeAsync(client, new { placeId = other, from = "2026-07-01", to = "2026-07-09" }), HttpStatusCode.Created);
        Assert.Equal(["2026-07-01", "2026-07-10", "2026-07-21"], (await UserRowsAsync(cs)).Select(r => r.From));
        Assert.Equal("2026-07-21", after.RootElement.GetProperty("from").GetString());
        Assert.Equal("2026-07-09", before.RootElement.GetProperty("to").GetString());
        Assert.Equal(["detected", "user", "user", "user"], (await HomesAsync(client)).Select(h => h.GetProperty("source").GetString()).Order());
    }

    [Fact]
    public async Task Home_override_with_a_body_that_is_not_one_is_400_and_an_unknown_place_is_404()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var (home, _) = await SeedAsync(cs, api, Spots.Lisbon);
        var onNoTimeline = await PlaceAsync(cs, Geo.Offset(Spots.Home, 9000, 0)); // a place with no segment: not a place in use

        var bad = new (string What, string Body)[]
        {
            ("from after to", $$"""{"placeId":{{home}},"from":"2026-07-12","to":"2026-07-11"}"""),
            ("no body at all", ""),
            ("an empty object", "{}"),
            ("a body that is not an object", "[]"),
            ("no placeId", """{"from":"2026-07-09","to":null}"""),
            ("a placeId of null", """{"placeId":null,"from":"2026-07-09","to":null}"""),
            ("a placeId of 0", """{"placeId":0,"from":"2026-07-09","to":null}"""),
            ("a negative placeId", """{"placeId":-3,"from":"2026-07-09","to":null}"""),
            ("a placeId that is text", """{"placeId":"abc","from":"2026-07-09","to":null}"""),
            ("a placeId that is not whole", $$"""{"placeId":{{home}}.5,"from":"2026-07-09","to":null}"""),
            ("no from", $$"""{"placeId":{{home}},"to":null}"""),
            ("a from of null", $$"""{"placeId":{{home}},"from":null,"to":null}"""),
            ("a from that is not yyyy-MM-dd", $$"""{"placeId":{{home}},"from":"2026-7-9","to":null}"""),
            ("a from with a time", $$"""{"placeId":{{home}},"from":"2026-07-09T00:00:00","to":null}"""),
            ("a from that is no date", $$"""{"placeId":{{home}},"from":"2026-02-30","to":null}"""),
            ("a from before 1970", $$"""{"placeId":{{home}},"from":"1969-12-31","to":null}"""),
            ("a to after 2099", $$"""{"placeId":{{home}},"from":"2026-07-09","to":"2100-01-01"}"""),
            ("a to that is not a date", $$"""{"placeId":{{home}},"from":"2026-07-09","to":"soon"}"""),
            ("no to", $$"""{"placeId":{{home}},"from":"2026-07-09"}"""),
        };
        foreach (var (what, body) in bad)
            await AssertStatus(HttpStatusCode.BadRequest, await client.PostAsync("/api/homes", Json(body), Ct), what);

        // What is in the query is no part of the request.
        await AssertStatus(HttpStatusCode.BadRequest, await client.PostAsync($"/api/homes?placeId={home}&from=2026-07-09&to=2026-07-10", Json("{}"), Ct), "a query");

        foreach (var place in new long[] { 999_999, onNoTimeline })
            await AssertStatus(HttpStatusCode.NotFound, await PostHomeAsync(client, new { placeId = place, from = "2026-07-09", to = (string?)null }), $"place {place}");

        // From the same day as to is one night, and the earliest and latest date there is are dates.
        foreach (var (from, to) in new[] { ("2026-07-09", "2026-07-09"), ("1970-01-01", "1970-01-01"), ("2099-12-31", "2099-12-31") })
            await AssertStatus(HttpStatusCode.Created, await PostHomeAsync(client, new { placeId = home, from, to }), $"{from} to {to}");

        Assert.Equal(3, (await UserRowsAsync(cs)).Count); // and none of the others was written
    }

    [Fact]
    public async Task Home_override_is_stored_at_the_place_that_survives_a_merge()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var (_, lisbon) = await SeedAsync(cs, api, Spots.Lisbon);
        var absorbed = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 100, 0), mergedInto: lisbon, osmName: "Old name");

        // The owner names the place that was merged away: they are at the one it stands for.
        using var created = await JsonOf(await PostHomeAsync(client, new { placeId = absorbed, from = "2026-07-09", to = "2026-07-11" }), HttpStatusCode.Created);

        Assert.Equal((lisbon, "Hotel Avenida", "2026-07-09", "2026-07-11", "user"), Shown(created.RootElement));
        Assert.Equal(lisbon, Assert.Single(await UserRowsAsync(cs)).PlaceId);

        // A place that is merged after the home was set is followed too: the list names the survivor, and the nights are measured from it. (This
        // one is 60 km away, which no merge of one place would be; so the trip that the home had taken away is back, and says which place is home.)
        var survivor = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 0, 60_000), osmName: "Survivor");
        await Sql.ExecAsync(cs, "update place set merged_into_id = @survivor where id = @lisbon", new { survivor, lisbon }, Ct);
        await api.Services.GetRequiredService<ITripRefresher>().RecomputeAsync(Ct);
        var user = (await HomesAsync(client)).Single(h => h.GetProperty("source").GetString() == "user");
        Assert.Equal((survivor, "Survivor"), (user.GetProperty("placeId").GetInt64(), user.GetProperty("placeName").GetString()));
        Assert.Equal(["2026-07-09"], (await TripsAsync(client)).Select(t => t.GetProperty("id").GetString()));
    }

    [Fact]
    public async Task Home_list_has_every_stored_period_in_date_order_with_the_name_of_the_place_that_shows()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        Assert.Empty(await HomesAsync(client)); // none, and an answer all the same

        var named = await PlaceAsync(cs, Spots.Home, osmName: "OpenStreetMap's name", userName: "Mine");
        var plain = await PlaceAsync(cs, Geo.Offset(Spots.Home, 5000, 0), osmName: "Plain");
        var nameless = await PlaceAsync(cs, Geo.Offset(Spots.Home, 9000, 0));
        var absorbed = await PlaceAsync(cs, Geo.Offset(Spots.Home, 12000, 0), osmName: "Absorbed", mergedInto: plain);
        await Sql.ExecAsync(cs,
            """
            insert into home_period (place_id, from_date, to_date, source) values
                (@absorbed, '2026-06-01', null, 'user'), (@plain, '2026-03-01', '2026-05-31', 'detected'),
                (@named, '2026-01-01', '2026-02-28', 'detected'), (@nameless, '2026-02-01', '2026-02-10', 'user')
            """, new { named, plain, nameless, absorbed }, Ct);

        var periods = await HomesAsync(client);

        var expected = new (long PlaceId, string? Name, string From, string? To, string Source)[]
        {
            (named, "Mine", "2026-01-01", "2026-02-28", "detected"), (nameless, null, "2026-02-01", "2026-02-10", "user"),
            (plain, "Plain", "2026-03-01", "2026-05-31", "detected"), (plain, "Plain", "2026-06-01", null, "user"),
        };
        Assert.Equal(expected, periods.Select(Shown)); // the one at the merged place is the survivor's
        Assert.All(periods, p => Assert.True(p.GetProperty("id").GetInt64() > 0));
        Assert.Equal(["id", "placeId", "placeName", "from", "to", "source"], periods[0].EnumerateObject().Select(p => p.Name));
        Assert.True(periods[1].TryGetProperty("placeName", out var none) && none.ValueKind == JsonValueKind.Null); // there, and null
    }

    [Fact]
    public async Task Deleting_a_detected_period_is_409()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var (_, lisbon) = await SeedAsync(cs, api, Spots.Lisbon);
        await JsonOf(await PostHomeAsync(client, new { placeId = lisbon, from = "2026-07-09", to = "2026-07-11" }), HttpStatusCode.Created);
        var detected = (await HomeRowsAsync(cs)).Single(r => r.Source == "detected");

        await AssertStatus(HttpStatusCode.Conflict, await client.DeleteAsync($"/api/homes/{detected.Id}", Ct), "a detected period");

        Assert.Equal(detected, Assert.Single(await HomeRowsAsync(cs), r => r.Source == "detected"));
        Assert.Empty(await TripsAsync(client)); // and nothing was recomputed into a different answer

        // No period of that id is a 404, and an id that is not a positive whole number a 400. Neither touches the periods there are.
        await AssertStatus(HttpStatusCode.NotFound, await client.DeleteAsync("/api/homes/999999", Ct), "no such period");
        foreach (var bad in new[] { "abc", "0", "-1", "1.5", "1e2", "%2B1" })
            await AssertStatus(HttpStatusCode.BadRequest, await client.DeleteAsync($"/api/homes/{bad}", Ct), $"the id {bad}");
        Assert.Equal(2, (await HomeRowsAsync(cs)).Count);

        // The owner's own is deleted, and once it is, it is no period: a second delete is a 404.
        var user = Assert.Single(await UserRowsAsync(cs));
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/homes/{user.Id}", Ct)).StatusCode);
        await AssertStatus(HttpStatusCode.NotFound, await client.DeleteAsync($"/api/homes/{user.Id}", Ct), "a period deleted already");
    }

    [Fact]
    public async Task Home_edits_wait_for_the_lock_that_the_refresh_holds()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var (_, lisbon) = await SeedAsync(cs, api, Spots.Lisbon);

        // Somebody has the lock the homes are written under, and a home is set meanwhile: it waits.
        var held = await HoldTheLockAsync(cs);
        var post = PostHomeAsync(client, new { placeId = lisbon, from = "2026-07-09", to = "2026-07-11" });
        await Task.Delay(750, Ct);
        Assert.False(post.IsCompleted, "a home was set while the lock was held");
        Assert.Empty(await UserRowsAsync(cs));

        await ReleaseAsync(held);
        using var created = await JsonOf(await post, HttpStatusCode.Created);
        var id = created.RootElement.GetProperty("id").GetInt64();

        // Taking it back waits the same way.
        held = await HoldTheLockAsync(cs);
        var delete = client.DeleteAsync($"/api/homes/{id}", Ct);
        await Task.Delay(750, Ct);
        Assert.False(delete.IsCompleted, "a home was deleted while the lock was held");
        Assert.Single(await UserRowsAsync(cs));

        await ReleaseAsync(held);
        Assert.Equal(HttpStatusCode.NoContent, (await delete).StatusCode);
        Assert.Empty(await UserRowsAsync(cs));
    }

    [Fact]
    public async Task Home_edits_whose_recompute_fails_answer_and_are_left_to_the_worker()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var refresher = default(FailingRefresher);
        await using var api = new ApiFactory(cs, configureServices: services =>
        {
            services.RemoveAll<ITripRefresher>();
            services.AddSingleton<ITripRefresher>(sp => refresher = new FailingRefresher(sp.GetRequiredService<TripRefresher>(), failures: 3));
        });
        var client = api.CreateClient();
        var store = api.Services.GetRequiredService<TripStore>();
        var (_, lisbon) = await SeedAsync(cs, api, Spots.Lisbon); // a refresh, which does not fail: only the recomputes of the edits do

        // The edit is stored and answered, whatever became of the trips.
        using var created = await JsonOf(await PostHomeAsync(client, new { placeId = lisbon, from = "2026-07-09", to = "2026-07-11" }), HttpStatusCode.Created);
        Assert.Equal(1, refresher!.Recomputes);
        Assert.Single(await UserRowsAsync(cs));
        Assert.Equal(["2026-07-09"], (await TripsAsync(client)).Select(t => t.GetProperty("id").GetString())); // as they were
        Assert.True(await TookPendingAsync(store)); // and the worker is asked to work them out

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/homes/{created.RootElement.GetProperty("id").GetInt64()}", Ct)).StatusCode);
        Assert.Equal(2, refresher.Recomputes);
        Assert.Empty(await UserRowsAsync(cs));
        Assert.True(await TookPendingAsync(store));

        using var set = await JsonOf(await PutSettingAsync(client, "80"));
        Assert.Equal(80.0, set.RootElement.GetProperty("tripMinDistanceKm").GetDouble());
        Assert.Equal(3, refresher.Recomputes);
        Assert.Equal(80.0, await SettingAsync(cs));
        Assert.True(await TookPendingAsync(store));
    }

    // ---- the distance a night must be from home to be a trip ------------------------------------------------------------

    [Fact]
    public async Task Trip_distance_setting_recomputes_trips_without_a_rebuild()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var options = api.Services.GetRequiredService<DetectionOptions>();
        var version = AlgorithmVersion.Compute(options);
        await Sql.ExecAsync(cs, "update processing_state set algorithm_version = @version where id = 1", new { version }, Ct);
        await SeedAsync(cs, api, Geo.Offset(Spots.Home, 0, 60_000)); // 60 km east of home: past the 50 km that is a trip
        Assert.Equal(["2026-07-09"], (await TripsAsync(client)).Select(t => t.GetProperty("id").GetString()));
        Assert.Equal((50.0, 50.0), await SettingsAsync(client));
        var segments = await Sql.QueryAsync<long>(cs, "select id from segment order by id", ct: Ct);

        // 80 km: three nights 60 km from home are no trip.
        using var set = await JsonOf(await PutSettingAsync(client, "80"));
        Assert.Equal((80.0, 50.0), (set.RootElement.GetProperty("tripMinDistanceKm").GetDouble(), set.RootElement.GetProperty("tripMinDistanceKmDefault").GetDouble()));
        Assert.Empty(await TripsAsync(client));
        Assert.Equal((80.0, 50.0), await SettingsAsync(client));
        Assert.Equal(80.0, await SettingAsync(cs));

        // Nothing was rebuilt: the version is the one it was (the setting is no part of it, and the options of the app are as they were), and a pass
        // of the worker, which starts the backfill over if it differs, finds nothing to do about it.
        Assert.Equal(version, AlgorithmVersion.Compute(options));
        Assert.Equal(50.0, options.TripMinDistanceKm);
        Assert.Equal(version, await Sql.ScalarAsync<string>(cs, "select algorithm_version from processing_state where id = 1", ct: Ct));
        await api.Services.GetRequiredService<TimelineWorker>().RunOnceAsync(Ct);
        Assert.Equal(version, await Sql.ScalarAsync<string>(cs, "select algorithm_version from processing_state where id = 1", ct: Ct));
        Assert.Equal(segments, await Sql.QueryAsync<long>(cs, "select id from segment order by id", ct: Ct));
        Assert.Equal(106, await Sql.ScalarAsync<long>(cs, "select count(*) from night", ct: Ct));
        Assert.Empty(await TripsAsync(client)); // a refresh with the setting still at 80 gives the same answer
        await RefreshAsync(api);
        Assert.Empty(await TripsAsync(client));

        // 40 km: a trip again. And without a value, the one that is configured.
        using var lower = await JsonOf(await PutSettingAsync(client, "40"));
        Assert.Equal(40.0, lower.RootElement.GetProperty("tripMinDistanceKm").GetDouble());
        Assert.Equal(["2026-07-09"], (await TripsAsync(client)).Select(t => t.GetProperty("id").GetString()));
        await PutSettingAsync(client, "80");
        Assert.Empty(await TripsAsync(client));
        using var none = await JsonOf(await PutSettingAsync(client, "null"));
        Assert.Equal((50.0, 50.0), (none.RootElement.GetProperty("tripMinDistanceKm").GetDouble(), none.RootElement.GetProperty("tripMinDistanceKmDefault").GetDouble()));
        Assert.Null(await SettingAsync(cs));
        Assert.Equal(0, await Sql.ScalarAsync<long>(cs, "select count(*) from app_setting where key = 'tripMinDistanceKm'", ct: Ct)); // the row is gone
        Assert.Equal(["2026-07-09"], (await TripsAsync(client)).Select(t => t.GetProperty("id").GetString()));
    }

    [Fact]
    public async Task Trip_distance_setting_falls_back_to_the_configured_distance()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs, new Dictionary<string, string?> { ["Detection:TripMinDistanceKm"] = "70" });
        var client = api.CreateClient();
        await SeedAsync(cs, api, Geo.Offset(Spots.Home, 0, 60_000));

        Assert.Equal((70.0, 70.0), await SettingsAsync(client));
        Assert.Empty(await TripsAsync(client)); // 60 km is under the 70 km that is configured

        using var set = await JsonOf(await PutSettingAsync(client, "55"));
        Assert.Equal((55.0, 70.0), (set.RootElement.GetProperty("tripMinDistanceKm").GetDouble(), set.RootElement.GetProperty("tripMinDistanceKmDefault").GetDouble()));
        Assert.Single(await TripsAsync(client));

        await PutSettingAsync(client, "null");
        Assert.Equal((70.0, 70.0), await SettingsAsync(client));
        Assert.Empty(await TripsAsync(client));
    }

    [Fact]
    public async Task Trip_distance_out_of_range_is_400()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await SeedAsync(cs, api, Spots.Lisbon);
        Assert.Equal(HttpStatusCode.OK, (await PutSettingAsync(client, "60")).StatusCode);

        // Under 5, over 1000, and what is not a number, or not there at all: nothing is written, and the trips are not worked out again.
        foreach (var value in new[] { "4.99", "4", "0", "-1", "-50", "1000.01", "1001", "5000", "1e9", "1e400", "\"far\"", "true", "[80]", "{}" })
            await AssertStatus(HttpStatusCode.BadRequest, await PutSettingAsync(client, value), $"tripMinDistanceKm {value}");
        foreach (var (what, body) in new[] { ("an empty object", "{}"), ("no body", ""), ("a body that is not an object", "[]"), ("another property", """{"distance":80}""") })
            await AssertStatus(HttpStatusCode.BadRequest, await client.PutAsync("/api/settings", Json(body), Ct), what);
        await AssertStatus(HttpStatusCode.BadRequest, await client.PutAsync("/api/settings?tripMinDistanceKm=80", Json("{}"), Ct), "a query");
        Assert.Equal(60.0, await SettingAsync(cs));
        Assert.Equal((60.0, 50.0), await SettingsAsync(client));

        // The ends are in, and a distance need not be whole.
        foreach (var value in new[] { "5", "1000", "12.5", "5.0001", "999.9" })
        {
            using var body = await JsonOf(await PutSettingAsync(client, value));
            Assert.Equal(double.Parse(value, System.Globalization.CultureInfo.InvariantCulture), body.RootElement.GetProperty("tripMinDistanceKm").GetDouble());
            Assert.Equal(double.Parse(value, System.Globalization.CultureInfo.InvariantCulture), await SettingAsync(cs));
        }
    }

    // ---- what failed, tried again --------------------------------------------------------------------------------------------

    [Fact]
    public async Task Retry_makes_failed_ranges_due()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var queue = api.Services.GetRequiredService<ProcessingQueue>();
        var inAnHour = DateTime.UtcNow.AddHours(1);
        await TimelineSeeder.InsertDirtyRangeAsync(cs, Utc(10, 20, 6), Utc(10, 20, 7), attempts: 1, nextAttemptAt: inAnHour); // failed once, waiting
        await TimelineSeeder.InsertDirtyRangeAsync(cs, Utc(10, 22, 6), Utc(10, 22, 7), attempts: 3, nextAttemptAt: inAnHour.AddHours(5)); // set aside
        await TimelineSeeder.InsertDirtyRangeAsync(cs, Utc(10, 24, 6), Utc(10, 24, 7)); // waiting, not failed
        await TimelineSeeder.SetBackfillAsync(cs, Utc(1, 1), Utc(10, 28), Utc(5, 1));
        Assert.Empty(await queue.DueRangesAsync(DateTime.UtcNow, ct: Ct)); // the two that failed are waiting out their backoff, and the third is new

        using var body = await JsonOf(await client.PostAsync("/api/status/retry", Json("{}"), Ct));

        Assert.Equal(2, body.RootElement.GetProperty("retried").GetInt32());
        var rows = await Sql.QueryAsync<DirtyRow>(cs,
            "select attempts as Attempts, next_attempt_at as NextAttemptAt, last_error as LastError from dirty_range order by from_utc", ct: Ct);
        Assert.Equal([new DirtyRow(0, null, "boom"), new DirtyRow(0, null, "boom"), new DirtyRow(0, null, null)], rows); // the error stays: what failed last
        // Due now: the failed ranges have been waiting longer than the debounce, whenever they were recorded. The one that did not fail
        // is still a range that ingest recorded a moment ago, and waits for more points as it did.
        var due = await queue.DueRangesAsync(DateTime.UtcNow, ct: Ct);
        Assert.Equal([(Utc(10, 20, 6), Utc(10, 20, 7)), (Utc(10, 22, 6), Utc(10, 22, 7))], due.Select(d => (d.FromUtc, d.ToUtc)));
        // The backfill is not touched.
        Assert.Equal(Utc(5, 1), (await queue.GetStateAsync(Ct)).BackfillCursor);

        // They are not failed any more, and what is pending is still all three.
        using var status = await JsonOf(await client.GetAsync("/api/status", Ct));
        Assert.Empty(status.RootElement.GetProperty("failedRanges").EnumerateArray());
        Assert.Equal(3, status.RootElement.GetProperty("pendingRanges").GetInt32());

        // Nothing is left to retry, and an empty body is as good as {}.
        using var again = await JsonOf(await client.PostAsync("/api/status/retry", Json(""), Ct));
        Assert.Equal(0, again.RootElement.GetProperty("retried").GetInt32());
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await client.PostAsync("/api/status/retry", new StringContent("{}", Encoding.UTF8, "text/plain"), Ct)).StatusCode);
    }

    private sealed record DirtyRow(int Attempts, DateTime? NextAttemptAt, string? LastError);

    // ---- what the views read ---------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Thumbnail_of_a_trip_ending_at_a_new_home_ends_there()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var oldHomeAt = Spots.Home;
        var newHomeAt = Geo.Offset(Spots.Home, 7000, 0); // the person moved house during the trip
        var oldHome = await PlaceAsync(cs, oldHomeAt);
        var newHome = await PlaceAsync(cs, newHomeAt);
        var lisbon = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal");
        // The new home is in effect from the night after the last away night, which is how detection backdates a home that was moved into on the way back.
        await StoreAsync(api,
            [Stay(D(9, 12), lisbon, Spots.Lisbon), Stay(D(9, 13), lisbon, Spots.Lisbon), Stay(D(9, 14), lisbon, Spots.Lisbon)],
            [new HomePeriod(oldHome, D(1, 1), D(9, 14)), new HomePeriod(newHome, D(9, 15), null)],
            Trip(D(9, 12), D(9, 14), Utc(9, 12, 7), Utc(9, 15, 12)));

        var trip = Assert.Single(await TripsAsync(client));

        var line = JsonSerializer.Deserialize<double[][]>(trip.GetProperty("thumbnail").GetRawText())!;
        Assert.Equal([[oldHomeAt.Longitude, oldHomeAt.Latitude], [Spots.Lisbon.Longitude, Spots.Lisbon.Latitude], [newHomeAt.Longitude, newHomeAt.Latitude]], line);
    }

    [Fact]
    public async Task Day_marks_a_place_near_a_home_the_owner_set_by_the_nights_of_that_period()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var detectedAt = Spots.Home;
        var ownersAt = Geo.Offset(Spots.Home, 7000, 0);
        var detected = await PlaceAsync(cs, detectedAt, "Oslo", "Norway", userName: "Home");
        var owners = await PlaceAsync(cs, ownersAt, "Oslo", "Norway", userName: "Flat");
        // Two more places of the owner's flat, as GPS drift makes them: one was where a night was spent in August, the other in July, before
        // the owner's period, which is then not a night of that home.
        var fragment = await PlaceAsync(cs, Geo.Offset(ownersAt, 0, 120), "Oslo", "Norway", osmName: "Storgata 5");
        var earlier = await PlaceAsync(cs, Geo.Offset(ownersAt, 150, 0), "Oslo", "Norway", osmName: "Storgata 7");
        await StoreAsync(api, [Stay(D(7, 10), earlier, Geo.Offset(ownersAt, 150, 0)), Stay(D(8, 10), fragment, Geo.Offset(ownersAt, 0, 120))],
            [new HomePeriod(detected, D(1, 1), null)]);
        await Sql.ExecAsync(cs, "insert into home_period (place_id, from_date, to_date, source) values (@owners, '2026-08-01', '2026-08-31', 'user')",
            new { owners }, Ct);
        foreach (var (day, hour, place) in new[]
        {
            (D(8, 15), 10, owners), (D(8, 15), 12, fragment), (D(8, 15), 14, earlier), (D(9, 15), 10, owners), (D(9, 15), 12, detected),
        })
            await TimelineSeeder.InsertSegmentAsync(cs, "stay", Utc(day.Month, day.Day, hour), Utc(day.Month, day.Day, hour + 1), day, day, placeId: place);

        async Task<List<(long? Place, bool Home)>> HomesOf(string date)
        {
            using var body = await JsonOf(await client.GetAsync($"/api/day/{date}", Ct));
            return [.. body.RootElement.GetProperty("segments").EnumerateArray()
                .Where(s => s.GetProperty("kind").GetString() == "stay")
                .Select(s => ((long?)s.GetProperty("place").GetProperty("id").GetInt64(), s.GetProperty("home").GetBoolean()))];
        }

        // In August the owner's flat is home, and so is the fragment whose night was in August; the other one's night was before the period.
        Assert.Equal([(owners, true), (fragment, true), (earlier, false)], await HomesOf("2026-08-15"));
        // In September the detected home is: the owner's flat is a place like another, and has no nights of a period then.
        Assert.Equal([(owners, false), (detected, true)], await HomesOf("2026-09-15"));
    }
}
