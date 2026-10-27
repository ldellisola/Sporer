using System.Net;
using System.Text.Json;
using Sporer.Testing;
using Sporer.Timeline;
using static Sporer.Api.Tests.TripSeeder;

namespace Sporer.Api.Tests;

/// <summary>
/// <c>GET /api/trips/{id}</c>. The nights, homes and trips are written as a refresh writes them and the stays and moves are
/// written as the processor leaves them (the local dates are worked out from the times, as it does), so that each test says
/// exactly what the tables hold; the answer is made from them, and from the places, when it is asked for.
/// </summary>
[Collection("db")]
public class TripEndpointTests(DatabaseFixture db)
{
    private const string Oslo = "Europe/Oslo";
    private const string Lisbon = "Europe/Lisbon";

    /// <summary>A line from Oslo to Lisbon, as <c>[[lon,lat],...]</c>.</summary>
    private const string FlightLine = "[[10.7,59.9],[-9.1,38.7]]";

    private const string WalkLine = "[[-9.14,38.71],[-9.15,38.7]]";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>A stay, with the local dates of its start and end in <paramref name="zone"/>. Times are UTC.</summary>
    private static Task<long> StayAsync(string cs, long? place, DateTime start, DateTime end, string zone = Lisbon)
        => TimelineSeeder.InsertSegmentAsync(
            cs, "stay", start, end, LocalTime.LocalDate(start, zone), LocalTime.LocalDate(end, zone), zone, placeId: place);

    /// <summary>A move, with the local dates of its start in <paramref name="startZone"/> and of its end in <paramref name="endZone"/>.</summary>
    private static Task<long> MoveAsync(
        string cs, string? mode, DateTime start, DateTime end, double? distance, string startZone = Lisbon, string? endZone = null,
        string geometry = WalkLine)
        => TimelineSeeder.InsertSegmentAsync(
            cs, "move", start, end, LocalTime.LocalDate(start, startZone), LocalTime.LocalDate(end, endZone ?? startZone), startZone, endZone,
            mode: mode, distance: distance, geometry: geometry);

    private static async Task<HttpResponseMessage> GetAsync(HttpClient client, string url, string? ifNoneMatch = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        if (ifNoneMatch is not null)
            request.Headers.TryAddWithoutValidation("If-None-Match", ifNoneMatch);
        return await client.SendAsync(request, Ct);
    }

    /// <summary>GETs a URL, expects 200 and returns the parsed body (the caller disposes it).</summary>
    private static async Task<JsonDocument> GetJsonAsync(HttpClient client, string url)
    {
        var response = await GetAsync(client, url);
        var text = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"GET {url} returned {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text);
    }

    private static Task<JsonDocument> GetTripAsync(HttpClient client, string id) => GetJsonAsync(client, $"/api/trips/{id}");

    private static List<JsonElement> DaysOf(JsonDocument body) => [.. body.RootElement.GetProperty("days").EnumerateArray()];

    private static List<JsonElement> MovesOf(JsonDocument body) => [.. body.RootElement.GetProperty("moves").EnumerateArray()];

    private static string[] Highlights(JsonElement day) => [.. day.GetProperty("highlights").EnumerateArray().Select(h => h.GetString()!)];

    private static double[][] Line(JsonElement geometry) => JsonSerializer.Deserialize<double[][]>(geometry.GetRawText())!;

    private static double[][] LineOf(string json) => JsonSerializer.Deserialize<double[][]>(json)!;

    // ---- the whole answer --------------------------------------------------------------------------------------------

