using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Time.Testing;
using Sporer.Api.Configuration;
using Sporer.Api.Database;
using Sporer.Api.Features.Places;
using Sporer.Testing;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

[Collection("db")]
public class PlaceNamerTests(DatabaseFixture db)
{
    private const string UserAgent = "SporerTests/1.0 (tests@example.invalid)";
    private const string DisabledWarning = "Place naming disabled: set Nominatim:UserAgent";

    private static readonly DateTimeOffset Start = new(2026, 10, 23, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(1.1);

    // Synthetic answers, in the shape Nominatim's jsonv2 format has them.
    private const string CafeJson =
        """{"place_id":1,"name":"Test Cafe","display_name":"Test Cafe, Storgata 5, Testville","address":{"amenity":"Test Cafe","road":"Storgata","house_number":"5","suburb":"Centre","city":"Testville","country":"Testland","country_code":"tl"}}""";

    private const string HouseJson =
        """{"place_id":2,"name":"","display_name":"5, Storgata, Testville","address":{"road":"Storgata","house_number":"5","city":"Testville","country":"Testland"}}""";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // --- The service ------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Names_place_in_english()
    {
        await using var h = await StartAsync();
        var id = await AddPlaceAsync(h.Cs, Spots.Home);
        h.Nominatim.ReplyJson(CafeJson);

        Assert.True(await h.Namer.RunOnceAsync(Ct));

        var request = Assert.Single(h.Nominatim.Requests);
        Assert.Equal("nominatim.openstreetmap.org", request.Uri.Host);
        Assert.Equal("/reverse", request.Uri.AbsolutePath);
        Assert.Contains("accept-language=en", request.Uri.Query);
        Assert.Equal(UserAgent, request.UserAgent);

        var place = await PlaceAsync(h.Cs, id);
        Assert.Equal("Test Cafe", place.OsmName);
        Assert.Equal("Storgata 5, Testville", place.Address);
        Assert.Equal("Testville", place.City);
        Assert.Equal("Testland", place.Country);
        Assert.Equal("done", place.GeocodeState);
        Assert.Null(place.GeocodeNextAttemptAt);
    }

    [Fact]
    public async Task Falls_back_to_road_when_no_poi_name()
    {
        await using var h = await StartAsync();
        var id = await AddPlaceAsync(h.Cs, Spots.Home);
        h.Nominatim.ReplyJson(HouseJson); // name "" + road "Storgata" + house_number "5"

        Assert.True(await h.Namer.RunOnceAsync(Ct));

        var place = await PlaceAsync(h.Cs, id);
        Assert.Equal("Storgata 5", place.OsmName);
        Assert.Equal("done", place.GeocodeState);
    }

    [Fact]
    public async Task Uses_cache_without_calling_service()
    {
        await using var h = await StartAsync();
        var first = await AddPlaceAsync(h.Cs, new GeoPoint(59.92000, 10.75000));
        var second = await AddPlaceAsync(h.Cs, new GeoPoint(59.92003, 10.75002)); // the same 4-decimal key
        h.Nominatim.ReplyJson(CafeJson);

        Assert.True(await h.Namer.RunOnceAsync(Ct));
        Assert.True(await h.Namer.RunOnceAsync(Ct)); // no time has passed, and none is needed: it is a cache hit

        Assert.Equal(1, h.Nominatim.Calls);
        var named = await PlaceAsync(h.Cs, second);
        Assert.Equal("done", named.GeocodeState);
        Assert.Equal("Test Cafe", named.OsmName);
        Assert.Equal("Storgata 5, Testville", named.Address);
        Assert.Equal("Testville", named.City);
        Assert.Equal("Testland", named.Country);
        Assert.Equal("done", (await PlaceAsync(h.Cs, first)).GeocodeState);
        Assert.False(await h.Namer.RunOnceAsync(Ct)); // nothing left
    }

    [Fact]
    public async Task Cache_is_keyed_by_coordinates_rounded_to_four_decimals()
    {
        await using var h = await StartAsync();
        await AddPlaceAsync(h.Cs, new GeoPoint(59.92004, -9.13934)); // key 59.9200, -9.1393
        await AddPlaceAsync(h.Cs, new GeoPoint(59.92006, -9.13936)); // key 59.9201, -9.1394: a different one
        h.Nominatim.ReplyJson(CafeJson);
        h.Nominatim.ReplyJson(HouseJson);

        Assert.True(await h.Namer.RunOnceAsync(Ct));
        h.Clock.Advance(Interval);
        Assert.True(await h.Namer.RunOnceAsync(Ct));

        Assert.Equal(2, h.Nominatim.Calls);
        var rows = await Sql.QueryAsync(h.Cs, "select lat_key, lon_key, response->>'name' as name from geocode_cache order by lat_key", ct: Ct);
        Assert.Equal(2, rows.Count);
        Assert.Equal((59.9200m, -9.1393m, "Test Cafe"), ((decimal)rows[0].lat_key, (decimal)rows[0].lon_key, (string)rows[0].name));
        Assert.Equal((59.9201m, -9.1394m, ""), ((decimal)rows[1].lat_key, (decimal)rows[1].lon_key, (string)rows[1].name));
    }

    [Fact]
    public async Task Namer_backs_off_on_429()
    {
        await using var h = await StartAsync();
        var id = await AddPlaceAsync(h.Cs, Spots.Home);
        await Sql.ExecAsync(h.Cs, "insert into dirty_range (from_utc, to_utc) values (@a, @b)", new { a = Start.UtcDateTime, b = Start.UtcDateTime.AddHours(1) }, Ct);
        var before = await ProcessingTablesAsync(h.Cs);
        h.Nominatim.Reply(HttpStatusCode.TooManyRequests, "slow down");

        Assert.True(await h.Namer.RunOnceAsync(Ct));

        var place = await PlaceAsync(h.Cs, id);
        Assert.Equal("failed", place.GeocodeState);
        Assert.Equal(1, place.GeocodeAttempts);
        Assert.Equal(Start.UtcDateTime + TimeSpan.FromMinutes(2), place.GeocodeNextAttemptAt);
        Assert.Null(place.OsmName);
        Assert.Equal(before, await ProcessingTablesAsync(h.Cs));
        Assert.Equal(0, await Sql.ScalarAsync<long>(h.Cs, "select count(*) from geocode_cache", ct: Ct));
    }

    [Fact]
    public async Task Failed_place_is_retried_with_a_backoff_that_doubles_with_each_failure()
    {
        await using var h = await StartAsync();
        var id = await AddPlaceAsync(h.Cs, Spots.Home);
        h.Nominatim.Reply(HttpStatusCode.TooManyRequests);
        h.Nominatim.Reply(HttpStatusCode.ServiceUnavailable);
        h.Nominatim.ReplyJson(CafeJson);

        Assert.True(await h.Namer.RunOnceAsync(Ct));
        var first = await PlaceAsync(h.Cs, id);
        Assert.Equal((1, "failed"), (first.GeocodeAttempts, first.GeocodeState));
        Assert.Equal(Start.UtcDateTime + TimeSpan.FromMinutes(2), first.GeocodeNextAttemptAt);

        // The place is due again after 2 minutes, but the cool-down (5 minutes after a first failure) still holds requests back.
        h.Clock.Advance(PlaceNamer.CoolDown(1) - TimeSpan.FromTicks(1));
        Assert.False(await h.Namer.RunOnceAsync(Ct));
        Assert.Equal(1, h.Nominatim.Calls);

        h.Clock.Advance(TimeSpan.FromTicks(1));
        Assert.True(await h.Namer.RunOnceAsync(Ct));
        var second = await PlaceAsync(h.Cs, id);
        Assert.Equal((2, "failed"), (second.GeocodeAttempts, second.GeocodeState));
        Assert.Equal(Start.UtcDateTime + PlaceNamer.CoolDown(1) + TimeSpan.FromMinutes(4), second.GeocodeNextAttemptAt);

        h.Clock.Advance(PlaceNamer.CoolDown(2));
        Assert.True(await h.Namer.RunOnceAsync(Ct));
        var done = await PlaceAsync(h.Cs, id);
        Assert.Equal("done", done.GeocodeState);
        Assert.Null(done.GeocodeNextAttemptAt);
        Assert.Equal("Test Cafe", done.OsmName);
        Assert.Equal(3, h.Nominatim.Calls);
    }

    // --- The global cool-down after a failure (R21) ------------------------------------------------------------------

    [Theory]
    [InlineData(1, 5)]
    [InlineData(2, 10)]
    [InlineData(3, 20)]
    [InlineData(4, 40)]
    [InlineData(5, 60)] // 80 minutes would be more than an hour
    [InlineData(6, 60)]
    [InlineData(int.MaxValue, 60)]
    public void Cool_down_doubles_from_five_minutes_up_to_an_hour(int consecutiveFailures, int minutes)
        => Assert.Equal(TimeSpan.FromMinutes(minutes), PlaceNamer.CoolDown(consecutiveFailures));

    [Fact]
    public async Task A_failure_stops_all_requests_for_the_cool_down()
    {
        await using var h = await StartAsync();
        var failing = await AddPlaceAsync(h.Cs, Spots.Home);
        var other = await AddPlaceAsync(h.Cs, Spots.Cafe); // another key, another place: nothing may be requested for it either
        h.Nominatim.Reply(HttpStatusCode.TooManyRequests);
        h.Nominatim.ReplyJson(CafeJson);

        Assert.True(await h.Namer.RunOnceAsync(Ct)); // the first place fails

        h.Clock.Advance(Interval); // the interval is over, and the failed place would be due again in 2 min: the cool-down is not over
        Assert.False(await h.Namer.RunOnceAsync(Ct));
        h.Clock.Advance(PlaceNamer.CoolDown(1) - Interval - TimeSpan.FromTicks(1));
        Assert.False(await h.Namer.RunOnceAsync(Ct));
        Assert.Equal(1, h.Nominatim.Calls);
        Assert.Equal("pending", (await PlaceAsync(h.Cs, other)).GeocodeState);

        h.Clock.Advance(TimeSpan.FromTicks(1)); // the cool-down is over: requests resume, oldest due place first
        Assert.True(await h.Namer.RunOnceAsync(Ct));
        Assert.Equal(2, h.Nominatim.Calls);
        Assert.Equal("done", (await PlaceAsync(h.Cs, failing)).GeocodeState);
    }

    [Fact]
    public async Task The_cool_down_doubles_with_each_consecutive_failure_up_to_an_hour()
    {
        await using var h = await StartAsync();
        await AddPlaceAsync(h.Cs, Spots.Home); // its own backoff (2, 4, 8, 16, 32 min) is shorter than the cool-down each time
        for (var i = 0; i < 5; i++)
            h.Nominatim.Reply(HttpStatusCode.ServiceUnavailable);

        var expected = new[] { 5, 10, 20, 40, 60 }; // the fifth would be 80
        for (var failure = 0; failure < expected.Length; failure++)
        {
            var coolDown = TimeSpan.FromMinutes(expected[failure]);
            Assert.True(await h.Namer.RunOnceAsync(Ct));
            Assert.Equal(failure + 1, h.Nominatim.Calls);

            h.Clock.Advance(coolDown - TimeSpan.FromTicks(1));
            Assert.False(await h.Namer.RunOnceAsync(Ct));
            Assert.Equal(failure + 1, h.Nominatim.Calls);
            h.Clock.Advance(TimeSpan.FromTicks(1)); // the cool-down is over: the next pass asks again
        }
    }

    [Fact]
    public async Task A_success_resets_the_cool_down()
    {
        await using var h = await StartAsync();
        var first = await AddPlaceAsync(h.Cs, Spots.Home);
        h.Nominatim.Reply(HttpStatusCode.TooManyRequests); // cool-down 5 min
        h.Nominatim.Reply(HttpStatusCode.TooManyRequests); // cool-down 10 min
        h.Nominatim.ReplyJson(CafeJson); // a success

        Assert.True(await h.Namer.RunOnceAsync(Ct));
        h.Clock.Advance(PlaceNamer.CoolDown(1));
        Assert.True(await h.Namer.RunOnceAsync(Ct));
        h.Clock.Advance(PlaceNamer.CoolDown(2));
        Assert.True(await h.Namer.RunOnceAsync(Ct));
        Assert.Equal("done", (await PlaceAsync(h.Cs, first)).GeocodeState);

        // A failure now starts from five minutes again, not from twenty.
        await AddPlaceAsync(h.Cs, Spots.Cafe);
        h.Nominatim.Reply(HttpStatusCode.TooManyRequests);
        h.Nominatim.ReplyJson(HouseJson);
        h.Clock.Advance(Interval);
        Assert.True(await h.Namer.RunOnceAsync(Ct));
        Assert.Equal(4, h.Nominatim.Calls);

        h.Clock.Advance(PlaceNamer.CoolDown(1) - TimeSpan.FromTicks(1));
        Assert.False(await h.Namer.RunOnceAsync(Ct));
        h.Clock.Advance(TimeSpan.FromTicks(1));
        Assert.True(await h.Namer.RunOnceAsync(Ct));
        Assert.Equal(5, h.Nominatim.Calls);
    }

    [Fact]
    public async Task Cached_places_are_still_named_during_a_cool_down()
    {
        await using var h = await StartAsync();
        var cached = await AddPlaceAsync(h.Cs, new GeoPoint(59.92000, 10.75000));
        var failing = await AddPlaceAsync(h.Cs, Spots.Cafe);
        var twin = await AddPlaceAsync(h.Cs, new GeoPoint(59.92001, 10.75001)); // the same key as the first
        h.Nominatim.ReplyJson(CafeJson);
        h.Nominatim.Reply(HttpStatusCode.TooManyRequests);

        Assert.True(await h.Namer.RunOnceAsync(Ct)); // named, and cached
        Assert.Equal("done", (await PlaceAsync(h.Cs, cached)).GeocodeState);
        h.Clock.Advance(Interval);
        Assert.True(await h.Namer.RunOnceAsync(Ct)); // fails: the cool-down starts
        Assert.Equal("failed", (await PlaceAsync(h.Cs, failing)).GeocodeState);

        Assert.True(await h.Namer.RunOnceAsync(Ct)); // the twin needs no request
        Assert.Equal(2, h.Nominatim.Calls);
        Assert.Equal("Test Cafe", (await PlaceAsync(h.Cs, twin)).OsmName);
        Assert.False(await h.Namer.RunOnceAsync(Ct)); // and nothing else is to be had without one
    }

    [Fact]
    public async Task A_404_is_a_failed_attempt_not_an_answer()
    {
        // /reverse says "no result" with a 200; a 404 means the base URL is wrong, and must not finish every place unnamed.
        await using var h = await StartAsync();
        var id = await AddPlaceAsync(h.Cs, Spots.Home);
        h.Nominatim.Reply(HttpStatusCode.NotFound, "");

        Assert.True(await h.Namer.RunOnceAsync(Ct));

        var place = await PlaceAsync(h.Cs, id);
        Assert.Equal(("failed", 1), (place.GeocodeState, place.GeocodeAttempts));
        Assert.Equal(Start.UtcDateTime + TimeSpan.FromMinutes(2), place.GeocodeNextAttemptAt);
        Assert.Equal(0, await Sql.ScalarAsync<long>(h.Cs, "select count(*) from geocode_cache", ct: Ct));
    }

    [Fact]
    public async Task An_unexpected_error_from_the_http_layer_is_a_failed_attempt_too()
    {
        await using var h = await StartAsync();
        var id = await AddPlaceAsync(h.Cs, Spots.Home);
        var other = await AddPlaceAsync(h.Cs, Spots.Cafe);
        h.Nominatim.Throw(new InvalidOperationException("an unexpected bug"));

        Assert.True(await h.Namer.RunOnceAsync(Ct)); // does not throw, and does not leave the place due for the very next pass

        var place = await PlaceAsync(h.Cs, id);
        Assert.Equal(("failed", 1), (place.GeocodeState, place.GeocodeAttempts));
        Assert.Equal(Start.UtcDateTime + TimeSpan.FromMinutes(2), place.GeocodeNextAttemptAt);
        h.Clock.Advance(Interval);
        Assert.False(await h.Namer.RunOnceAsync(Ct)); // the cool-down holds the other place back too
        Assert.Equal(1, h.Nominatim.Calls);
        Assert.Equal("pending", (await PlaceAsync(h.Cs, other)).GeocodeState);
    }

    [Fact]
    public async Task A_base_url_that_cannot_be_requested_is_a_failed_attempt()
    {
        await using var h = await StartAsync(new Dictionary<string, string?> { ["Nominatim:BaseUrl"] = "nominatim.example.test" }); // no scheme
        var id = await AddPlaceAsync(h.Cs, Spots.Home);

        Assert.True(await h.Namer.RunOnceAsync(Ct));

        Assert.Equal(0, h.Nominatim.Calls);
        var place = await PlaceAsync(h.Cs, id);
        Assert.Equal(("failed", 1), (place.GeocodeState, place.GeocodeAttempts));
        Assert.False(await h.Namer.RunOnceAsync(Ct));
    }

    [Fact]
    public async Task A_failure_to_cache_the_answer_does_not_undo_the_naming()
    {
        await using var h = await StartAsync();
        var id = await AddPlaceAsync(h.Cs, Spots.Home);
        // jsonb cannot hold a NUL, so this answer cannot be cached; the name (with the NUL dropped) is still good.
        h.Nominatim.ReplyJson("""{"name":"Caf\u0000e","address":{"city":"Testville"}}""");

        Assert.True(await h.Namer.RunOnceAsync(Ct));

        var place = await PlaceAsync(h.Cs, id);
        Assert.Equal(("done", "Cafe"), (place.GeocodeState, place.OsmName));
        Assert.Equal(0, await Sql.ScalarAsync<long>(h.Cs, "select count(*) from geocode_cache", ct: Ct));
    }

    [Fact]
    public async Task An_unusable_cache_row_is_asked_for_again_and_replaced()
    {
        await using var h = await StartAsync();
        var id = await AddPlaceAsync(h.Cs, Spots.Home);
        await Sql.ExecAsync(h.Cs, "insert into geocode_cache (lat_key, lon_key, response) values (59.9200, 10.7500, '[]'::jsonb)", ct: Ct);
        h.Nominatim.ReplyJson(CafeJson);

        Assert.True(await h.Namer.RunOnceAsync(Ct));

        Assert.Equal(1, h.Nominatim.Calls);
        Assert.Equal("Test Cafe", (await PlaceAsync(h.Cs, id)).OsmName);
        Assert.Equal("Test Cafe", await Sql.ScalarAsync<string>(h.Cs, "select response->>'name' from geocode_cache", ct: Ct));
    }

    [Theory]
    [InlineData(1, 2)]
    [InlineData(2, 4)]
    [InlineData(3, 8)]
    [InlineData(10, 1024)]
    [InlineData(11, 24 * 60)] // 2048 min would be 34 h: capped at 24 h
    [InlineData(1000, 24 * 60)]
    [InlineData(int.MaxValue, 24 * 60)]
    public void Backoff_doubles_from_two_minutes_up_to_a_day(int attempts, int minutes)
        => Assert.Equal(TimeSpan.FromMinutes(minutes), PlaceNamer.Backoff(attempts));

    [Theory]
    [InlineData("<html><body>Bad gateway</body></html>")]
    [InlineData("[1,2")]
    [InlineData("[]")]
    [InlineData("\"just a string\"")]
    [InlineData("""{"name":"\uD800"}""")] // valid JSON, but the string cannot be read: not an exception that may repeat forever
    public async Task Namer_survives_invalid_json(string body)
    {
        await using var h = await StartAsync();
        var id = await AddPlaceAsync(h.Cs, Spots.Home);
        h.Nominatim.ReplyJson(body);

        Assert.True(await h.Namer.RunOnceAsync(Ct)); // does not throw

        var place = await PlaceAsync(h.Cs, id);
        Assert.Equal("failed", place.GeocodeState);
        Assert.Equal(1, place.GeocodeAttempts);
        Assert.Equal(Start.UtcDateTime + TimeSpan.FromMinutes(2), place.GeocodeNextAttemptAt);
        Assert.Equal(0, await Sql.ScalarAsync<long>(h.Cs, "select count(*) from geocode_cache", ct: Ct));
    }

    [Fact]
    public async Task Namer_survives_an_unreachable_service()
    {
        await using var h = await StartAsync();
        var id = await AddPlaceAsync(h.Cs, Spots.Home);
        h.Nominatim.Throw(new HttpRequestException("connection refused"));

        Assert.True(await h.Namer.RunOnceAsync(Ct));

        Assert.Equal("failed", (await PlaceAsync(h.Cs, id)).GeocodeState);
    }

    [Theory]
    [InlineData("""{"error":"Unable to geocode"}""")]
    [InlineData("")]
    public async Task A_spot_nothing_is_known_about_is_done_without_names_and_cached(string body)
    {
        await using var h = await StartAsync();
        var id = await AddPlaceAsync(h.Cs, new GeoPoint(59.92000, 10.75000));
        var twin = await AddPlaceAsync(h.Cs, new GeoPoint(59.92001, 10.75001)); // the same key: must not ask again
        var other = await AddPlaceAsync(h.Cs, Spots.Cafe);
        h.Nominatim.ReplyJson(body);
        h.Nominatim.ReplyJson(CafeJson);

        Assert.True(await h.Namer.RunOnceAsync(Ct));
        Assert.True(await h.Namer.RunOnceAsync(Ct));

        foreach (var placeId in new[] { id, twin })
        {
            var place = await PlaceAsync(h.Cs, placeId);
            Assert.Equal("done", place.GeocodeState);
            Assert.Null(place.OsmName);
            Assert.Null(place.Address);
            Assert.Null(place.City);
            Assert.Null(place.Country);
        }

        Assert.Equal(1, h.Nominatim.Calls);
        Assert.Equal(1, await Sql.ScalarAsync<long>(h.Cs, "select count(*) from geocode_cache where response ? 'error'", ct: Ct));

        // An answer of "nothing here" is a good answer: no cool-down follows it.
        h.Clock.Advance(Interval);
        Assert.True(await h.Namer.RunOnceAsync(Ct));
        Assert.Equal("Test Cafe", (await PlaceAsync(h.Cs, other)).OsmName);
    }

    [Fact]
    public async Task Respects_minimum_interval()
    {
        await using var h = await StartAsync();
        var first = await AddPlaceAsync(h.Cs, Spots.Home);
        var second = await AddPlaceAsync(h.Cs, Spots.Cafe); // another cache key: no cache hit
        h.Nominatim.ReplyJson(CafeJson);
        h.Nominatim.ReplyJson(HouseJson);

        Assert.True(await h.Namer.RunOnceAsync(Ct));
        Assert.False(await h.Namer.RunOnceAsync(Ct));
        Assert.Equal(1, h.Nominatim.Calls);
        Assert.Equal("pending", (await PlaceAsync(h.Cs, second)).GeocodeState);

        h.Clock.Advance(TimeSpan.FromSeconds(1.0));
        Assert.False(await h.Namer.RunOnceAsync(Ct)); // 1.1 s is the least
        Assert.Equal(1, h.Nominatim.Calls);

        h.Clock.Advance(TimeSpan.FromSeconds(0.1));
        Assert.True(await h.Namer.RunOnceAsync(Ct));
        Assert.Equal(2, h.Nominatim.Calls);
        Assert.Equal("done", (await PlaceAsync(h.Cs, first)).GeocodeState);
        Assert.Equal("done", (await PlaceAsync(h.Cs, second)).GeocodeState);
    }

    [Fact]
    public async Task A_cache_hit_neither_waits_for_the_interval_nor_restarts_it()
    {
        await using var h = await StartAsync();
        await AddPlaceAsync(h.Cs, new GeoPoint(59.92000, 10.75000));
        var twin = await AddPlaceAsync(h.Cs, new GeoPoint(59.92001, 10.75001)); // same key as the first
        var other = await AddPlaceAsync(h.Cs, Spots.Cafe);
        h.Nominatim.ReplyJson(CafeJson);
        h.Nominatim.ReplyJson(HouseJson);

        Assert.True(await h.Namer.RunOnceAsync(Ct)); // request at t0
        h.Clock.Advance(TimeSpan.FromSeconds(0.6));
        Assert.True(await h.Namer.RunOnceAsync(Ct)); // the twin: a cache hit, 0.6 s after the request
        Assert.Equal("done", (await PlaceAsync(h.Cs, twin)).GeocodeState);
        Assert.Equal(1, h.Nominatim.Calls);

        h.Clock.Advance(TimeSpan.FromSeconds(0.5)); // t0 + 1.1 s: the interval since the request, not since the cache hit
        Assert.True(await h.Namer.RunOnceAsync(Ct));
        Assert.Equal(2, h.Nominatim.Calls);
        Assert.Equal("done", (await PlaceAsync(h.Cs, other)).GeocodeState);
    }

    [Fact]
    public async Task Only_places_in_use_are_named()
    {
        await using var h = await StartAsync();
        var orphan = await AddPlaceAsync(h.Cs, Spots.Home, referenced: false); // no segment points at it
        var inUse = await AddPlaceAsync(h.Cs, Spots.Cafe);
        var mergedAway = await AddPlaceAsync(h.Cs, Spots.Office, mergedInto: inUse); // referenced, but merged into another
        h.Nominatim.ReplyJson(CafeJson);
        h.Nominatim.ReplyJson(HouseJson);

        Assert.True(await h.Namer.RunOnceAsync(Ct));
        h.Clock.Advance(Interval);
        Assert.False(await h.Namer.RunOnceAsync(Ct));

        Assert.Equal(1, h.Nominatim.Calls);
        Assert.Equal("done", (await PlaceAsync(h.Cs, inUse)).GeocodeState);
        Assert.Equal("pending", (await PlaceAsync(h.Cs, orphan)).GeocodeState);
        Assert.Equal("pending", (await PlaceAsync(h.Cs, mergedAway)).GeocodeState);

        await AddSegmentAsync(h.Cs, orphan); // it becomes referenced: now it is named
        Assert.True(await h.Namer.RunOnceAsync(Ct));
        Assert.Equal(2, h.Nominatim.Calls);
        Assert.Equal("done", (await PlaceAsync(h.Cs, orphan)).GeocodeState);
    }

    // --- When naming is off -----------------------------------------------------------------------------------------

    [Fact]
    public async Task Disabled_without_user_agent()
    {
        // Processing is on, so the only thing keeping the namer out of the hosted services is the missing user agent.
        await using var h = await StartAsync(new Dictionary<string, string?> { ["Processing:Enabled"] = "true", ["Nominatim:UserAgent"] = "" });
        var id = await AddDuePlaceAfterProcessingSettlesAsync(h);

        Assert.DoesNotContain(h.Api.Services.GetServices<IHostedService>(), s => s is PlaceNamer);
        Assert.Contains(DisabledWarning, h.Api.Services.GetRequiredService<DatabaseWarnings>().Items);

        Assert.False(await h.Namer.RunOnceAsync(Ct)); // still resolvable, and makes no request
        Assert.Equal(0, h.Nominatim.Calls);
        Assert.Equal("pending", (await PlaceAsync(h.Cs, id)).GeocodeState);
    }

    [Fact]
    public async Task Switched_off_makes_no_request_and_gives_no_warning()
    {
        await using var h = await StartAsync(new Dictionary<string, string?> { ["Processing:Enabled"] = "true", ["Nominatim:Enabled"] = "false" });
        var id = await AddDuePlaceAfterProcessingSettlesAsync(h);

        Assert.DoesNotContain(h.Api.Services.GetServices<IHostedService>(), s => s is PlaceNamer);
        Assert.DoesNotContain(DisabledWarning, h.Api.Services.GetRequiredService<DatabaseWarnings>().Items);
        Assert.False(await h.Namer.RunOnceAsync(Ct));
        Assert.Equal(0, h.Nominatim.Calls);
        Assert.Equal("pending", (await PlaceAsync(h.Cs, id)).GeocodeState);
    }

    [Theory]
    [InlineData("true", "true", UserAgent, true, false)]
    [InlineData("false", "true", UserAgent, false, false)] // processing off: nothing runs in the background
    [InlineData("true", "false", UserAgent, false, false)]
    [InlineData("true", "true", "", false, true)]
    [InlineData("true", "true", "   ", false, true)]
    [InlineData("false", "true", "", false, true)] // the warning does not depend on processing
    [InlineData("false", "false", "", false, false)]
    public async Task The_namer_runs_in_the_background_only_when_enabled_with_a_user_agent(
        string processing, string nominatim, string userAgent, bool hosted, bool warned)
    {
        await using var h = await StartAsync(new Dictionary<string, string?>
        {
            ["Processing:Enabled"] = processing, ["Nominatim:Enabled"] = nominatim, ["Nominatim:UserAgent"] = userAgent,
        });

        Assert.Equal(hosted, h.Api.Services.GetServices<IHostedService>().Any(s => s is PlaceNamer));
        Assert.Equal(warned, h.Api.Services.GetRequiredService<DatabaseWarnings>().Items.Contains(DisabledWarning));
    }

    [Fact]
    public async Task The_background_loop_names_places_and_carries_on_after_a_failing_pass()
    {
        await using var h = await StartAsync(new Dictionary<string, string?>
        {
            ["Processing:Enabled"] = "true", ["Nominatim:MinInterval"] = "00:00:00.05",
        }, fakeClock: false);
        h.Nominatim.ReplyJson(CafeJson); // queued first: the namer polls every 50 ms and must not meet the default 500

        // Every pass fails (the cache table is not there) until it is put back; the loop must live through that.
        await WaitForProcessingToSettleAsync(h.Cs);
        await Sql.ExecAsync(h.Cs, "alter table geocode_cache rename to geocode_cache_away", ct: Ct);
        var id = await AddPlaceAsync(h.Cs, Spots.Home);
        await Task.Delay(500, Ct);
        Assert.Equal("pending", (await PlaceAsync(h.Cs, id)).GeocodeState);
        Assert.Equal(0, h.Nominatim.Calls);

        await Sql.ExecAsync(h.Cs, "alter table geocode_cache_away rename to geocode_cache", ct: Ct);

        await WaitForAsync(async () => (await PlaceAsync(h.Cs, id)).GeocodeState == "done", "the place to be named");
        Assert.Equal("Test Cafe", (await PlaceAsync(h.Cs, id)).OsmName);
        Assert.Equal(1, h.Nominatim.Calls);
    }

    // --- The client -------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Request_has_the_documented_parameters_with_invariant_numbers()
    {
        var comma = (CultureInfo)CultureInfo.InvariantCulture.Clone();
        comma.NumberFormat.NumberDecimalSeparator = ",";
        comma.NumberFormat.NegativeSign = "~";
        var original = CultureInfo.CurrentCulture;
        CultureInfo.CurrentCulture = comma;
        try
        {
            var nominatim = new FakeNominatim();
            nominatim.ReplyJson(CafeJson);
            var client = new NominatimClient(new HttpClient(nominatim), new NominatimOptions { BaseUrl = "https://nominatim.example.test/" });

            await client.ReverseAsync(new GeoPoint(-38.7223, 9.1393), Ct);

            Assert.Equal(
                "https://nominatim.example.test/reverse?format=jsonv2&lat=-38.7223&lon=9.1393&zoom=18&addressdetails=1&accept-language=en",
                Assert.Single(nominatim.Requests).Uri.AbsoluteUri);
        }
        finally
        {
            CultureInfo.CurrentCulture = original;
        }
    }

    [Theory]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.NotFound)] // /reverse answers "no result" with a 200; a 404 means a wrong base URL
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.BadGateway)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    [InlineData(HttpStatusCode.Forbidden)]
    public async Task Client_reports_a_refusing_service_as_unavailable(HttpStatusCode status)
    {
        var nominatim = new FakeNominatim();
        nominatim.Reply(status, "no");

        await Assert.ThrowsAsync<NominatimUnavailableException>(() => ClientFor(nominatim).ReverseAsync(Spots.Home, Ct));
    }

    [Fact]
    public async Task Client_reports_network_failures_and_timeouts_as_unavailable()
    {
        var nominatim = new FakeNominatim();
        nominatim.Throw(new HttpRequestException("connection refused"));
        nominatim.Throw(new TaskCanceledException("the request timed out", new TimeoutException()));
        nominatim.Throw(new IOException("connection reset"));
        var client = ClientFor(nominatim);

        for (var i = 0; i < 3; i++)
            await Assert.ThrowsAsync<NominatimUnavailableException>(() => client.ReverseAsync(Spots.Home, Ct));
    }

    [Fact]
    public async Task Client_lets_a_cancellation_through()
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        var nominatim = new FakeNominatim();
        nominatim.Throw(new OperationCanceledException(cts.Token));
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ClientFor(nominatim).ReverseAsync(Spots.Home, cts.Token));
    }

    [Fact]
    public async Task Client_keeps_the_response_as_received()
    {
        var nominatim = new FakeNominatim();
        nominatim.ReplyJson(CafeJson);

        var result = await ClientFor(nominatim).ReverseAsync(Spots.Home, Ct);

        Assert.Equal(CafeJson, result?.RawJson);
    }

    [Theory]
    // name wins; the address is the road, the house number and the city
    [InlineData("""{"name":"Test Cafe","address":{"road":"Storgata","house_number":"5","city":"Testville","country":"Testland"}}""",
        "Test Cafe", "Storgata 5, Testville", "Testville", "Testland")]
    // no name: the road and house number
    [InlineData("""{"name":"","address":{"road":"Storgata","house_number":"5","city":"Testville"}}""",
        "Storgata 5", "Storgata 5, Testville", "Testville", null)]
    [InlineData("""{"address":{"road":"Storgata","city":"Testville"}}""",
        "Storgata", "Storgata, Testville", "Testville", null)]
    // no name and no road: the suburb; the address leaves out what is missing
    [InlineData("""{"name":"","address":{"suburb":"Old Quarter","town":"Smallton","country":"Testland"}}""",
        "Old Quarter", "Smallton", "Smallton", "Testland")]
    // a house number alone is no name, but still part of the address
    [InlineData("""{"address":{"house_number":"5","city":"Testville"}}""",
        null, "5, Testville", "Testville", null)]
    // the city is the first of city, town, village, municipality
    [InlineData("""{"address":{"municipality":"M","village":"V","town":"T","city":"C"}}""", null, "C", "C", null)]
    [InlineData("""{"address":{"municipality":"M","village":"V","town":"T"}}""", null, "T", "T", null)]
    [InlineData("""{"address":{"municipality":"M","village":"V"}}""", null, "V", "V", null)]
    [InlineData("""{"address":{"municipality":"M"}}""", null, "M", "M", null)]
    // nothing usable
    [InlineData("""{"place_id":3}""", null, null, null, null)]
    [InlineData("""{"name":null,"address":null}""", null, null, null, null)]
    [InlineData("""{"name":"  ","address":{}}""", null, null, null, null)]
    [InlineData("""{"address":[]}""", null, null, null, null)]
    // values that are not strings are ignored; strings are trimmed; a NUL (which the database cannot hold) is dropped
    [InlineData("""{"name":7,"address":{"road":" Storgata ","house_number":5,"city":null,"country":["x"]}}""",
        "Storgata", "Storgata", null, null)]
    [InlineData("""{"name":"Caf\u0000e","address":{"country":"Test\u0000land"}}""", "Cafe", null, null, "Testland")]
    public void Client_reads_the_names_out_of_the_response(string json, string? name, string? address, string? city, string? country)
    {
        var result = NominatimClient.Parse(json);

        Assert.NotNull(result);
        Assert.Equal((name, address, city, country), (result.Name, result.Address, result.City, result.Country));
        Assert.Equal(json, result.RawJson);
    }

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("null")]
    [InlineData("""{"error":"Unable to geocode"}""")]
    public void Client_reads_no_result_as_null(string json) => Assert.Null(NominatimClient.Parse(json));

    [Theory]
    [InlineData("<html>")]
    [InlineData("{")]
    [InlineData("[]")]
    [InlineData("42")]
    [InlineData("\"text\"")]
    [InlineData("""{"name":"\uD800"}""")] // a lone surrogate: parses, but cannot be read as text
    [InlineData("""{"address":{"road":"\uDC00"}}""")]
    public void Client_rejects_what_it_cannot_read(string body)
        => Assert.Throws<NominatimUnavailableException>(() => NominatimClient.Parse(body));

    [Theory]
    [InlineData("")]
    [InlineData("""{"error":"Unable to geocode"}""")]
    public async Task Client_reads_an_answer_without_a_result_as_null(string body)
    {
        var nominatim = new FakeNominatim();
        nominatim.ReplyJson(body);

        Assert.Null(await ClientFor(nominatim).ReverseAsync(Spots.Home, Ct));
    }

    // --- Helpers ----------------------------------------------------------------------------------------------------

    private static NominatimClient ClientFor(FakeNominatim nominatim) => new(new HttpClient(nominatim), new NominatimOptions());

    private sealed record Seen(Uri Uri, string UserAgent);

    /// <summary>Stands in for the Nominatim service: records every request and answers from a queue (500 when it is empty).</summary>
    private sealed class FakeNominatim : HttpMessageHandler
    {
        private readonly ConcurrentQueue<Func<HttpResponseMessage>> _replies = new();
        private readonly ConcurrentQueue<Seen> _seen = new();

        public int Calls => _seen.Count;

        public IReadOnlyList<Seen> Requests => [.. _seen];

        public void Reply(HttpStatusCode status, string body = "")
            => _replies.Enqueue(() => new HttpResponseMessage(status) { Content = new StringContent(body) });

        public void ReplyJson(string body) => Reply(HttpStatusCode.OK, body);

        public void Throw(Exception error) => _replies.Enqueue(() => throw error);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            _seen.Enqueue(new Seen(request.RequestUri!, request.Headers.UserAgent.ToString()));
            return Task.FromResult(_replies.TryDequeue(out var reply)
                ? reply()
                : new HttpResponseMessage(HttpStatusCode.InternalServerError) { Content = new StringContent("no reply was queued") });
        }
    }

    private sealed class Harness(ApiFactory api, string cs, FakeNominatim nominatim, FakeTimeProvider clock) : IAsyncDisposable
    {
        public ApiFactory Api { get; } = api;
        public string Cs { get; } = cs;
        public FakeNominatim Nominatim { get; } = nominatim;
        public FakeTimeProvider Clock { get; } = clock;
        public PlaceNamer Namer { get; } = api.Services.GetRequiredService<PlaceNamer>(); // starting the host runs the migrations

        public ValueTask DisposeAsync() => Api.DisposeAsync();
    }

    /// <summary>
    /// The real app on a fresh database, with Nominatim switched on and its HTTP calls going to a <see cref="FakeNominatim"/>
    /// (the real service is never called). Background work is off unless <paramref name="settings"/> turns it on.
    /// </summary>
    private async Task<Harness> StartAsync(IDictionary<string, string?>? settings = null, bool fakeClock = true)
    {
        var cs = await db.CreateDatabaseAsync(Ct);
        var nominatim = new FakeNominatim();
        var clock = new FakeTimeProvider(Start);
        var all = new Dictionary<string, string?> { ["Nominatim:Enabled"] = "true", ["Nominatim:UserAgent"] = UserAgent };
        if (settings is not null)
            foreach (var (key, value) in settings)
                all[key] = value;

        var api = new ApiFactory(cs, all, fakeClock ? clock : null, services =>
            services.AddHttpClient<NominatimClient>().ConfigurePrimaryHttpMessageHandler(() => nominatim));
        return new Harness(api, cs, nominatim, clock);
    }

    /// <summary>
    /// The processing worker's first pass starts the timeline over and deletes every segment (an algorithm version is
    /// recorded in the same step); wait for that before adding places, or it could take the segment a place needs away.
    /// </summary>
    private static Task WaitForProcessingToSettleAsync(string cs) => WaitForAsync(
        async () => await Sql.ScalarAsync<string?>(cs, "select algorithm_version from processing_state where id = 1", ct: Ct) is not null,
        "the processing worker's first pass");

    /// <summary>A place that is due and referenced, so that only the namer's own guard can keep it from being requested.</summary>
    private static async Task<long> AddDuePlaceAfterProcessingSettlesAsync(Harness h)
    {
        await WaitForProcessingToSettleAsync(h.Cs);
        var id = await AddPlaceAsync(h.Cs, Spots.Home);
        Assert.Equal(1, await Sql.ScalarAsync<long>(h.Cs, "select count(*) from segment where place_id = @id", new { id }, Ct));
        return id;
    }

    private static async Task WaitForAsync(Func<Task<bool>> condition, string what)
    {
        var until = DateTime.UtcNow.AddSeconds(20);
        while (!await condition())
        {
            Assert.True(DateTime.UtcNow < until, $"timed out waiting for {what}");
            await Task.Delay(20, Ct);
        }
    }

    private static async Task<long> AddPlaceAsync(string cs, GeoPoint at, bool referenced = true, long? mergedInto = null)
    {
        var id = await Sql.ScalarAsync<long>(cs,
            "insert into place (latitude, longitude, merged_into_id) values (@Latitude, @Longitude, @mergedInto) returning id",
            new { at.Latitude, at.Longitude, mergedInto }, Ct);
        if (referenced)
            await AddSegmentAsync(cs, id);
        return id;
    }

    private static Task AddSegmentAsync(string cs, long placeId) => Sql.ExecAsync(cs,
        """
        insert into segment (kind, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date, place_id, point_count)
        values ('stay', @start, @end, 'Etc/UTC', 'Etc/UTC', @day, @day, @placeId, 1)
        """,
        new { start = Start.UtcDateTime, end = Start.UtcDateTime.AddHours(1), day = new DateOnly(2026, 10, 23), placeId }, Ct);

    private sealed record PlaceRow(
        string? OsmName, string? Address, string? City, string? Country,
        string GeocodeState, int GeocodeAttempts, DateTime? GeocodeNextAttemptAt);

    private static async Task<PlaceRow> PlaceAsync(string cs, long id) => (await Sql.QueryAsync<PlaceRow>(cs,
        """
        select osm_name as OsmName, address as Address, city as City, country as Country,
               geocode_state as GeocodeState, geocode_attempts as GeocodeAttempts, geocode_next_attempt_at as GeocodeNextAttemptAt
        from place where id = @id
        """, new { id }, Ct)).Single();

    /// <summary>What processing owns, as counts and a fingerprint, to show that naming leaves it alone.</summary>
    private static async Task<string> ProcessingTablesAsync(string cs)
    {
        var counts = await Sql.SingleAsync(cs,
            """
            select (select count(*) from locationlog) as points, (select count(*) from segment) as segments,
                   (select count(*) from dirty_range) as dirty, (select count(*) from dirty_range where attempts = 0 and next_attempt_at is null) as untouched,
                   (select coalesce(algorithm_version, '') from processing_state where id = 1) as version
            """, ct: Ct);
        return $"{counts.points}/{counts.segments}/{counts.dirty}/{counts.untouched}/{counts.version}";
    }
}
