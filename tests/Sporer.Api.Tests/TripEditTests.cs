using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Time.Testing;
using Npgsql;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;
using Sporer.SyntheticData;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// What the owner does to a trip: naming it, changing the dates it begins and ends on, deleting it and bringing it back
/// (<c>PUT</c> and <c>DELETE /api/trips/{id}</c>, <c>GET /api/trips/deleted</c>, <c>POST /api/trips/deleted/{key}/restore</c>). The trips are
/// detected for real, from stays, by the refresher, so that what an edit does is what it does to the trips the app has: the one to
/// Lisbon from 9 to 12 July is found in <see cref="SeedAsync"/>, and a second one, in September, if it is asked for.
/// </summary>
[Collection("db")]
public class TripEditTests(DatabaseFixture db)
{
    private const string Oslo = "Europe/Oslo";
    private const string Lisbon = "Europe/Lisbon";
    private const string FlightLine = "[[10.7,59.9],[-9.1,38.7]]";
    private const string WalkLine = "[[-9.14,38.71],[-9.15,38.7]]";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime Utc(int month, int day, int hour = 0) => new(2026, month, day, hour, 0, 0, DateTimeKind.Utc);

    private static DateOnly D(int month, int day) => new(2026, month, day);

    private sealed record Seeded(long Home, long Lisbon);

    private static Task<long> StayAsync(string cs, DateTime start, DateTime end, long place, GeoPoint at, string zone = Oslo)
        => TimelineSeeder.InsertSegmentAsync(cs, "stay", start, end, LocalTime.LocalDate(start, zone), LocalTime.LocalDate(end, zone),
            zone, placeId: place, lat: at.Latitude, lon: at.Longitude);

    private static Task<long> MoveAsync(
        string cs, string mode, DateTime start, DateTime end, double distance, string startZone, string endZone, string geometry)
        => TimelineSeeder.InsertSegmentAsync(cs, "move", start, end, LocalTime.LocalDate(start, startZone), LocalTime.LocalDate(end, endZone),
            startZone, endZone, mode: mode, distance: distance, geometry: geometry);

    /// <summary>
    /// 100 nights at home from 31 March to 8 July, three in Lisbon (the nights of 9, 10 and 11 July), then home again; with
    /// <paramref name="september"/>, home to 2 September and two more nights in Lisbon, the 3rd and 4th, then home again. The trips are
    /// found by <see cref="ITripRefresher.RefreshAsync"/>: the first leaves at 09:00 Oslo time on 9 July and is back at 16:00 on the
    /// 12th. The flights, and a walk on the 12th from 17:00 Oslo time, after the return, are what the trip's stats and moves are made of.
    /// </summary>
    private static async Task<Seeded> SeedAsync(string cs, ApiFactory api, bool september = false)
    {
        var home = await TimelineSeeder.InsertPlaceAsync(cs, city: "Oslo", country: "Norway", lat: Spots.Home.Latitude, lon: Spots.Home.Longitude);
        var lisbon = await TimelineSeeder.InsertPlaceAsync(cs, city: "Lisbon", country: "Portugal", osmName: "Hotel Avenida",
            lat: Spots.Lisbon.Latitude, lon: Spots.Lisbon.Longitude);
        await SeedStaysAsync(cs, home, lisbon, september);
        await MoveAsync(cs, "flight", Utc(7, 9, 7), Utc(7, 9, 12), 2_738_800, Oslo, Lisbon, FlightLine);
        await MoveAsync(cs, "flight", Utc(7, 12, 8), Utc(7, 12, 14), 2_738_800, Lisbon, Oslo, FlightLine);
        await api.Services.GetRequiredService<ITripRefresher>().RefreshAsync(Utc(4, 1), Utc(9, 12, 12), Ct);
        return new Seeded(home, lisbon);
    }

    /// <summary>
    /// The stays of <see cref="SeedAsync"/>, with the walk of the 12th in the middle of the stay at home that follows the return (a walk is
    /// between two stays, and segments do not overlap).
    /// </summary>
    private static async Task SeedStaysAsync(string cs, long home, long lisbon, bool september, int firstAwayDay = 9)
    {
        await StayAsync(cs, Utc(3, 31, 12), Utc(7, firstAwayDay, 7), home, Spots.Home);
        await StayAsync(cs, Utc(7, firstAwayDay, 12), Utc(7, 12, 8), lisbon, Spots.Lisbon, Lisbon);
        await StayAsync(cs, Utc(7, 12, 14), Utc(7, 12, 15), home, Spots.Home);
        await MoveAsync(cs, "walk", Utc(7, 12, 15), Utc(7, 12, 16), 1_000, Oslo, Oslo, WalkLine);
        if (!september)
        {
            await StayAsync(cs, Utc(7, 12, 16), Utc(7, 15, 12), home, Spots.Home);
            return;
        }

        await StayAsync(cs, Utc(7, 12, 16), Utc(9, 3, 7), home, Spots.Home);
        await StayAsync(cs, Utc(9, 3, 12), Utc(9, 5, 8), lisbon, Spots.Lisbon, Lisbon);
        await StayAsync(cs, Utc(9, 5, 14), Utc(9, 12, 12), home, Spots.Home);
    }

    private static Task<HttpResponseMessage> PutAsync(HttpClient client, string id, string? name, string? start = null, string? end = null)
        => client.PutAsJsonAsync($"/api/trips/{id}", new { name, startDate = start, endDate = end }, Ct);

    private static async Task<JsonDocument> JsonOf(HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{response.RequestMessage?.RequestUri} gave {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text);
    }

    private static async Task<JsonDocument> GetAsync(HttpClient client, string url) => await JsonOf(await client.GetAsync(url, Ct));