    [Fact]
    public async Task Trip_detail_returns_stats_moves_and_days_in_order()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient(); // starting the host runs the migrations
        var home = await PlaceAsync(cs, Spots.Home, "Oslo", "Norway");
        var airport = await PlaceAsync(cs, Geo.Offset(Spots.Home, 30_000, 0), "Oslo", "Norway", osmName: "Oslo Airport");
        var hotel = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal", osmName: "Hotel Avenida");
        // The owner's name for a place wins over OpenStreetMap's.
        var market = await PlaceAsync(
            cs, Geo.Offset(Spots.Lisbon, 500, 500), "Lisbon", "Portugal", osmName: "Mercado da Ribeira", userName: "Time Out Market");
        var tower = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 300, -4000), "Lisbon", "Portugal", osmName: "Belem Tower");
        await StoreAsync(api,
            [Stay(D(9, 11), home, Spots.Home), Stay(D(9, 12), hotel, Spots.Lisbon), Stay(D(9, 13), hotel, Spots.Lisbon), Stay(D(9, 14), home, Spots.Home)],
            [new HomePeriod(home, D(1, 1), null)],
            // Left home at 10:00 on the 12th (Oslo), came back at 12:00 on the 14th.
            Trip(D(9, 12), D(9, 13), Utc(9, 12, 8), Utc(9, 14, 10)));

        // Day one: the stay at home ends as the trip starts, and the last one begins as it ends: neither is in the trip.
        await StayAsync(cs, home, Utc(9, 11, 20), Utc(9, 12, 8), Oslo);
        var toAirport = await MoveAsync(cs, "drive", Utc(9, 12, 8), Utc(9, 12, 8, 40), 3200, Oslo);
        await StayAsync(cs, airport, Utc(9, 12, 8, 40), Utc(9, 12, 10), Oslo);
        var flightOut = await MoveAsync(cs, "flight", Utc(9, 12, 10), Utc(9, 12, 13), 2_738_800, Oslo, Lisbon, FlightLine);
        await StayAsync(cs, hotel, Utc(9, 12, 13), Utc(9, 13, 8)); // across midnight: it is part of both days
        // Day two.
        var toMarket = await MoveAsync(cs, "walk", Utc(9, 13, 8), Utc(9, 13, 8, 20), 1000);
        await StayAsync(cs, market, Utc(9, 13, 8, 20), Utc(9, 13, 10, 20));
        var toTower = await MoveAsync(cs, "walk", Utc(9, 13, 10, 20), Utc(9, 13, 10, 40), 800);
        await StayAsync(cs, tower, Utc(9, 13, 10, 40), Utc(9, 13, 11, 30));
        await StayAsync(cs, hotel, Utc(9, 13, 12), Utc(9, 14, 7));
        // Day three: the flight home.
        var flightBack = await MoveAsync(cs, "flight", Utc(9, 14, 7), Utc(9, 14, 10), 2_700_000, Lisbon, Oslo, FlightLine);
        await StayAsync(cs, home, Utc(9, 14, 10), Utc(9, 15, 6), Oslo);

        using var body = await GetTripAsync(client, "2026-09-12");

        var trip = body.RootElement;
        Assert.Equal("2026-09-12", trip.GetProperty("id").GetString());
        Assert.Equal("Lisbon", trip.GetProperty("name").GetString());
        Assert.Equal("2026-09-12", trip.GetProperty("firstNight").GetString());
        Assert.Equal("2026-09-13", trip.GetProperty("lastNight").GetString());
        Assert.Equal(2, trip.GetProperty("nights").GetInt32());
        Assert.Equal("2026-09-12T08:00:00Z", trip.GetProperty("start").GetString());
        Assert.Equal("2026-09-14T10:00:00Z", trip.GetProperty("end").GetString());
        Assert.Equal("2026-09-12", trip.GetProperty("localStartDate").GetString());
        Assert.Equal("2026-09-14", trip.GetProperty("localEndDate").GetString());
        Assert.False(trip.GetProperty("ongoing").GetBoolean());
        var city = Assert.Single(trip.GetProperty("cities").EnumerateArray());
        Assert.Equal(("Lisbon", "Portugal", 2), (city.GetProperty("name").GetString()!, city.GetProperty("country").GetString()!, city.GetProperty("nights").GetInt32()));
        Assert.Equal(Spots.Lisbon.Latitude, city.GetProperty("lat").GetDouble());
        Assert.Equal(Spots.Lisbon.Longitude, city.GetProperty("lon").GetDouble());

        // What it has of a list item is what the list says of the trip, and the thumbnail is the list's alone.
        using var list = await GetJsonAsync(client, "/api/trips");
        var item = Assert.Single(list.RootElement.GetProperty("trips").EnumerateArray());
        Assert.All(item.EnumerateObject().Where(p => p.Name != "thumbnail"),
            p => Assert.Equal(p.Value.GetRawText(), trip.GetProperty(p.Name).GetRawText()));
        Assert.False(trip.TryGetProperty("thumbnail", out _));

        // Stats: two flights; two cities (Oslo, Lisbon) and four places (not home) of the stays; the ground distance is the drive and the walks.
        var stats = trip.GetProperty("stats");
        Assert.Equal(2, stats.GetProperty("flights").GetInt32());
        Assert.Equal(2, stats.GetProperty("cities").GetInt32());
        Assert.Equal(4, stats.GetProperty("places").GetInt32());
        Assert.Equal(3200.0 + 1000 + 800, stats.GetProperty("groundDistanceMeters").GetDouble());

        // Moves: those of the span, in time order, with the stored line (within the budget, it is not simplified).
        var moves = MovesOf(body);
        Assert.Equal([toAirport, flightOut, toMarket, toTower, flightBack], moves.Select(m => m.GetProperty("id").GetInt64()));
        Assert.Equal(["drive", "flight", "walk", "walk", "flight"], moves.Select(m => m.GetProperty("mode").GetString()));
        Assert.Equal([3200.0, 2_738_800, 1000, 800, 2_700_000], moves.Select(m => m.GetProperty("distanceMeters").GetDouble()));
        Assert.Equal(LineOf(FlightLine), Line(moves[1].GetProperty("geometry")));
        Assert.Equal(LineOf(WalkLine), Line(moves[2].GetProperty("geometry")));

        // Days: every local date from the start to the end, in order.
        var days = DaysOf(body);
        Assert.Equal(["2026-09-12", "2026-09-13", "2026-09-14"], days.Select(d => d.GetProperty("date").GetString()));
        Assert.Equal(["Oslo → Lisbon", "Lisbon", "Lisbon"], days.Select(d => d.GetProperty("description").GetString()));
        // The hotel is where the nights were spent, so it is not a highlight, though it has the most time: the airport is the first
        // day's, the market and the tower the second's, and on the last day there is nothing else.
        Assert.Equal(["Oslo Airport"], Highlights(days[0]));
        Assert.Equal(["Time Out Market", "Belem Tower"], Highlights(days[1]));
        Assert.Empty(Highlights(days[2]));
        // Ground distance is of the moves that start on the day, flights of those that touch it.
        Assert.Equal([3200.0, 1800, 0], days.Select(d => d.GetProperty("groundDistanceMeters").GetDouble()));
        Assert.Equal([1, 0, 1], days.Select(d => d.GetProperty("flights").GetInt32()));
    }

    [Fact]
    public async Task Trip_detail_day_line_collapses_repeated_cities_and_falls_back()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var central = await PlaceAsync(cs, Spots.Home, "Oslo", "Norway", osmName: "Oslo Central");
        var harbour = await PlaceAsync(cs, Geo.Offset(Spots.Home, 800, 0), "Oslo", "Norway", osmName: "Aker Brygge");
        var hotel = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal", osmName: "Hotel");
        var cafe = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 400, 0), "Lisbon", "Portugal", osmName: "Cafe");
        var hutA = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 90_000, 0), country: "Portugal", osmName: "Hut A"); // no city
        var hutB = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 91_000, 0), country: "Portugal", osmName: "Hut B");
        var nowhere = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 92_000, 0)); // not geocoded: no city, no country, no name
        await StoreAsync(api, [], [], Trip(D(9, 12), D(9, 14), Utc(9, 12, 6), Utc(9, 15, 20), Lisbon, Lisbon));
        // Day one: two stays in Oslo and two in Lisbon.
        await StayAsync(cs, central, Utc(9, 12, 7), Utc(9, 12, 8));
        await StayAsync(cs, harbour, Utc(9, 12, 8, 15), Utc(9, 12, 9));
        await StayAsync(cs, hotel, Utc(9, 12, 12), Utc(9, 12, 14));
        await StayAsync(cs, cafe, Utc(9, 12, 14, 30), Utc(9, 12, 16));
        // Day two: no city anywhere, so the names; a stay at a place with none of them says nothing.
        await StayAsync(cs, hutA, Utc(9, 13, 8), Utc(9, 13, 11));
        await StayAsync(cs, nowhere, Utc(9, 13, 11, 30), Utc(9, 13, 12));
        await StayAsync(cs, hutB, Utc(9, 13, 12, 30), Utc(9, 13, 13, 30));
        // Day three: only a drive. Day four: no stay and no move, only a gap, which says nothing of where the person was.
        await MoveAsync(cs, "drive", Utc(9, 14, 10), Utc(9, 14, 11), 90_000);
        await TimelineSeeder.InsertSegmentAsync(cs, "gap", Utc(9, 15, 8), Utc(9, 15, 12), D(9, 15), D(9, 15), Lisbon);

        using var body = await GetTripAsync(client, "2026-09-12");

        var days = DaysOf(body);
        Assert.Equal(["2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"], days.Select(d => d.GetProperty("date").GetString()));
        Assert.Equal(["Oslo → Lisbon", "Hut A → Hut B", "Travelling", "No data"], days.Select(d => d.GetProperty("description").GetString()));
        Assert.Equal(["Hut A", "Hut B"], Highlights(days[1])); // the place with no name is no highlight, and has the least time anyway
        Assert.Empty(Highlights(days[2]));
        Assert.Empty(Highlights(days[3]));
    }

    // ---- the highlights ----------------------------------------------------------------------------------------------

    [Fact]
    public async Task Trip_detail_highlights_leave_out_the_night_place()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var hotelA = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal", osmName: "Hotel A");
        var hotelB = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 5000, 0), "Lisbon", "Portugal", osmName: "Hotel B");
        // The night of the 13th was stored under a place that was merged into hotel B afterwards: the stays are at hotel B.
        var hotelBOld = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 5010, 0), "Lisbon", "Portugal", osmName: "Hotel B", mergedInto: hotelB);
        var museum = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 1000, 0), "Lisbon", "Portugal", osmName: "Museum");
        var park = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 1500, 0), "Lisbon", "Portugal", osmName: "Park");
        var coffee = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 2000, 0), "Lisbon", "Portugal", osmName: "Coffee");
        var station = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 2500, 0), "Lisbon", "Portugal", osmName: "Station");
        var unnamed = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 3000, 0), "Lisbon", "Portugal"); // has the most time and no name
        var shop = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 3500, 0), "Lisbon", "Portugal", osmName: "Souvenir shop");
        await StoreAsync(api,
            [Stay(D(9, 12), hotelA, Spots.Lisbon), Stay(D(9, 13), hotelBOld, Geo.Offset(Spots.Lisbon, 5010, 0))], // none stored for the 14th
            [], Trip(D(9, 12), D(9, 13), Utc(9, 12, 12), Utc(9, 14, 12), Lisbon, Lisbon));
        await StayAsync(cs, hotelA, Utc(9, 12, 20), Utc(9, 13, 7)); // the night of the 12th
        // The 13th, in Lisbon (UTC+1): the morning at the hotel, then four named places and one with no name, the evening at hotel B.
        await StayAsync(cs, coffee, Utc(9, 13, 7, 30), Utc(9, 13, 8, 30)); // 1 h
        await StayAsync(cs, museum, Utc(9, 13, 9), Utc(9, 13, 12)); // 3 h
        await StayAsync(cs, unnamed, Utc(9, 13, 12, 15), Utc(9, 13, 17, 15)); // 5 h
        await StayAsync(cs, park, Utc(9, 13, 17, 30), Utc(9, 13, 19, 30)); // 2 h
        await StayAsync(cs, station, Utc(9, 13, 19, 45), Utc(9, 13, 20, 15)); // 30 min: the fourth, and left out
        await StayAsync(cs, hotelB, Utc(9, 13, 20, 30), Utc(9, 14, 7, 30)); // the night of the 13th
        await StayAsync(cs, shop, Utc(9, 14, 8), Utc(9, 14, 9));

        using var body = await GetTripAsync(client, "2026-09-12");

        var days = DaysOf(body);
        Assert.Equal(["2026-09-12", "2026-09-13", "2026-09-14"], days.Select(d => d.GetProperty("date").GetString()));
        Assert.Empty(Highlights(days[0])); // hotel A, where the night of the 12th was, is all there is
        // The most time first, three at most; hotel A (the night before) and hotel B (tonight, by the place it ended up at) are left out.
        Assert.Equal(["Museum", "Park", "Coffee"], Highlights(days[1]));
        // On the 14th the night before was at hotel B, and the night of the 14th is not known: hotel B is left out and nothing else.
        Assert.Equal(["Souvenir shop"], Highlights(days[2]));
    }

    [Fact]
    public async Task Trip_detail_highlights_clip_stays_to_the_trip_and_count_one_across_midnight_in_full_on_each_day()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var camp = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal", osmName: "Old Camp");
        var beach = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 1000, 0), "Lisbon", "Portugal", osmName: "Beach");
        var bar = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 2000, 0), "Lisbon", "Portugal", osmName: "Night Bar");
        var market = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 3000, 0), "Lisbon", "Portugal", osmName: "Market");
        await StoreAsync(api, [], [], Trip(D(9, 12), D(9, 13), Utc(9, 12, 9), Utc(9, 14, 18), Lisbon, Lisbon));
        // The camp was left an hour after the trip began, and was stayed at for a day and more before: only that hour is the trip's.
        await StayAsync(cs, camp, Utc(9, 11), Utc(9, 12, 10));
        await StayAsync(cs, beach, Utc(9, 12, 12), Utc(9, 12, 14)); // 2 h
        // The bar: 22:00 to 04:00 UTC, 23:00 to 05:00 local, six hours on two dates. The market is five and a half hours of the 14th.
        await StayAsync(cs, bar, Utc(9, 13, 22), Utc(9, 14, 4));
        await StayAsync(cs, market, Utc(9, 14, 9), Utc(9, 14, 14, 30));

        using var body = await GetTripAsync(client, "2026-09-12");

        var days = DaysOf(body);
        Assert.Equal(["Beach", "Old Camp"], Highlights(days[0])); // clipped, the camp has an hour to the beach's two
        Assert.Equal(["Night Bar"], Highlights(days[1]));
        // A stay counts in full on each date it touches: six hours of the bar to five and a half of the market, though only
        // five hours of the bar fall on the 14th.
        Assert.Equal(["Night Bar", "Market"], Highlights(days[2]));
    }

    // ---- the numbers -------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Trip_detail_stats_count_distinct_cities_and_places_through_merges()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var lisbon1 = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal", osmName: "One");
        var lisbon2 = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 1000, 0), "Lisbon", "Portugal", osmName: "Two");
        // Merged into lisbon2: a stay here is a stay at lisbon2, in Lisbon, whatever this one says.
        var merged = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 1010, 0), "Almada", "Spain", mergedInto: lisbon2);
        var singaporeCountry = await PlaceAsync(cs, Spots.Tokyo, country: "Singapore"); // no city: counts as the country
        var singaporeCity = await PlaceAsync(cs, Geo.Offset(Spots.Tokyo, 1000, 0), "Singapore", "Singapore");
        var nowhere = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 50_000, 0), osmName: "Nowhere"); // a place, but no city and no country
        await StoreAsync(api, [], [], Trip(D(9, 12), D(9, 12), Utc(9, 12, 6), Utc(9, 13, 18), Lisbon, Lisbon));
        await StayAsync(cs, lisbon1, Utc(9, 12, 7), Utc(9, 12, 8));
        await StayAsync(cs, lisbon2, Utc(9, 12, 8, 30), Utc(9, 12, 9));
        await StayAsync(cs, merged, Utc(9, 12, 9, 30), Utc(9, 12, 10));
        await StayAsync(cs, singaporeCountry, Utc(9, 12, 11), Utc(9, 12, 12));
        await StayAsync(cs, singaporeCity, Utc(9, 12, 12, 30), Utc(9, 12, 13));
        await StayAsync(cs, nowhere, Utc(9, 12, 13, 30), Utc(9, 12, 14));
        await StayAsync(cs, null, Utc(9, 12, 14, 30), Utc(9, 12, 15)); // matched no place
        await MoveAsync(cs, "drive", Utc(9, 12, 15), Utc(9, 12, 16), 1500);
        await MoveAsync(cs, "flight", Utc(9, 12, 16), Utc(9, 12, 17), 100_000, geometry: FlightLine);
        await MoveAsync(cs, null, Utc(9, 12, 17), Utc(9, 12, 18), 700); // a mode that could not be told is not a flight
        await MoveAsync(cs, "walk", Utc(9, 12, 18), Utc(9, 12, 18, 30), null); // no distance counts as none

        using var body = await GetTripAsync(client, "2026-09-12");

        var stats = body.RootElement.GetProperty("stats");
        Assert.Equal(1, stats.GetProperty("flights").GetInt32());
        Assert.Equal(2, stats.GetProperty("cities").GetInt32()); // Lisbon, and Singapore once
        Assert.Equal(5, stats.GetProperty("places").GetInt32()); // lisbon1, lisbon2 (the merged stay is there too), both of Singapore, nowhere
        Assert.Equal(1500.0 + 700, stats.GetProperty("groundDistanceMeters").GetDouble());
        var moves = MovesOf(body);
        Assert.Equal(4, moves.Count);
        // A mode that could not be told is no mode (the web reads `mode?: Mode | null`), never a made-up one.
        Assert.Equal(["drive", "flight", null, "walk"], moves.Select(m => m.TryGetProperty("mode", out var mode) ? mode.GetString() : null));
        Assert.Equal([1500.0, 100_000, 700, 0], moves.Select(m => m.GetProperty("distanceMeters").GetDouble()));
    }

    // ---- an ongoing trip ---------------------------------------------------------------------------------------------

    [Fact]
    public async Task Trip_detail_of_an_ongoing_trip_runs_to_the_latest_data()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await PlaceAsync(cs, Spots.Home, "Oslo", "Norway");
        var hotel = await PlaceAsync(cs, Spots.Lisbon, "Lisbon", "Portugal", osmName: "Hotel Avenida");
        var lateCafe = await PlaceAsync(cs, Geo.Offset(Spots.Lisbon, 600, 0), "Lisbon", "Portugal", osmName: "Late Cafe");
        await StoreAsync(api,
            [Stay(D(10, 19), home, Spots.Home), Stay(D(10, 20), hotel, Spots.Lisbon), Stay(D(10, 21), hotel, Spots.Lisbon), Stay(D(10, 22), hotel, Spots.Lisbon)],
            [new HomePeriod(home, D(1, 1), null)],
            Trip(D(10, 20), D(10, 22), Utc(10, 20, 8), null)); // the last night is the night of the 22nd, read at 03:00 on the 23rd
        await StayAsync(cs, home, Utc(10, 19, 18), Utc(10, 20, 8), Oslo); // ends as the trip begins
        var flight = await MoveAsync(cs, "flight", Utc(10, 20, 8), Utc(10, 20, 11), 2_738_800, Oslo, Lisbon, FlightLine);
        await StayAsync(cs, hotel, Utc(10, 20, 11), Utc(10, 23, 2));
        // What came after the last night was read: the person is out and about at 03:00 on the 23rd, and this is the latest data.
        var lateWalk = await MoveAsync(cs, "walk", Utc(10, 23, 2), Utc(10, 23, 2, 30), 500);
        await StayAsync(cs, lateCafe, Utc(10, 23, 2, 30), Utc(10, 23, 6));

        using var body = await GetTripAsync(client, "2026-10-20");

        var trip = body.RootElement;
        Assert.True(trip.GetProperty("ongoing").GetBoolean());
        Assert.Equal(JsonValueKind.Null, trip.GetProperty("end").ValueKind);
        Assert.Equal("2026-10-23", trip.GetProperty("localEndDate").GetString()); // the day after the last night
        var stats = trip.GetProperty("stats");
        Assert.Equal((1, 1, 2, 500.0), (stats.GetProperty("flights").GetInt32(), stats.GetProperty("cities").GetInt32(),
            stats.GetProperty("places").GetInt32(), stats.GetProperty("groundDistanceMeters").GetDouble()));
        Assert.Equal([flight, lateWalk], MovesOf(body).Select(m => m.GetProperty("id").GetInt64())); // the walk is after the last night
        var days = DaysOf(body);
        Assert.Equal(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"], days.Select(d => d.GetProperty("date").GetString()));
        Assert.Equal(["Lisbon", "Lisbon", "Lisbon", "Lisbon"], days.Select(d => d.GetProperty("description").GetString()));
        Assert.Equal([1, 0, 0, 0], days.Select(d => d.GetProperty("flights").GetInt32()));
        Assert.Equal([0.0, 0, 0, 500], days.Select(d => d.GetProperty("groundDistanceMeters").GetDouble()));
        Assert.Equal(["Late Cafe"], Highlights(days[3])); // the night of the 22nd was at the hotel, and the 23rd has none yet
    }

    // ---- the vertex budget -------------------------------------------------------------------------------------------

    [Fact]
    public async Task Trip_detail_moves_respect_the_vertex_budget()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        await StoreAsync(api, [], [], Trip(D(9, 12), D(9, 12), Utc(9, 12, 5), Utc(9, 13, 8), Lisbon, Lisbon));

        // 130 moves of 400 vertices each: 52 000, over the budget of 50 000. A line zig-zags across its base line by its own
        // amplitude, so how much of it a tolerance removes is known: nothing while the tolerance is below the amplitude, all but
        // the two ends from it. A fifth of the moves are of 30 m, and the budget is first met at 100 m, when they go.
        const int moveCount = 130;
        const int vertices = 400;
        double[] amplitudes = [30, 250, 450, 900, 1800];
        var stored = new List<double[][]>();
        var ids = new List<long>();
        for (var k = 0; k < moveCount; k++)
        {
            var line = ZigZag(vertices, amplitudes[k % amplitudes.Length]);
            stored.Add(line);
            var start = Utc(9, 12, 6).AddMinutes(6 * k);
            ids.Add(await MoveAsync(cs, "drive", start, start.AddMinutes(5), 40_000, geometry: JsonSerializer.Serialize(line)));
        }

        using var body = await GetTripAsync(client, "2026-09-12");

        var moves = MovesOf(body);
        Assert.Equal(ids, moves.Select(m => m.GetProperty("id").GetInt64()));
        var lines = moves.Select(m => Line(m.GetProperty("geometry"))).ToList();
        var total = lines.Sum(l => l.Length);
        Assert.InRange(total, 40_000, 50_000); // within the budget, and not simplified further than it had to be
        for (var k = 0; k < moveCount; k++)
        {
            // Every line begins and ends where it did, and keeps only vertices it had, in their order.
            Assert.Equal(stored[k][0], lines[k][0]);
            Assert.Equal(stored[k][^1], lines[k][^1]);
            var at = 0;
            foreach (var point in lines[k])
            {
                while (at < stored[k].Length && !stored[k][at].SequenceEqual(point))
                    at++;
                Assert.True(at < stored[k].Length, $"Move {k} has a vertex that is not on its stored line, or out of order.");
                at++;
            }
        }

        Assert.All(Enumerable.Range(0, moveCount).Where(k => k % amplitudes.Length == 0), k => Assert.Equal(2, lines[k].Length));
        Assert.All(Enumerable.Range(0, moveCount).Where(k => k % amplitudes.Length != 0), k => Assert.Equal(vertices, lines[k].Length));
        // The stored lines are untouched, and the numbers are of the moves, not of what is drawn.
        Assert.Equal(moveCount * vertices, await Sql.ScalarAsync<long>(cs, "select sum(jsonb_array_length(geometry_coarse)) from segment", ct: Ct));
        Assert.Equal(moveCount * 40_000.0, body.RootElement.GetProperty("stats").GetProperty("groundDistanceMeters").GetDouble());
    }

    /// <summary>
    /// A line of <paramref name="count"/> vertices, 100 m apart, east from a base point: the first and the last on the base line,
    /// the ones between alternately <paramref name="amplitudeMeters"/> north and as far south of it.
    /// </summary>
    private static double[][] ZigZag(int count, double amplitudeMeters)
    {
        var origin = new GeoPoint(59.9, 10.7);
        return Enumerable.Range(0, count).Select(k =>
        {
            var offset = k == 0 || k == count - 1 ? 0 : (k % 2 == 0 ? amplitudeMeters : -amplitudeMeters);
            var p = Geo.Offset(origin, offset, 100.0 * k);
            return new[] { Math.Round(p.Longitude, 6), Math.Round(p.Latitude, 6) };
        }).ToArray();
    }

    // ---- no such trip, nothing in it, and the cache ----------------------------------------------------------------------

    [Fact]
    public async Task Trip_detail_unknown_or_malformed_id_is_404()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await PlaceAsync(cs, Spots.Home);
        await StoreAsync(api, [Stay(D(9, 12), home, Spots.Lisbon)], [], Trip(D(9, 12), D(9, 12), Utc(9, 12, 7), Utc(9, 13, 12)));

        // A date that is no trip's first night, even one inside a trip; and what is not a date.
        foreach (var id in new[] { "2026-01-01", "2026-09-13", "abc", "2026-13-45", "2026-02-30", "2026-9-12", "20260912", "2026-09-12x", "12" })
        {
            var response = await GetAsync(client, $"/api/trips/{id}");
            Assert.True(response.StatusCode == HttpStatusCode.NotFound, $"GET /api/trips/{id} returned {(int)response.StatusCode}");
        }

        // The trip that is stored, with no segment at all: it is still a trip, with nothing in it.
        using var body = await GetTripAsync(client, "2026-09-12");
        Assert.Equal("2026-09-12", body.RootElement.GetProperty("id").GetString());
        var stats = body.RootElement.GetProperty("stats");
        Assert.Equal((0, 0, 0, 0.0), (stats.GetProperty("flights").GetInt32(), stats.GetProperty("cities").GetInt32(),
            stats.GetProperty("places").GetInt32(), stats.GetProperty("groundDistanceMeters").GetDouble()));
        Assert.Empty(MovesOf(body));
        Assert.Equal(["No data", "No data"], DaysOf(body).Select(d => d.GetProperty("description").GetString())); // the 12th and the 13th
    }

    [Fact]
    public async Task Trip_detail_answers_with_an_etag_and_304()
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        await using var api = new ApiFactory(cs);
        var client = api.CreateClient();
        var home = await PlaceAsync(cs, Spots.Home);
        await StoreAsync(api, [Stay(D(9, 12), home, Spots.Lisbon)], [], Trip(D(9, 12), D(9, 12), Utc(9, 12, 7), Utc(9, 13, 12)));

        var first = await GetAsync(client, "/api/trips/2026-09-12");

        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var etag = first.Headers.ETag;
        Assert.NotNull(etag);
        Assert.False(etag.IsWeak);
        Assert.Equal("no-cache", first.Headers.CacheControl?.ToString());
        Assert.Equal("application/json", first.Content.Headers.ContentType?.MediaType);

        var second = await GetAsync(client, "/api/trips/2026-09-12", ifNoneMatch: etag.ToString());

        Assert.Equal(HttpStatusCode.NotModified, second.StatusCode);
        Assert.Equal(string.Empty, await second.Content.ReadAsStringAsync(Ct));
        Assert.Equal(etag, second.Headers.ETag);
    }
}
