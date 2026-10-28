using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Sporer.Api.Features.Timeline;
using Sporer.SyntheticData;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// A whole fictional year, from the points its phone would log to the trips and homes the worker finds in it: the same path
/// as the owner's history, with nothing seeded by hand. The year is the one the simulator plans (<see cref="Simulator.Describe"/>):
/// three trips by air and one house move.
/// </summary>
[Collection("db")]
public class SyntheticTripsTests(DatabaseFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed record HomeRow(long PlaceId, string From, string? To, string Source);

    private sealed record TripRow(string Id, string LastNight, int Nights, DateTime StartUtc, DateTime? EndUtc, string LocalStartDate);

    private sealed record PendingRow(DateTime? FromUtc, DateTime? ToUtc);

    private sealed record PlaceRow(double Latitude, double Longitude);

    [Fact]
    public async Task Synthetic_year_gives_its_three_trips_and_the_house_move()
    {
        // The coarsest the simulator logs while moving (one fix a minute): which trips and homes are found does not depend on the
        // density, and a year of it is about forty thousand rows rather than millions.
        var options = new SimulatorOptions(new DateOnly(2025, 1, 1), new DateOnly(2025, 12, 31), TimeSpan.FromSeconds(60), Seed: 7);
        var plan = Simulator.Describe(options);
        Assert.Equal(["north", "lisbon", "tokyo"], plan.Trips.Select(t => t.Name));
        Assert.True(plan.Trips[0].Start.DayNumber - options.From.DayNumber >= 60, "no room for a home to be found before the first trip");

        var points = new List<TrackPoint>();
        Simulator.Run(options, fix => points.Add(new TrackPoint(fix.TimeUtc, "synthetic-phone", fix.Latitude, fix.Longitude, fix.Speed, fix.Accuracy, fix.Motion)));

        var cs = await db.CreateDatabaseAsync(Ct);
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 1, 2, 0, 0, 0, TimeSpan.Zero)); // after the last day: the backfill ends there
        await using var api = new ApiFactory(cs, new Dictionary<string, string?> { ["Processing:BackfillPause"] = "00:00:00" }, clock);
        var worker = api.Services.GetRequiredService<TimelineWorker>(); // starting the host runs the migrations
        await PointSeeder.InsertAsync(cs, points, Ct);

        // The backfill, in steps of a week and with a refresh after each, until a pass finds nothing left to do.
        for (var pass = 0; await worker.RunOnceAsync(Ct); pass++)
            Assert.True(pass < 100, "the worker keeps finding work");

        var state = (await Sql.QueryAsync(cs, "select backfill_cursor >= backfill_to as done, last_error from processing_state", ct: Ct)).Single();
        Assert.True((bool)state.done);
        Assert.Null((string?)state.last_error);
        Assert.Equal(0, await Sql.ScalarAsync<long>(cs, "select count(*) from dirty_range", ct: Ct));
        var pending = (await Sql.QueryAsync<PendingRow>(cs, "select from_utc as FromUtc, to_utc as ToUtc from night_refresh where id = 1", ct: Ct)).Single();
        Assert.Equal((null, null), (pending.FromUtc, pending.ToUtc));

        // Three trips, each starting the night the plan says it leaves, and each over with the person back.
        var trips = await Sql.QueryAsync<TripRow>(cs,
            """
            select id::text as Id, last_night::text as LastNight, nights as Nights, start_utc as StartUtc, end_utc as EndUtc,
                   local_start_date::text as LocalStartDate
            from trip order by id
            """, ct: Ct);
        var starts = plan.Trips.Select(t => t.Start.ToString("yyyy-MM-dd")).ToList();
        Assert.Equal(starts, trips.Select(t => t.Id));
        Assert.Equal(starts, trips.Select(t => t.LocalStartDate)); // they leave that day
        Assert.All(trips, t => Assert.True(t.EndUtc > t.StartUtc));

        // Nights away: the plan counts the nights at the destination. The flight to Tokyo (ten hours, leaving in the afternoon)
        // is still in the air at 03:00 local time on the day after, which is the time a night is read at, so the night it leaves
        // is spent away as well and the trip is a night longer than planned (that night's row is a point over the Far East).
        // The flights to the north and to Lisbon land the same day.
        Assert.Equal([2, 6, 24 + 1], trips.Select(t => t.Nights));
        Assert.Equal(
            plan.Trips.Zip(trips, (planned, found) => planned.Start.AddDays(found.Nights - 1).ToString("yyyy-MM-dd")),
            trips.Select(t => t.LastNight)); // consecutive nights, none missing in between

        // Two homes, the second from the day of the move (give or take the night it was read on), each ending where the next begins.
        var homes = await Sql.QueryAsync<HomeRow>(cs,
            """
            select place_id as PlaceId, from_date::text as "From", to_date::text as "To", source as Source
            from home_period order by from_date, id
            """, ct: Ct);
        Assert.Equal(2, homes.Count);
        Assert.All(homes, h => Assert.Equal("detected", h.Source));
        var firstNight = DateOnly.FromDateTime(await Sql.ScalarAsync<DateTime>(cs, "select min(date)::timestamp from night", ct: Ct));
        var secondFrom = DateOnly.ParseExact(homes[1].From, "yyyy-MM-dd");
        Assert.Equal((firstNight.ToString("yyyy-MM-dd"), secondFrom.AddDays(-1).ToString("yyyy-MM-dd")), (homes[0].From, homes[0].To));
        Assert.Null(homes[1].To);
        Assert.InRange(secondFrom.DayNumber, plan.MoveDay.DayNumber - 1, plan.MoveDay.DayNumber + 1);

        // And they are two places as far apart as the two homes of the simulated city.
        var places = (await Sql.QueryAsync<PlaceRow>(cs,
            "select latitude as Latitude, longitude as Longitude from place where id = any(@ids) order by id",
            new { ids = homes.Select(h => h.PlaceId).ToArray() }, Ct)).ToList();
        Assert.Equal(2, places.Count);
        Assert.True(Geo.DistanceMeters(new GeoPoint(places[0].Latitude, places[0].Longitude), new GeoPoint(places[1].Latitude, places[1].Longitude)) > 5_000);
    }
}