    private static async Task<List<JsonElement>> TripsAsync(HttpClient client)
    {
        using var body = await GetAsync(client, "/api/trips");
        return [.. body.RootElement.GetProperty("trips").EnumerateArray().Select(t => t.Clone())];
    }

    private sealed record EditRow(
        string DetectedId, string DetectedLastNight, string? Name, string? StartDate, string? EndDate, bool Deleted, string? DeletedLabel);

    private static Task<IReadOnlyList<EditRow>> EditsAsync(string cs) => Sql.QueryAsync<EditRow>(cs,
        """
        select detected_id::text as DetectedId, detected_last_night::text as DetectedLastNight, name as Name,
               start_date::text as StartDate, end_date::text as EndDate, deleted as Deleted, deleted_label as DeletedLabel
        from trip_edit order by detected_id
        """, ct: Ct);

    private sealed record StoredRow(string Id, string LastNight, int Nights, string? Name, string? DetectedId, DateTime StartUtc, DateTime? EndUtc,
        string StartTz, string EndTz, string LocalStartDate, string LocalEndDate);

    private static Task<IReadOnlyList<StoredRow>> StoredAsync(string cs) => Sql.QueryAsync<StoredRow>(cs,
        """
        select id::text as Id, last_night::text as LastNight, nights as Nights, name as Name, detected_id::text as DetectedId,
               start_utc as StartUtc, end_utc as EndUtc, start_tz as StartTz, end_tz as EndTz,
               local_start_date::text as LocalStartDate, local_end_date::text as LocalEndDate
        from trip order by id
        """, ct: Ct);

    // ---- naming a trip -----------------------------------------------------------------------------------------------

    [Fact]
    public async Task Trip_rename_shows_in_list_and_detail()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // starting the host runs the migrations
        await SeedAsync(cs, api);

        var before = Assert.Single(await TripsAsync(client));
        Assert.Equal("Lisbon", before.GetProperty("name").GetString());
        Assert.False(before.GetProperty("edited").GetBoolean());

        using var renamed = await JsonOf(await PutAsync(client, "2026-07-09", "  Lisbon weekend  "));

        Assert.Equal("2026-07-09", renamed.RootElement.GetProperty("id").GetString());
        var item = Assert.Single(await TripsAsync(client));
        Assert.Equal("Lisbon weekend", item.GetProperty("name").GetString()); // trimmed
        Assert.True(item.GetProperty("edited").GetBoolean());
        using var detail = await GetAsync(client, "/api/trips/2026-07-09");
        Assert.Equal("Lisbon weekend", detail.RootElement.GetProperty("name").GetString());
        Assert.True(detail.RootElement.GetProperty("edited").GetBoolean());
        // What the detail has of the item is what the list says, the new fields among them, and they come before the others.
        Assert.All(item.EnumerateObject().Where(p => p.Name != "thumbnail"),
            p => Assert.Equal(p.Value.GetRawText(), detail.RootElement.GetProperty(p.Name).GetRawText()));
        Assert.Equal(["id", "name"], detail.RootElement.EnumerateObject().Take(2).Select(p => p.Name));
        Assert.Equal(["edited", "thumbnail"], item.EnumerateObject().TakeLast(2).Select(p => p.Name));
        Assert.Equal(["edited", "stats", "moves", "days"], detail.RootElement.EnumerateObject().TakeLast(4).Select(p => p.Name));

        // The dates are as they were detected, and the edit is of this trip, with nothing but its name.
        var stored = Assert.Single(await StoredAsync(cs));
        Assert.Equal(("2026-07-09", "2026-07-11", 3, "Lisbon weekend", null), (stored.Id, stored.LastNight, stored.Nights, stored.Name, stored.DetectedId));
        Assert.Equal((Utc(7, 9, 7), Utc(7, 12, 14)), (stored.StartUtc, stored.EndUtc));
        Assert.Equal([new EditRow("2026-07-09", "2026-07-11", "Lisbon weekend", null, null, false, null)], await EditsAsync(cs));

