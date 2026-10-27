using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Sporer.Api.Features.Trips;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// <c>GET /api/trips</c>. The nights, home periods and trips are written as a refresh writes them (one call of
/// <see cref="TripStore.ReplaceAllAsync"/>), so that each test says exactly what the tables hold; the places are real rows,
/// because the names, cities and positions of the answer are read from them when it is asked for.
/// </summary>
[Collection("db")]
public class TripsEndpointTests(DatabaseFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTime Utc(int month, int day, int hour = 0, int minute = 0) => new(2026, month, day, hour, minute, 0, DateTimeKind.Utc);

    private static DateOnly D(int month, int day) => new(2026, month, day);

    /// <summary>A synthetic Porto: some way from Lisbon.</summary>
    private static readonly GeoPoint Porto = new(41.15, -8.61);

    /// <summary>A place of the stored timeline, at the given position and with the geocoder's city and country if it has any.</summary>
    private static Task<long> PlaceAsync(string cs, GeoPoint at, string? city = null, string? country = null, long? mergedInto = null)
        => TimelineSeeder.InsertPlaceAsync(cs, city: city, country: country, lat: at.Latitude, lon: at.Longitude, mergedInto: mergedInto);

    private static DateTime InstantOf(DateOnly night) => new DateTime(night.Year, night.Month, night.Day, 2, 0, 0, DateTimeKind.Utc).AddDays(1);

    /// <summary>A night located by a stay at a place, at the stay's own position.</summary>
    private static (Night, string) Stay(DateOnly date, long place, GeoPoint at)
        => (new Night(date, InstantOf(date), "Europe/Lisbon", place, at), "stay");

    /// <summary>A night located by a point that matched no place.</summary>
    private static (Night, string) Point(DateOnly date, GeoPoint at)
        => (new Night(date, InstantOf(date), "Europe/Lisbon", null, at), "point");

    /// <summary>A night with no position: nothing was near enough.</summary>
    private static (Night, string) Unknown(DateOnly date)
        => (new Night(date, InstantOf(date), "Europe/Lisbon", null, null), "none");

    private static DetectedTrip Trip(DateOnly first, DateOnly last, DateTime start, DateTime? end, string startZone = "Europe/Oslo", string endZone = "Europe/Oslo")
        => new(first, last, last.DayNumber - first.DayNumber + 1, start, end, startZone, endZone, LocalTime.LocalDate(start, startZone),
            end is { } over ? LocalTime.LocalDate(over, endZone) : last.AddDays(1));

    /// <summary>Writes nights, homes and trips together, as the refresh does.</summary>
    private static Task StoreAsync(
        ApiFactory api, IReadOnlyList<(Night, string)> nights, IReadOnlyList<HomePeriod> homes, params DetectedTrip[] trips)
        => api.Services.GetRequiredService<TripStore>().ReplaceAllAsync(
            nights.Count == 0 ? D(1, 1) : nights.Min(n => n.Item1.Date), nights.Count == 0 ? D(1, 1) : nights.Max(n => n.Item1.Date),
            nights, homes, trips, Ct);

    private static async Task<HttpResponseMessage> GetAsync(HttpClient client, string? ifNoneMatch = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/trips");
        if (ifNoneMatch is not null)
            request.Headers.TryAddWithoutValidation("If-None-Match", ifNoneMatch);
        return await client.SendAsync(request, Ct);
    }

    /// <summary>GETs the trips, expects 200 and returns the parsed body (the caller disposes it).</summary>
    private static async Task<JsonDocument> GetTripsAsync(HttpClient client)
    {
        var response = await GetAsync(client);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"GET /api/trips returned {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text);
    }

    private static List<JsonElement> TripsOf(JsonDocument body) => [.. body.RootElement.GetProperty("trips").EnumerateArray()];

    private static double[][] Line(JsonElement thumbnail) => JsonSerializer.Deserialize<double[][]>(thumbnail.GetRawText())!;

    /// <summary>A position as the response writes it: <c>[lon, lat]</c>.</summary>
    private static double[] LonLat(GeoPoint p) => [p.Longitude, p.Latitude];

    private static List<(string Name, string Country, int Nights)> CitiesOf(JsonElement trip) => [.. trip.GetProperty("cities").EnumerateArray()
        .Select(c => (c.GetProperty("name").GetString()!, c.GetProperty("country").GetString()!, c.GetProperty("nights").GetInt32()))];

    // ---- the list ----------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Trips_lists_newest_first_with_names_cities_nights_and_thumbnail()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // starting the host runs the migrations
        var home = await PlaceAsync(cs, Spots.Home, "Oslo", "Norway");
        var lisbon = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal");
        var porto = await PlaceAsync(cs, Porto, "Porto", "Portugal");
        var lisbonLater = Geo.Offset(Spots.Lisbon, 0, 400); // the second night's stay, 400 m from the first
        await StoreAsync(api,
            [
                // July: three nights in Lisbon.
                Stay(D(7, 9), lisbon, Spots.Lisbon), Stay(D(7, 10), lisbon, Spots.Lisbon), Stay(D(7, 11), lisbon, Spots.Lisbon),
                // September: two nights in Lisbon, one with no position, one with no row at all, two in Porto.
                Stay(D(9, 12), lisbon, Spots.Lisbon), Stay(D(9, 13), lisbon, lisbonLater), Unknown(D(9, 14)),
                Stay(D(9, 16), porto, Porto), Stay(D(9, 17), porto, Porto),
            ],
            [new HomePeriod(home, D(1, 1), null)],
            Trip(D(7, 9), D(7, 11), Utc(7, 9, 7), Utc(7, 12, 14)),
            Trip(D(9, 12), D(9, 17), Utc(9, 12, 15, 20), Utc(9, 18, 19, 5)));

        using var body = await GetTripsAsync(client);

        var trips = TripsOf(body);
        Assert.Equal(["2026-09-12", "2026-07-09"], trips.Select(t => t.GetProperty("id").GetString())); // newest first

        var september = trips[0];
        Assert.Equal("Lisbon & Porto", september.GetProperty("name").GetString()); // two nights each: Lisbon's came first
        Assert.Equal("2026-09-12", september.GetProperty("firstNight").GetString());
        Assert.Equal("2026-09-17", september.GetProperty("lastNight").GetString());
        Assert.Equal(6, september.GetProperty("nights").GetInt32()); // the two nights with no position are nights of the trip
        Assert.Equal("2026-09-12T15:20:00Z", september.GetProperty("start").GetString());
        Assert.Equal("2026-09-18T19:05:00Z", september.GetProperty("end").GetString());
        Assert.Equal("Europe/Oslo", september.GetProperty("startTimeZone").GetString());
        Assert.Equal("Europe/Oslo", september.GetProperty("endTimeZone").GetString());
        Assert.Equal("2026-09-12", september.GetProperty("localStartDate").GetString());
        Assert.Equal("2026-09-18", september.GetProperty("localEndDate").GetString());
        Assert.False(september.GetProperty("ongoing").GetBoolean());

        // Cities: one per city and country, the nights that are known, each at the mean of its nights' positions.
        var cities = september.GetProperty("cities").EnumerateArray().ToList();
        Assert.Equal(new[] { ("Lisbon", "Portugal", 2), ("Porto", "Portugal", 2) }, CitiesOf(september));
        Assert.Equal((Spots.Lisbon.Latitude + lisbonLater.Latitude) / 2, cities[0].GetProperty("lat").GetDouble(), 10);
        Assert.Equal((Spots.Lisbon.Longitude + lisbonLater.Longitude) / 2, cities[0].GetProperty("lon").GetDouble(), 10);
        Assert.Equal(Porto.Latitude, cities[1].GetProperty("lat").GetDouble());
        Assert.Equal(Porto.Longitude, cities[1].GetProperty("lon").GetDouble());

        // Thumbnail: home, Lisbon (the second night is 400 m on, the same point), Porto (twice), home.
        Assert.Equal([LonLat(Spots.Home), LonLat(Spots.Lisbon), LonLat(Porto), LonLat(Spots.Home)], Line(september.GetProperty("thumbnail")));

        var july = trips[1];
        Assert.Equal("Lisbon", july.GetProperty("name").GetString());
        Assert.Equal(3, july.GetProperty("nights").GetInt32());
        Assert.Equal(new[] { ("Lisbon", "Portugal", 3) }, CitiesOf(july));
        Assert.Equal([LonLat(Spots.Home), LonLat(Spots.Lisbon), LonLat(Spots.Home)], Line(july.GetProperty("thumbnail")));
    }

    [Fact]
    public async Task Trips_ongoing_trip_has_no_end()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await PlaceAsync(cs, Spots.Home, "Oslo", "Norway");
        var lisbon = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal");
        await StoreAsync(api,
            [Stay(D(10, 20), lisbon, Spots.Lisbon), Stay(D(10, 21), lisbon, Spots.Lisbon), Stay(D(10, 22), lisbon, Spots.Lisbon)],
            [new HomePeriod(home, D(1, 1), null)],
            Trip(D(10, 20), D(10, 22), Utc(10, 20, 8), null));

        using var body = await GetTripsAsync(client);

        var trip = Assert.Single(TripsOf(body));
        Assert.True(trip.GetProperty("ongoing").GetBoolean());
        Assert.Equal(JsonValueKind.Null, trip.GetProperty("end").ValueKind); // present, and null
        Assert.Equal("2026-10-20T08:00:00Z", trip.GetProperty("start").GetString());
        Assert.Equal("2026-10-23", trip.GetProperty("localEndDate").GetString()); // the day after the last night
        Assert.Equal("Lisbon", trip.GetProperty("name").GetString());
    }

    [Fact]
    public async Task Trips_name_follows_geocoding_without_reprocessing()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await PlaceAsync(cs, Spots.Home, "Oslo", "Norway");
        var lisbon = await PlaceAsync(cs, Spots.Lisbon); // not named yet
        await StoreAsync(api,
            [Stay(D(9, 12), lisbon, Spots.Lisbon), Stay(D(9, 13), lisbon, Spots.Lisbon)],
            [new HomePeriod(home, D(1, 1), null)],
            Trip(D(9, 12), D(9, 13), Utc(9, 12, 7), Utc(9, 14, 12)));
        var before = await GetAsync(client);
        using (var body = JsonDocument.Parse(await before.Content.ReadAsStringAsync(Ct)))
        {
            var trip = Assert.Single(TripsOf(body));
            Assert.Equal("Trip", trip.GetProperty("name").GetString()); // nothing to name it by yet
            Assert.Empty(CitiesOf(trip));
            Assert.Equal(3, trip.GetProperty("thumbnail").GetArrayLength()); // it is still drawn: its nights have positions
        }

        // The geocoder names the place later: the country first, then the city. Nothing is refreshed.
        await Sql.ExecAsync(cs, "update place set country = 'Portugal' where id = @lisbon", new { lisbon }, Ct);
        using (var body = await GetTripsAsync(client))
        {
            var trip = Assert.Single(TripsOf(body));
            Assert.Equal("Portugal", trip.GetProperty("name").GetString());
            Assert.Equal(new[] { ("Portugal", "Portugal", 2) }, CitiesOf(trip)); // a night with no city is grouped under its country
        }

        await Sql.ExecAsync(cs, "update place set city = 'Lisbon' where id = @lisbon", new { lisbon }, Ct);
        var after = await GetAsync(client);
        using (var body = JsonDocument.Parse(await after.Content.ReadAsStringAsync(Ct)))
        {
            var trip = Assert.Single(TripsOf(body));
            Assert.Equal("Lisbon", trip.GetProperty("name").GetString());
            Assert.Equal(new[] { ("Lisbon", "Portugal", 2) }, CitiesOf(trip));
        }

        Assert.NotEqual(before.Headers.ETag, after.Headers.ETag); // the body changed, so the tag did
        Assert.Equal((null, null), await PendingAsync(cs)); // no refresh was asked for
        Assert.Equal(["2026-09-12"], await Sql.QueryAsync<string>(cs, "select id::text from trip", ct: Ct));
    }

    private sealed record PendingRow(DateTime? FromUtc, DateTime? ToUtc);

    private static async Task<(DateTime? From, DateTime? To)> PendingAsync(string cs)
    {
        var row = (await Sql.QueryAsync<PendingRow>(cs, "select from_utc as FromUtc, to_utc as ToUtc from night_refresh where id = 1", ct: Ct)).Single();
        return (row.FromUtc, row.ToUtc);
    }

    [Fact]
    public async Task Trips_take_city_and_country_from_the_place_a_merged_one_ended_up_at()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await PlaceAsync(cs, Spots.Home, "Oslo", "Norway");
        var survivor = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal");
        // Two merges, one into the next: the night names the first, which has a city of its own that is not the answer.
        var middle = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 100, 0), "Almada", "Portugal", mergedInto: survivor);
        var merged = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 200, 0), "Setubal", "Spain", mergedInto: middle);
        await StoreAsync(api,
            [Stay(D(9, 12), merged, Spots.Lisbon), Stay(D(9, 13), middle, Spots.Lisbon), Stay(D(9, 14), survivor, Spots.Lisbon)],
            [new HomePeriod(home, D(1, 1), null)],
            Trip(D(9, 12), D(9, 14), Utc(9, 12, 7), Utc(9, 15, 12)));

        using var body = await GetTripsAsync(client);

        var trip = Assert.Single(TripsOf(body));
        Assert.Equal("Lisbon", trip.GetProperty("name").GetString());
        Assert.Equal(new[] { ("Lisbon", "Portugal", 3) }, CitiesOf(trip));
    }

    [Fact]
    public async Task Trips_treat_a_place_whose_merges_never_end_as_no_place()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await PlaceAsync(cs, Spots.Home, "Oslo", "Norway");
        var first = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal");
        var second = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal", mergedInto: first);
        await Sql.ExecAsync(cs, "update place set merged_into_id = @second where id = @first", new { first, second }, Ct); // the app never does this
        await StoreAsync(api, [Stay(D(9, 12), first, Spots.Lisbon)], [new HomePeriod(home, D(1, 1), null)],
            Trip(D(9, 12), D(9, 12), Utc(9, 12, 7), Utc(9, 13, 12)));

        using var body = await GetTripsAsync(client);

        var trip = Assert.Single(TripsOf(body));
        Assert.Equal("Trip", trip.GetProperty("name").GetString());
        Assert.Empty(CitiesOf(trip));
        Assert.Equal([LonLat(Spots.Home), LonLat(Spots.Lisbon), LonLat(Spots.Home)], Line(trip.GetProperty("thumbnail")));
    }

    [Fact]
    public async Task Trips_draw_a_night_without_a_place_but_do_not_name_it()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await PlaceAsync(cs, Spots.Home, "Oslo", "Norway");
        var lisbon = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal");
        await StoreAsync(api,
            [Stay(D(9, 12), lisbon, Spots.Lisbon), Point(D(9, 13), Porto)],
            [new HomePeriod(home, D(1, 1), null)],
            Trip(D(9, 12), D(9, 13), Utc(9, 12, 7), Utc(9, 14, 12)));

        using var body = await GetTripsAsync(client);

        var trip = Assert.Single(TripsOf(body));
        Assert.Equal("Lisbon", trip.GetProperty("name").GetString());
        Assert.Equal(new[] { ("Lisbon", "Portugal", 1) }, CitiesOf(trip));
        Assert.Equal([LonLat(Spots.Home), LonLat(Spots.Lisbon), LonLat(Porto), LonLat(Spots.Home)], Line(trip.GetProperty("thumbnail")));
    }

    // ---- the home of the thumbnail ---------------------------------------------------------------------------------

    [Fact]
    public async Task Trips_thumbnail_starts_at_the_home_of_the_first_night_and_ends_at_the_home_of_the_last()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var oldHomeAt = Spots.Home;
        var newHomeAt = Geo.Offset(Spots.Home, 7000, 0); // the person moved house during the trip
        var oldHome = await PlaceAsync(cs, oldHomeAt);
        var newHome = await PlaceAsync(cs, newHomeAt);
        var lisbon = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal");
        await StoreAsync(api,
            [Stay(D(9, 12), lisbon, Spots.Lisbon), Stay(D(9, 13), lisbon, Spots.Lisbon), Stay(D(9, 14), lisbon, Spots.Lisbon)],
            [new HomePeriod(oldHome, D(1, 1), D(9, 12)), new HomePeriod(newHome, D(9, 13), null)], // the old home covers the first night only
            Trip(D(9, 12), D(9, 14), Utc(9, 12, 7), Utc(9, 15, 12)));

        using var body = await GetTripsAsync(client);

        var trip = Assert.Single(TripsOf(body));
        Assert.Equal([LonLat(oldHomeAt), LonLat(Spots.Lisbon), LonLat(newHomeAt)], Line(trip.GetProperty("thumbnail")));
    }

    [Fact]
    public async Task Trips_thumbnail_leaves_out_an_end_that_no_home_period_covers()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await PlaceAsync(cs, Spots.Home);
        var lisbon = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal");
        await StoreAsync(api,
            [
                Stay(D(9, 12), lisbon, Spots.Lisbon), Stay(D(9, 13), lisbon, Spots.Lisbon),
                Stay(D(10, 12), lisbon, Spots.Lisbon), Stay(D(10, 13), lisbon, Spots.Lisbon),
            ],
            [new HomePeriod(home, D(9, 12), D(9, 12)), new HomePeriod(home, D(10, 13), null)], // the home covers the first night of one, the last of the other
            Trip(D(9, 12), D(9, 13), Utc(9, 12, 7), Utc(9, 14, 12)),
            Trip(D(10, 12), D(10, 13), Utc(10, 12, 7), Utc(10, 14, 12)));

        using var body = await GetTripsAsync(client);

        var trips = TripsOf(body);
        Assert.Equal([LonLat(Spots.Lisbon), LonLat(Spots.Home)], Line(trips[0].GetProperty("thumbnail"))); // October: no home on the 12th
        Assert.Equal([LonLat(Spots.Home), LonLat(Spots.Lisbon)], Line(trips[1].GetProperty("thumbnail"))); // September: none on the 13th
    }

    [Fact]
    public async Task Trips_thumbnail_without_any_home_is_the_nights()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var lisbon = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal");
        await StoreAsync(api, [Stay(D(9, 12), lisbon, Spots.Lisbon)], [], Trip(D(9, 12), D(9, 12), Utc(9, 12, 7), Utc(9, 13, 12)));

        using var body = await GetTripsAsync(client);

        Assert.Equal([LonLat(Spots.Lisbon)], Line(Assert.Single(TripsOf(body)).GetProperty("thumbnail")));
    }

    [Fact]
    public async Task Trips_thumbnail_follows_a_merged_home_to_the_place_it_ended_up_at()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var survivorAt = Geo.Offset(Spots.Home, 50, 0);
        var survivor = await PlaceAsync(cs, survivorAt);
        var merged = await PlaceAsync(cs, Spots.Home, mergedInto: survivor); // the home period still names this one
        var lisbon = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal");
        await StoreAsync(api, [Stay(D(9, 12), lisbon, Spots.Lisbon)], [new HomePeriod(merged, D(1, 1), null)],
            Trip(D(9, 12), D(9, 12), Utc(9, 12, 7), Utc(9, 13, 12)));

        using var body = await GetTripsAsync(client);

        Assert.Equal([LonLat(survivorAt), LonLat(Spots.Lisbon), LonLat(survivorAt)], Line(Assert.Single(TripsOf(body)).GetProperty("thumbnail")));
    }

    [Fact]
    public async Task Trips_thumbnail_prefers_the_home_the_owner_set_where_periods_overlap()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var detected = await PlaceAsync(cs, Spots.Home);
        var owners = await PlaceAsync(cs, Geo.Offset(Spots.Home, 7000, 0));
        var lisbon = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal");
        await StoreAsync(api, [Stay(D(9, 12), lisbon, Spots.Lisbon)], [new HomePeriod(detected, D(1, 1), null)],
            Trip(D(9, 12), D(9, 12), Utc(9, 12, 7), Utc(9, 13, 12)));
        await Sql.ExecAsync(cs, "insert into home_period (place_id, from_date, to_date, source) values (@owners, '2026-09-01', '2026-09-30', 'user')",
            new { owners }, Ct);

        using var body = await GetTripsAsync(client);

        var ownersAt = Geo.Offset(Spots.Home, 7000, 0);
        Assert.Equal([LonLat(ownersAt), LonLat(Spots.Lisbon), LonLat(ownersAt)], Line(Assert.Single(TripsOf(body)).GetProperty("thumbnail")));
    }

    // ---- nothing, and the cache ----------------------------------------------------------------------------------------

    [Fact]
    public async Task Trips_empty_database_gives_an_empty_list()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();

        var response = await GetAsync(client);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("""{"trips":[]}""", await response.Content.ReadAsStringAsync(Ct));
    }

    [Fact]
    public async Task Trips_answers_with_an_etag_and_304()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await PlaceAsync(cs, Spots.Home);
        var lisbon = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal");
        await StoreAsync(api, [Stay(D(9, 12), lisbon, Spots.Lisbon)], [new HomePeriod(home, D(1, 1), null)],
            Trip(D(9, 12), D(9, 12), Utc(9, 12, 7), Utc(9, 13, 12)));

        var first = await GetAsync(client);

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var etag = first.Headers.ETag;
        Assert.NotNull(etag);
        Assert.False(etag.IsWeak);
        Assert.Equal("no-cache", first.Headers.CacheControl?.ToString());
        Assert.Equal("application/json", first.Content.Headers.ContentType?.MediaType);

        var second = await GetAsync(client, ifNoneMatch: etag.ToString());

        Assert.Equal(HttpStatusCode.NotModified, second.StatusCode);
        Assert.Equal(string.Empty, await second.Content.ReadAsStringAsync(Ct));
        Assert.Equal(etag, second.Headers.ETag);
    }
}