        // An empty name, or none, is the automatic one again, and nothing of the edit is left.
        foreach (var back in new string?[] { "", "   ", null })
        {
            using var named = await JsonOf(await PutAsync(client, "2026-07-09", "Again"));
            using var reset = await JsonOf(await PutAsync(client, "2026-07-09", back));
            var automatic = Assert.Single(await TripsAsync(client));
            Assert.Equal(("Lisbon", false), (automatic.GetProperty("name").GetString(), automatic.GetProperty("edited").GetBoolean()));
            Assert.Empty(await EditsAsync(cs));
            Assert.Null(Assert.Single(await StoredAsync(cs)).Name);
        }
    }

    [Fact]
    public async Task Trip_rename_with_the_dates_it_has_keeps_the_trip_as_detected()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await SeedAsync(cs, api);

        // A form that is filled in with the dates the trip has, and whose name is all that was changed, sends them back as they are. They
        // are the dates the detection gave it (the trip left at 09:00, not at midnight), and the edit does not take them for its own.
        using var renamed = await JsonOf(await PutAsync(client, "2026-07-09", "Lisbon weekend", "2026-07-09", "2026-07-12"));

        Assert.Equal("2026-07-09", renamed.RootElement.GetProperty("id").GetString());
        Assert.Equal([new EditRow("2026-07-09", "2026-07-11", "Lisbon weekend", null, null, false, null)], await EditsAsync(cs));
        var stored = Assert.Single(await StoredAsync(cs));
        Assert.Equal((Utc(7, 9, 7), Utc(7, 12, 14)), (stored.StartUtc, stored.EndUtc));
    }

    [Fact]
    public async Task Trip_rename_of_an_ongoing_trip_keeps_it_ongoing_until_it_is_given_an_end_date()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await TimelineSeeder.InsertPlaceAsync(cs, city: "Oslo", country: "Norway", lat: Spots.Home.Latitude, lon: Spots.Home.Longitude);
        var lisbon = await TimelineSeeder.InsertPlaceAsync(cs, city: "Lisbon", country: "Portugal", lat: Spots.Lisbon.Latitude, lon: Spots.Lisbon.Longitude);
        await StayAsync(cs, Utc(3, 31, 12), Utc(7, 9, 7), home, Spots.Home);
        await StayAsync(cs, Utc(7, 9, 12), Utc(7, 12, 8), lisbon, Spots.Lisbon, Lisbon); // and there is nothing after it: the person is still there
        await api.Services.GetRequiredService<ITripRefresher>().RefreshAsync(Utc(4, 1), Utc(7, 12, 8), Ct);
        using (var before = await GetAsync(client, "/api/trips/2026-07-09"))
            Assert.Equal(("2026-07-12", true), (before.RootElement.GetProperty("localEndDate").GetString(), before.RootElement.GetProperty("ongoing").GetBoolean()));

        // The form sends back the dates the trip has, and its end date, the day after its last night, is not an end the owner gave it.
        using (var renamed = await JsonOf(await PutAsync(client, "2026-07-09", "Still in Lisbon", "2026-07-09", "2026-07-12"))) { }

        using (var trip = await GetAsync(client, "/api/trips/2026-07-09"))
        {
            Assert.Equal(("Still in Lisbon", "2026-07-12", true), (trip.RootElement.GetProperty("name").GetString(), trip.RootElement.GetProperty("localEndDate").GetString(), trip.RootElement.GetProperty("ongoing").GetBoolean()));
            Assert.Equal(JsonValueKind.Null, trip.RootElement.GetProperty("end").ValueKind);
        }
        Assert.Equal([new EditRow("2026-07-09", "2026-07-11", "Still in Lisbon", null, null, false, null)], await EditsAsync(cs));

        // An end date of the owner's own ends it: at the midnight after that date, in the zone the night of that date was read in (the nearest
        // night there is, which is in Lisbon).
        using (var ended = await JsonOf(await PutAsync(client, "2026-07-09", "Still in Lisbon", null, "2026-07-14"))) { }

        using var over = await GetAsync(client, "/api/trips/2026-07-09");
        Assert.Equal((false, "2026-07-14T23:00:00Z", "2026-07-14", 5), (
            over.RootElement.GetProperty("ongoing").GetBoolean(), over.RootElement.GetProperty("end").GetString(),
            over.RootElement.GetProperty("localEndDate").GetString(), over.RootElement.GetProperty("nights").GetInt32()));
    }

    // ---- changing the dates ------------------------------------------------------------------------------------------

    [Fact]
    public async Task Trip_dates_change_id_days_and_stats()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await SeedAsync(cs, api);

        using (var before = await GetAsync(client, "/api/trips/2026-07-09"))
        {
            Assert.Equal(4, before.RootElement.GetProperty("days").GetArrayLength());
            Assert.Equal(2, before.RootElement.GetProperty("stats").GetProperty("flights").GetInt32());
            Assert.Equal(0, before.RootElement.GetProperty("stats").GetProperty("groundDistanceMeters").GetDouble()); // the walk is after the return
            Assert.Equal(1, before.RootElement.GetProperty("stats").GetProperty("cities").GetInt32());
        }

        // From the 8th to the 13th: the trip begins a day earlier, and ends the day after the walk it was home for.
        using var edited = await JsonOf(await PutAsync(client, "2026-07-09", null, "2026-07-08", "2026-07-13"));

        Assert.Equal("2026-07-08", edited.RootElement.GetProperty("id").GetString()); // the first night moved
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/trips/2026-07-09", Ct)).StatusCode);
        var item = Assert.Single(await TripsAsync(client));
        Assert.Equal("2026-07-08", item.GetProperty("id").GetString());
        using var trip = await GetAsync(client, "/api/trips/2026-07-08");
        var t = trip.RootElement;
        Assert.Equal(("2026-07-08", "2026-07-12", 5), (t.GetProperty("firstNight").GetString(), t.GetProperty("lastNight").GetString(), t.GetProperty("nights").GetInt32()));
        Assert.Equal(("2026-07-08", "2026-07-13", false), (t.GetProperty("localStartDate").GetString(), t.GetProperty("localEndDate").GetString(), t.GetProperty("ongoing").GetBoolean()));
        // Local midnights, in the zones of the nights: the one that begins the 8th (the night of the 8th is at home), and the one that ends the
        // 13th, the day the person is back (the night of the 13th is at home too), which is the 14th at 00:00. Oslo is UTC+2 in July.
        Assert.Equal(("2026-07-07T22:00:00Z", "2026-07-13T22:00:00Z"), (t.GetProperty("start").GetString(), t.GetProperty("end").GetString()));
        Assert.Equal((Oslo, Oslo), (t.GetProperty("startTimeZone").GetString(), t.GetProperty("endTimeZone").GetString()));
        Assert.True(t.GetProperty("edited").GetBoolean());
        Assert.Equal("Lisbon & Oslo", t.GetProperty("name").GetString()); // not named by the owner: the nights are, and two of them are at home

        // A day for every date from the 8th to the 13th, and the day of the journey home is inside the trip: the walk after the return is now
        // part of it, with the home it began at.
        Assert.Equal(["2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12", "2026-07-13"],
            t.GetProperty("days").EnumerateArray().Select(d => d.GetProperty("date").GetString()));
        Assert.Equal(1_000, t.GetProperty("stats").GetProperty("groundDistanceMeters").GetDouble());
        Assert.Equal(2, t.GetProperty("stats").GetProperty("cities").GetInt32()); // Lisbon, and Oslo, where the walk was
        Assert.Equal(3, t.GetProperty("moves").GetArrayLength());

        var stored = Assert.Single(await StoredAsync(cs));
        Assert.Equal(("2026-07-08", "2026-07-12", 5, null, "2026-07-09"), (stored.Id, stored.LastNight, stored.Nights, stored.Name, stored.DetectedId));
        Assert.Equal([new EditRow("2026-07-09", "2026-07-11", null, "2026-07-08", "2026-07-13", false, null)], await EditsAsync(cs));

        // The trip is asked for by its new id, and the edit is the same one: it is of the trip detected on the 9th. Taking back the start
        // date is the first night the trip was detected on, and an end date of the 12th ends it the evening before it began.
        using var again = await JsonOf(await PutAsync(client, "2026-07-08", null, null, "2026-07-12"));
        Assert.Equal("2026-07-09", again.RootElement.GetProperty("id").GetString());
        Assert.Equal([new EditRow("2026-07-09", "2026-07-11", null, null, "2026-07-12", false, null)], await EditsAsync(cs));
        var last = Assert.Single(await StoredAsync(cs));
        Assert.Equal(("2026-07-09", "2026-07-11", 3, null), (last.Id, last.LastNight, last.Nights, last.DetectedId));
        Assert.Equal((Utc(7, 9, 7), Utc(7, 12, 22)), (last.StartUtc, last.EndUtc)); // started as detected; ends at the midnight after the 12th, in Oslo: the night of the 12th is at home
    }

    [Fact]
    public async Task Trip_dates_overlapping_another_trip_is_409()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await SeedAsync(cs, api, september: true);
        Assert.Equal(["2026-07-09", "2026-09-03"], (await StoredAsync(cs)).Select(t => t.Id));

        // The nights of the trip in July are the 9th, 10th and 11th, and those of the one in September the 3rd and 4th.
        var overlaps = new (string Id, string? Start, string? End)[]
        {
            ("2026-09-03", "2026-07-11", null),   // begins the last night of the first trip
            ("2026-09-03", "2026-07-01", null),   // takes in the whole of it
            ("2026-07-09", null, "2026-09-04"),   // ends on a night of the second
            ("2026-07-09", "2026-08-30", "2026-09-10"), // takes in the whole of the second
        };
        foreach (var (id, start, end) in overlaps)
        {
            using var response = await PutAsync(client, id, "Overlaps", start, end);
            var text = await response.Content.ReadAsStringAsync(Ct);
            Assert.True(response.StatusCode == HttpStatusCode.Conflict, $"{id} {start} {end} gave {(int)response.StatusCode}: {text}");
            using var body = JsonDocument.Parse(text);
            Assert.True(body.RootElement.GetProperty("errors").EnumerateObject().Any(), text); // FastEndpoints' error body
        }

        Assert.Empty(await EditsAsync(cs)); // nothing was stored
        Assert.Equal(["2026-07-09", "2026-09-03"], (await StoredAsync(cs)).Select(t => t.Id));

        // Touching is not sharing a night: the second trip begins the night after the first one's last.
        using var touching = await JsonOf(await PutAsync(client, "2026-09-03", null, "2026-07-12"));
        Assert.Equal("2026-07-12", touching.RootElement.GetProperty("id").GetString());
        Assert.Equal(["2026-07-09", "2026-07-12"], (await StoredAsync(cs)).Select(t => t.Id));
        Assert.Equal(["2026-07-12", "2026-07-09"], (await TripsAsync(client)).Select(t => t.GetProperty("id").GetString())); // newest first

        // Taking the start date back is the id it had.
        using var back = await JsonOf(await PutAsync(client, "2026-07-12", null));
        Assert.Equal("2026-09-03", back.RootElement.GetProperty("id").GetString());
        Assert.Equal(["2026-07-09", "2026-09-03"], (await StoredAsync(cs)).Select(t => t.Id));
        Assert.Empty(await EditsAsync(cs));
    }

    [Fact]
    public async Task Trip_start_after_end_is_400()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await SeedAsync(cs, api);

        var cases = new (string What, string? Start, string? End)[]
        {
            ("start after end", "2026-07-13", "2026-07-10"),
            ("start is end", "2026-07-10", "2026-07-10"),
            ("a start after the last night the trip has", "2026-07-12", null),
            ("an end on the first night the trip has", null, "2026-07-09"),
            ("an end before the trip", null, "2026-07-01"),
        };
        foreach (var (what, start, end) in cases)
        {
            using var response = await PutAsync(client, "2026-07-09", "Nope", start, end);
            var text = await response.Content.ReadAsStringAsync(Ct);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"{what} gave {(int)response.StatusCode}: {text}");
            using var body = JsonDocument.Parse(text);
            Assert.True(body.RootElement.GetProperty("errors").EnumerateObject().Any(), text);
        }

        Assert.Empty(await EditsAsync(cs));
        Assert.Equal("Lisbon", Assert.Single(await TripsAsync(client)).GetProperty("name").GetString());
    }

    [Fact]
    public async Task Trip_edit_with_a_body_that_is_not_an_edit_is_400()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await SeedAsync(cs, api);

        var bodies = new (string What, string Body)[]
        {
            // All three are asked for: null is as detected, and a body that says nothing of one is not that.
            ("an empty object", "{}"), ("an empty body", ""), ("an array", "[]"), ("not json", "not json"),
            ("no name", """{"startDate":null,"endDate":null}"""),
            ("no start date", """{"name":null,"endDate":null}"""),
            ("no end date", """{"name":null,"startDate":null}"""),
            ("another property", """{"nom":null,"startDate":null,"endDate":null}"""),
            ("a name that is not text", """{"name":5,"startDate":null,"endDate":null}"""),
            ("a date that is not text", """{"name":null,"startDate":20260710,"endDate":null}"""),
            ("a name of 101 characters", $$"""{"name":"{{new string('x', 101)}}","startDate":null,"endDate":null}"""),
            // yyyy-MM-dd and nothing else is a date.
            ("a date with no zeros", """{"name":null,"startDate":"2026-7-10","endDate":null}"""),
            ("a date with a time", """{"name":null,"startDate":"2026-07-10T00:00:00","endDate":null}"""),
            ("a date that is not one", """{"name":null,"startDate":null,"endDate":"2026-02-30"}"""),
            ("a word", """{"name":null,"startDate":"yesterday","endDate":null}"""),
            ("an empty date", """{"name":null,"startDate":"","endDate":null}"""),
            // And one that the clocks can work with.
            ("a start before 1970", """{"name":null,"startDate":"1969-12-31","endDate":null}"""),
            ("an end in 2100", """{"name":null,"startDate":null,"endDate":"2100-01-01"}"""),
        };
        foreach (var (what, body) in bodies)
        {
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            using var response = await client.PutAsync("/api/trips/2026-07-09", content, Ct);
            Assert.True(response.StatusCode == HttpStatusCode.BadRequest, $"{what} gave {(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(Ct)}");
        }

        // The query is no part of the request.
        using var query = new StringContent("{}", Encoding.UTF8, "application/json");
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PutAsync("/api/trips/2026-07-09?name=Mine&startDate=2026-07-08&endDate=2026-07-13", query, Ct)).StatusCode);

        Assert.Empty(await EditsAsync(cs));
    }

    [Fact]
    public async Task Trip_edit_of_a_trip_that_is_not_one_is_404_and_a_write_that_is_not_json_is_415()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await SeedAsync(cs, api);

        foreach (var id in new[] { "2026-07-10", "2026-01-01", "2026-07-9", "nope", "2026-13-01", "2026-07-09T00:00:00" })
        {
            Assert.Equal(HttpStatusCode.NotFound, (await PutAsync(client, id, "Mine")).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync($"/api/trips/{id}", Ct)).StatusCode);
        }

        using var form = new StringContent("name=Mine", Encoding.UTF8, "application/x-www-form-urlencoded");
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await client.PutAsync("/api/trips/2026-07-09", form, Ct)).StatusCode);
        using var none = new HttpRequestMessage(HttpMethod.Post, "/api/trips/deleted/2026-07-09/restore");
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await client.SendAsync(none, Ct)).StatusCode);

        Assert.Empty(await EditsAsync(cs));
        Assert.Single(await StoredAsync(cs));
    }

    // ---- deleting a trip and bringing it back ------------------------------------------------------------------------

    [Fact]
    public async Task Trip_delete_and_restore()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await SeedAsync(cs, api, september: true);
        using (var empty = await GetAsync(client, "/api/trips/deleted"))
            Assert.Equal(0, empty.RootElement.GetArrayLength());

        // The label is what the list showed of the trip, named as the owner named it.
        using (var named = await JsonOf(await PutAsync(client, "2026-09-03", "Back to Lisbon"))) { }
        using var deleted = await client.DeleteAsync("/api/trips/2026-07-09", Ct);
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        using var deletedToo = await client.DeleteAsync("/api/trips/2026-09-03", Ct);
        Assert.Equal(HttpStatusCode.NoContent, deletedToo.StatusCode);

        Assert.Empty(await TripsAsync(client));
        Assert.Empty(await StoredAsync(cs));
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/trips/2026-07-09", Ct)).StatusCode);
        Assert.Equal(
            [
                new EditRow("2026-07-09", "2026-07-11", null, null, null, true, "Lisbon · 9 – 12 Jul 2026"),
                new EditRow("2026-09-03", "2026-09-04", "Back to Lisbon", null, null, true, "Back to Lisbon · 3 – 5 Sep 2026"),
            ],
            await EditsAsync(cs));

        // Deleting it again: it is not a trip any more.
        Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync("/api/trips/2026-07-09", Ct)).StatusCode);

        // A refresh, or a rebuild's refresh, does not bring it back.
        await api.Services.GetRequiredService<ITripRefresher>().RefreshAsync(Utc(4, 1), Utc(9, 12, 12), Ct);
        Assert.Empty(await TripsAsync(client));

        // The list of the deleted: newest first, with when.
        using var list = await GetAsync(client, "/api/trips/deleted");
        var rows = list.RootElement.EnumerateArray().ToList();
        Assert.Equal(["2026-09-03", "2026-07-09"], rows.Select(r => r.GetProperty("key").GetString()));
        Assert.Equal(["Back to Lisbon · 3 – 5 Sep 2026", "Lisbon · 9 – 12 Jul 2026"], rows.Select(r => r.GetProperty("label").GetString()));
        Assert.Equal(["key", "label", "deletedAt"], rows[0].EnumerateObject().Select(p => p.Name));
        var deletedAt = rows.Select(r => r.GetProperty("deletedAt").GetDateTime()).ToList();
        Assert.True(deletedAt[0] >= deletedAt[1]);
        Assert.Equal(DateTimeKind.Utc, deletedAt[0].Kind);
        Assert.InRange(DateTime.UtcNow - deletedAt[0], TimeSpan.FromSeconds(-5), TimeSpan.FromMinutes(5));

        // Restored, the trip is back as it was: the edit of its name too, and a trip that had none has no edit left.
        using var restored = await client.PostAsJsonAsync("/api/trips/deleted/2026-07-09/restore", new { }, Ct);
        Assert.Equal(HttpStatusCode.NoContent, restored.StatusCode);
        Assert.Equal(["Lisbon"], (await TripsAsync(client)).Select(t => t.GetProperty("name").GetString()));
        Assert.Equal(["2026-09-03"], (await EditsAsync(cs)).Select(e => e.DetectedId));
        using var restoredToo = await client.PostAsync("/api/trips/deleted/2026-09-03/restore", JsonContent.Create(new { }), Ct);
        Assert.Equal(HttpStatusCode.NoContent, restoredToo.StatusCode);
        Assert.Equal(["Back to Lisbon", "Lisbon"], (await TripsAsync(client)).Select(t => t.GetProperty("name").GetString()));
        Assert.Equal([new EditRow("2026-09-03", "2026-09-04", "Back to Lisbon", null, null, false, null)], await EditsAsync(cs));
        using (var none = await GetAsync(client, "/api/trips/deleted"))
            Assert.Equal(0, none.RootElement.GetArrayLength());

        // A trip that is not deleted cannot be restored, and nor can one that is not a trip.
        foreach (var key in new[] { "2026-09-03", "2026-07-09", "2026-01-01", "nope", "2026-7-9" })
            Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync($"/api/trips/deleted/{key}/restore", new { }, Ct)).StatusCode);
    }

    [Fact]
    public async Task Trip_restore_with_an_empty_body_is_fine_and_a_deleted_trip_keeps_its_dates()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await SeedAsync(cs, api);

        using (var edited = await JsonOf(await PutAsync(client, "2026-07-09", null, "2026-07-08", "2026-07-13"))) { }
        // It is asked for by the id it has now, and what is recorded is what it was called and when.
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/api/trips/2026-07-08", Ct)).StatusCode);
        Assert.Equal(
            [new EditRow("2026-07-09", "2026-07-11", null, "2026-07-08", "2026-07-13", true, "Lisbon & Oslo · 8 – 13 Jul 2026")],
            await EditsAsync(cs));

        using var restore = new HttpRequestMessage(HttpMethod.Post, "/api/trips/deleted/2026-07-09/restore") { Content = new StringContent("", Encoding.UTF8, "application/json") };
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(restore, Ct)).StatusCode);

        Assert.Equal(["2026-07-08"], (await StoredAsync(cs)).Select(t => t.Id));
        Assert.Equal([new EditRow("2026-07-09", "2026-07-11", null, "2026-07-08", "2026-07-13", false, null)], await EditsAsync(cs));
    }

    [Fact]
    public void Trip_dates_are_written_as_the_list_writes_them()
    {
        Assert.Equal("12 – 16 Sep 2026", TripMapping.DateRange(D(9, 12), D(9, 16)));
        Assert.Equal("9 – 12 Jul 2026", TripMapping.DateRange(D(7, 9), D(7, 12)));
        Assert.Equal("28 Sep – 3 Oct 2026", TripMapping.DateRange(D(9, 28), D(10, 3)));
        Assert.Equal("28 Dec 2026 – 3 Jan 2027", TripMapping.DateRange(D(12, 28), new DateOnly(2027, 1, 3)));
        Assert.Equal("12 Sep 2026", TripMapping.DateRange(D(9, 12), D(9, 12)));
        Assert.Equal("30 Sep – 1 Oct 2026", TripMapping.DateRange(D(9, 30), D(10, 1)));
    }

    // ---- across refreshes and rebuilds -------------------------------------------------------------------------------

    [Fact]
    public async Task Trip_edits_are_reapplied_after_a_refresh()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        var (home, lisbon) = await SeedAsync(cs, api);

        using (var edited = await JsonOf(await PutAsync(client, "2026-07-09", "Lisbon weekend", "2026-07-10", null))) { }
        var expected = await StoredAsync(cs);
        Assert.Equal(("2026-07-10", "Lisbon weekend", "2026-07-09"), (expected[0].Id, expected[0].Name, expected[0].DetectedId));

        // A refresh of any part of the timeline works the trips out afresh, and the edit is put on the one it finds again.
        await refresher.RefreshAsync(Utc(7, 1), Utc(7, 13), Ct);
        Assert.Equal(expected, await StoredAsync(cs));
        await refresher.RefreshAsync(Utc(4, 1), Utc(9, 12, 12), Ct);
        Assert.Equal(expected, await StoredAsync(cs));
        await refresher.RecomputeAsync(Ct);
        Assert.Equal(expected, await StoredAsync(cs));

        // Detection moves a night: the person left a day earlier than the timeline had it. The trip is found on the 8th and the 9th is
        // not a first night any more, so the edit is found by what it overlaps, and is still the one edit of the trip.
        await Sql.ExecAsync(cs, "delete from segment", ct: Ct);
        await SeedStaysAsync(cs, home, lisbon, september: false, firstAwayDay: 8);
        await refresher.RefreshAsync(Utc(4, 1), Utc(9, 12, 12), Ct);

        // Four nights now, the 8th to the 11th. It is still the trip the owner named, and the start date they gave it is still the start date.
        var moved = Assert.Single(await StoredAsync(cs));
        Assert.Equal(("2026-07-10", "2026-07-11", 2, "Lisbon weekend", "2026-07-09"), (moved.Id, moved.LastNight, moved.Nights, moved.Name, moved.DetectedId));
        var item = Assert.Single(await TripsAsync(client));
        Assert.Equal(("2026-07-10", "Lisbon weekend", true), (item.GetProperty("id").GetString(), item.GetProperty("name").GetString(), item.GetProperty("edited").GetBoolean()));

        // Without a date, it is the detection that decides: take back the start date and the trip begins where it was found.
        using var taken = await JsonOf(await PutAsync(client, "2026-07-10", "Lisbon weekend"));
        Assert.Equal("2026-07-08", taken.RootElement.GetProperty("id").GetString());
        var edits = await EditsAsync(cs);
        Assert.Equal([("2026-07-09", "Lisbon weekend", null)], edits.Select(e => (e.DetectedId, e.Name, e.StartDate))); // the same edit, not another
        var final = Assert.Single(await StoredAsync(cs));
        Assert.Equal(("2026-07-08", "2026-07-11", 4, "2026-07-09"), (final.Id, final.LastNight, final.Nights, final.DetectedId));
    }

    [Fact]
    public async Task Trip_edit_waits_for_its_trip_and_applies_when_it_is_detected_again()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        var (home, lisbon) = await SeedAsync(cs, api);
        using (var edited = await JsonOf(await PutAsync(client, "2026-07-09", "Lisbon weekend", "2026-07-08", "2026-07-13"))) { }
        var expected = await StoredAsync(cs);
        var edits = await EditsAsync(cs);

        // The person was at home all along: there is no trip, and the edit is still there.
        await Sql.ExecAsync(cs, "delete from segment", ct: Ct);
        await StayAsync(cs, Utc(3, 31, 12), Utc(7, 15, 12), home, Spots.Home);
        await refresher.RefreshAsync(Utc(4, 1), Utc(9, 12, 12), Ct);
        Assert.Empty(await StoredAsync(cs));
        Assert.Equal(edits, await EditsAsync(cs));

        // And it is away again: the trip is the owner's again.
        await Sql.ExecAsync(cs, "delete from segment", ct: Ct);
        await SeedStaysAsync(cs, home, lisbon, september: false);
        await refresher.RefreshAsync(Utc(4, 1), Utc(9, 12, 12), Ct);
        Assert.Equal(expected, await StoredAsync(cs));
    }

    [Fact]
    public async Task Trip_dates_that_detection_makes_overlap_are_left_as_detected_and_the_refresh_goes_on()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        await SeedAsync(cs, api, september: true);

        // The trip in July is to end on 4 September, which takes in the nights of the other (the 3rd and the 4th): that is fine when the other
        // trip is deleted...
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/api/trips/2026-09-03", Ct)).StatusCode);
        using (var edited = await JsonOf(await PutAsync(client, "2026-07-09", "Long", null, "2026-09-04"))) { }
        var long_ = Assert.Single(await StoredAsync(cs));
        Assert.Equal(("2026-07-09", "2026-09-03", 57), (long_.Id, long_.LastNight, long_.Nights));

        // ...and the other trip is brought back, which takes nights the first has: the first keeps its name and is as it was detected,
        // the second is as it was, and the restore is not refused.
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsJsonAsync("/api/trips/deleted/2026-09-03/restore", new { }, Ct)).StatusCode);

        var stored = await StoredAsync(cs);
        Assert.Equal([("2026-07-09", "2026-07-11", "Long"), ("2026-09-03", "2026-09-04", null)], stored.Select(t => (t.Id, t.LastNight, t.Name)));
        // What the owner asked for is as it was: it applies again when the trip in the way is gone.
        Assert.Equal([new EditRow("2026-07-09", "2026-07-11", "Long", null, "2026-09-04", false, null)], await EditsAsync(cs));
        await refresher.RefreshAsync(Utc(4, 1), Utc(9, 12, 12), Ct);
        Assert.Equal(stored, await StoredAsync(cs));
    }

    [Fact]
    public async Task Trip_edit_whose_recompute_fails_answers_and_is_applied_by_the_worker()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var refresher = default(FailingRefresher);
        await using var api = new ApiFactory(cs, configureServices: services =>
        {
            services.RemoveAll<ITripRefresher>();
            services.AddSingleton<ITripRefresher>(sp => refresher = new FailingRefresher(sp.GetRequiredService<TripRefresher>(), failures: 1));
        });
        var client = api.CreateClient();
        var worker = api.Services.GetRequiredService<TimelineWorker>();
        await Sql.ExecAsync(cs, "update processing_state set algorithm_version = @version where id = 1",
            new { version = AlgorithmVersion.Compute(api.Services.GetRequiredService<DetectionOptions>()) }, Ct);
        await SeedAsync(cs, api);

        // The recompute fails (once). The edit is stored and answered: the id is the one the new start date makes, which is all there is to say.
        using var edited = await JsonOf(await PutAsync(client, "2026-07-09", "Lisbon weekend", "2026-07-08", null));
        Assert.Equal("2026-07-08", edited.RootElement.GetProperty("id").GetString());
        Assert.Equal(1, refresher!.Recomputes);
        Assert.Equal(["2026-07-09"], (await StoredAsync(cs)).Select(t => t.Id)); // the trips are as they were
        Assert.Equal(["2026-07-09"], (await EditsAsync(cs)).Select(e => e.DetectedId));
        Assert.NotNull(await api.Services.GetRequiredService<TripStore>().TakePendingAsync(Ct));

        // Without a start date it is the id the trip has.
        using var renamed = await JsonOf(await PutAsync(client, "2026-07-09", "Lisbon weekend"));
        Assert.Equal("2026-07-09", renamed.RootElement.GetProperty("id").GetString());
        await Sql.ExecAsync(cs, "delete from trip_edit", ct: Ct);
        await Sql.ExecAsync(cs,
            "insert into trip_edit (detected_id, detected_last_night, name, start_date) values ('2026-07-09', '2026-07-11', 'Lisbon weekend', '2026-07-08')", ct: Ct);

        // The worker's next pass works the trips out, with the edit in them.
        Assert.True(await worker.RunOnceAsync(Ct));
        Assert.Equal(["2026-07-08"], (await StoredAsync(cs)).Select(t => t.Id));
        Assert.Equal("Lisbon weekend", Assert.Single(await StoredAsync(cs)).Name);
    }

    private static async Task<long> AdvisoryWaitersAsync(string cs)
        => await Sql.ScalarAsync<long>(cs, "select count(*) from pg_locks where locktype = 'advisory' and not granted", ct: Ct);

    [Fact]
    public async Task Trip_edit_and_a_refresh_that_wait_for_each_other_both_land()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var refresher = api.Services.GetRequiredService<ITripRefresher>();
        await SeedAsync(cs, api);

        // Something else holds the lock the trips are written under, and an edit and a refresh both ask for them.
        await using var holder = new NpgsqlConnection(cs);
        await holder.OpenAsync(Ct);
        await using var holding = await holder.BeginTransactionAsync(Ct);
        await using (var take = new NpgsqlCommand("select pg_advisory_xact_lock(@key)", holder, holding))
        {
            take.Parameters.AddWithValue("key", TripRefresher.AdvisoryLockKey);
            await take.ExecuteNonQueryAsync(Ct);
        }

        var edit = Task.Run(() => PutAsync(client, "2026-07-09", "Lisbon weekend", "2026-07-08", "2026-07-13"), Ct);
        var refresh = Task.Run(() => refresher.RefreshAsync(Utc(4, 1), Utc(9, 12, 12), Ct), Ct);
        var until = DateTime.UtcNow.AddSeconds(20);
        while (await AdvisoryWaitersAsync(cs) < 2)
        {
            Assert.False(edit.IsCompleted || refresh.IsCompleted, "one of them did not wait for the lock");
            Assert.True(DateTime.UtcNow < until, "timed out waiting for both to wait for the lock");
            await Task.Delay(20, Ct);
        }
        await holding.CommitAsync(Ct);

        using var response = await edit;
        await refresh;

        // Whichever went first, the trips are those of the nights with the edit in them.
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var stored = Assert.Single(await StoredAsync(cs));
        Assert.Equal(("2026-07-08", "Lisbon weekend", "2026-07-09", 5), (stored.Id, stored.Name, stored.DetectedId, stored.Nights));
    }

    // ---- a rebuild ---------------------------------------------------------------------------------------------------

    private sealed record Rebuilt(string Id, string LastNight, int Nights, string? Name, string? DetectedId);

    private static Task<IReadOnlyList<Rebuilt>> RebuiltAsync(string cs) => Sql.QueryAsync<Rebuilt>(cs,
        "select id::text as Id, last_night::text as LastNight, nights as Nights, name as Name, detected_id::text as DetectedId from trip order by id", ct: Ct);

    private static async Task FinishBackfillAsync(ApiFactory api)
    {
        var worker = api.Services.GetRequiredService<TimelineWorker>();
        for (var pass = 0; await worker.RunOnceAsync(Ct); pass++)
            Assert.True(pass < 100, "the worker keeps finding work");
    }

    [Fact]
    public async Task Trip_edits_survive_a_rebuild()
    {
        // A whole fictional year, as SyntheticTripsTests has it: three trips found from the points a phone would have logged.
        var options = new SimulatorOptions(new DateOnly(2025, 1, 1), new DateOnly(2025, 12, 31), TimeSpan.FromSeconds(60), Seed: 7);
        var plan = Simulator.Describe(options);
        var points = new List<TrackPoint>();
        Simulator.Run(options, fix => points.Add(new TrackPoint(fix.TimeUtc, "synthetic-phone", fix.Latitude, fix.Longitude, fix.Speed, fix.Accuracy, fix.Motion)));

        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 1, 2, 0, 0, 0, TimeSpan.Zero));
        var settings = new Dictionary<string, string?> { ["Processing:BackfillPause"] = "00:00:00" };
        var lisbon = plan.Trips[1].Start; // the second trip: six nights
        string firstVersion;
        IReadOnlyList<Rebuilt> expected;
        await using (var first = new ApiFactory(cs, settings, clock))
        {
            var client = first.CreateClient(); // starting the host runs the migrations
            await PointSeeder.InsertAsync(cs, points, Ct);
            await FinishBackfillAsync(first);
            firstVersion = (await Sql.ScalarAsync<string>(cs, "select algorithm_version from processing_state where id = 1", ct: Ct))!;
            Assert.Equal(plan.Trips.Select(t => t.Start.ToString("yyyy-MM-dd")), (await RebuiltAsync(cs)).Select(t => t.Id));

            // The second trip is named, begins a day later, and the third is deleted.
            var id = lisbon.ToString("yyyy-MM-dd");
            using var edited = await JsonOf(await PutAsync(client, id, "Portugal 2025", lisbon.AddDays(1).ToString("yyyy-MM-dd")));
            Assert.Equal(lisbon.AddDays(1).ToString("yyyy-MM-dd"), edited.RootElement.GetProperty("id").GetString());
            Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/trips/{plan.Trips[2].Start:yyyy-MM-dd}", Ct)).StatusCode);
            expected = await RebuiltAsync(cs);
            Assert.Equal(2, expected.Count);
            Assert.Equal(("Portugal 2025", 5), (expected[1].Name, expected[1].Nights));
        }
        var editsBefore = await EditsAsync(cs);
        Assert.Equal(2, editsBefore.Count);

        // Another algorithm version (a tolerance that changes nothing the trips are made of): the segments, nights and trips are cleared, and built
        // again from the points. The edits are not.
        clock.Advance(TimeSpan.FromHours(1));
        await using var second = new ApiFactory(cs, new Dictionary<string, string?>(settings) { ["Detection:DetailToleranceMeters"] = "6" }, clock);
        var client2 = second.CreateClient();
        await FinishBackfillAsync(second);

        Assert.NotEqual(firstVersion, await Sql.ScalarAsync<string>(cs, "select algorithm_version from processing_state where id = 1", ct: Ct));
        Assert.Equal(editsBefore, await EditsAsync(cs));
        Assert.Equal(expected, await RebuiltAsync(cs));
        var trips = await TripsAsync(client2); // newest first
        Assert.Equal(["Portugal 2025"], trips.Take(1).Select(t => t.GetProperty("name").GetString()));
        Assert.Equal([true, false], trips.Select(t => t.GetProperty("edited").GetBoolean()));
    }
}
