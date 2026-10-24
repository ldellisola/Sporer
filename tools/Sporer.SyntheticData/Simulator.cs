using Sporer.Timeline;

namespace Sporer.SyntheticData;

/// <summary>
/// The life of one fictional person over some years, as the points their phone would log. Nothing in it is real: the
/// city is laid out from a reference position and every place is an offset from it.
/// <list type="bullet">
/// <item>Weekdays: most go to the office (cycling or driving, mostly driving in winter, sometimes after a morning run),
/// some to a nearby hub (walking or cycling) or work at home; lunch at a cafe; a gym visit, a walk or a shop in the evening;
/// a monthly evening out.</item>
/// <item>Weekends: a long hike or ride on most Saturdays, errands, family on many Sundays, park walks.</item>
/// <item>A flight to the north for two nights, one to Lisbon for six (another time zone), one to Tokyo for 24 (another
/// time zone, a stay of more than three weeks); every flight starts and ends with a drive to or from the airport and
/// logs sparsely in the air.</item>
/// <item>One house move, in the middle of the history: several loads between the old home and the new one.</item>
/// <item>A few times the phone is off for hours while the person is on the move (a gap in the track).</item>
/// <item>Sparse logging while still, GPS error that drifts, an occasional spike, and (for the last 90 days) accuracy and motion.</item>
/// </list>
/// Everything is decided by random streams seeded from <see cref="SimulatorOptions.Seed"/> (its own generator, not
/// <see cref="Random"/>, so that a seed means the same life on every runtime): the same options always give the same rows.
/// The life (which days are what, who goes where and when) is drawn apart from the GPS error, so a finer
/// <see cref="SimulatorOptions.MovingInterval"/> logs the same life more densely.
/// </summary>
public sealed class Simulator
{
    private static readonly GeoPoint Centre = new(59.9100, 10.7500);
    private const double Cruise = 230; // m/s, a jet

    private readonly SimulatorOptions _options;
    private readonly Rng _plan;
    private readonly Roads _roads;
    private readonly Phone _phone;
    private readonly TimeZoneInfo _homeZone = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");
    private readonly DateTime _endUtc;

    private readonly Residence _first;
    private readonly Residence _second;
    private readonly Place _office;
    private readonly Place _cafe;
    private readonly Place _airport;
    private readonly Place _family;
    private readonly Place[] _venues;
    private readonly Hike[] _hikes;
    private readonly List<Trip> _trips = [];
    private readonly DateOnly _moveDay;
    private readonly Queue<DateOnly> _saturdayGaps = new();
    private readonly Queue<DateOnly> _commuteGaps = new();

    private TimeZoneInfo _zone;
    private Residence _home;
    private Place _at;

    private sealed record Hike(Place Start, Place ViewA, Place ViewB);

    private sealed record Trip(
        string Name, TimeZoneInfo Zone, Place Airport, Place Hotel, IReadOnlyList<Place> Pois, DateOnly Start, int Nights,
        int PhoneOffDay);

    /// <summary>Writes every fix of the history, in time order, to <paramref name="sink"/>.</summary>
    public static void Run(SimulatorOptions options, Action<Fix> sink)
    {
        options.Validate();
        new Simulator(options, sink).Live();
    }

    private Simulator(SimulatorOptions options, Action<Fix> sink)
    {
        _options = options;
        _plan = Rng.For(options.Seed, 1);
        var world = Rng.For(options.Seed, 2);
        _roads = new Roads(Rng.For(options.Seed, 4));
        _endUtc = Utc(options.To.AddDays(1), 0, _homeZone);
        _phone = new Phone(Rng.For(options.Seed, 3), sink, options.MovingInterval, _endUtc);

        _first = Residence.Around("homeA", Geo.Offset(Centre, -5200, -6800), world);
        _second = Residence.Around("homeB", Geo.Offset(Centre, 4300, 7600), world);
        _home = _first;
        _zone = _homeZone;
        _at = _first.Home;

        _office = new Place("office", Geo.Offset(Centre, 300, 1500));
        _cafe = new Place("office:cafe", Geo.Offset(_office.Position, 250, 350));
        _airport = new Place("airport", Geo.Offset(Centre, 45000, 12000));
        _family = new Place("family", Geo.Offset(Centre, -12500, 9000));
        _venues = [.. new (double N, double E)[] { (-600, 400), (900, -700), (1500, 2200), (-300, -1500) }
            .Select((v, i) => new Place($"venue{i}", Geo.Offset(Centre, v.N, v.E)))];
        _hikes = [.. new (double N, double E)[] { (14000, -11000), (-16000, -6000), (7000, 18000) }
            .Select((t, i) => MakeHike(i, Geo.Offset(Centre, t.N, t.E), world))];

        var days = options.To.DayNumber - options.From.DayNumber + 1;
        DateOnly Near(double share, DayOfWeek day)
        {
            var date = options.From.AddDays((int)(days * share));
            while (date.DayOfWeek != day)
                date = date.AddDays(1);
            return date;
        }

        _moveDay = Near(0.57, DayOfWeek.Saturday);
        AddTrip("north", "Europe/Oslo", (69.6833, 18.9189), (69.6496, 18.9560), Near(0.22, DayOfWeek.Thursday), nights: 2, phoneOffDay: -1, world);
        AddTrip("lisbon", "Europe/Lisbon", (38.7813, -9.1359), (38.7139, -9.1394), Near(0.40, DayOfWeek.Friday), nights: 6, phoneOffDay: -1, world);
        AddTrip("tokyo", "Asia/Tokyo", (35.5494, 139.7798), (35.6586, 139.7454), Near(0.72, DayOfWeek.Friday), nights: 24, phoneOffDay: 2, world);

        for (var k = 1; k <= 6; k++)
            _saturdayGaps.Enqueue(Near((k - 0.5) / 6.5, DayOfWeek.Saturday).AddDays(7 * _plan.Next(3)));
        for (var k = 1; k <= 2; k++)
            _commuteGaps.Enqueue(Near(k * 0.3, DayOfWeek.Wednesday));
    }

    private static Hike MakeHike(int index, GeoPoint start, Rng rng)
    {
        Place Away(string what, GeoPoint from, double minKm, double maxKm)
        {
            var angle = rng.Uniform(0, 2 * Math.PI);
            var distance = rng.Uniform(minKm, maxKm) * 1000;
            return new Place($"hike{index}:{what}", Geo.Offset(from, distance * Math.Cos(angle), distance * Math.Sin(angle)));
        }

        var trailhead = new Place($"hike{index}:start", start);
        var viewA = Away("viewA", start, 5.5, 7);
        return new Hike(trailhead, viewA, Away("viewB", viewA.Position, 3, 4));
    }

    /// <summary>A trip counts only if it fits in the history, with a day to spare.</summary>
    private void AddTrip(string name, string zone, (double Lat, double Lon) airport, (double Lat, double Lon) hotel,
        DateOnly start, int nights, int phoneOffDay, Rng world)
    {
        if (start.AddDays(nights + 2) > _options.To)
            return;

        var hotelPlace = new Place($"{name}:hotel", new GeoPoint(hotel.Lat, hotel.Lon));
        var pois = new List<Place>();
        for (var k = 0; k < 6; k++)
        {
            var angle = world.Uniform(0, 2 * Math.PI);
            var distance = world.Uniform(500, 6000);
            pois.Add(new Place($"{name}:poi{k}", Geo.Offset(hotelPlace.Position, distance * Math.Cos(angle), distance * Math.Sin(angle))));
        }

        _trips.Add(new Trip(name, TimeZoneInfo.FindSystemTimeZoneById(zone), new Place($"{name}:airport", new GeoPoint(airport.Lat, airport.Lon)),
            hotelPlace, pois, start, nights, phoneOffDay));
    }

    private void Live()
    {
        var date = _options.From;
        _phone.Now = Utc(date, 7.0, _zone);
        _phone.Here = _phone.Spot(_home.Home.Position, 6);
        _phone.LogHere();

        while (date <= _options.To && !_phone.Finished)
        {
            if (_trips.FirstOrDefault(t => t.Start == date) is { } trip)
                date = RunTrip(trip, date);
            else if (date == _moveDay)
                MoveHouse(date);
            else
                RegularDay(date);
            date = date.AddDays(1);
        }
    }

    // ---- ordinary days -----------------------------------------------------------------------------------------

    private void RegularDay(DateOnly date)
    {
        switch (date.DayOfWeek)
        {
            case DayOfWeek.Saturday:
                Saturday(date);
                break;
            case DayOfWeek.Sunday:
                Sunday(date);
                break;
            default:
                var roll = _plan.NextDouble();
                if (roll < 0.05)
                    Sunday(date); // a day off
                else if (roll < 0.20)
                    HubDay(date);
                else if (roll < 0.27)
                    HomeDay(date);
                else
                    OfficeDay(date);
                break;
        }
    }

    private void OfficeDay(DateOnly date)
    {
        if (_plan.Chance(0.35))
        {
            _phone.StayUntil(At(date, 6.0 + _plan.Uniform(0, 0.6)));
            Go(_plan.Pick(_home.RunVias), Gait.Run);
            Go(_home.Home, Gait.Run);
        }

        var mode = CommuteMode(date);
        _phone.StayUntil(At(date, 7.0 + _plan.Uniform(0, 1.4)));
        if (_commuteGaps.Count > 0 && date >= _commuteGaps.Peek())
        {
            // The battery dies on the way and the phone is charged at the office.
            _commuteGaps.Dequeue();
            _phone.SwitchOff(_phone.Now + TimeSpan.FromMinutes(8), _phone.Now + TimeSpan.FromHours(3));
        }
        Go(_office, mode);

        if (_plan.Chance(0.6))
        {
            _phone.StayUntil(At(date, 11.8 + _plan.Uniform(0, 0.8)));
            Go(_cafe, Gait.Walk);
            _phone.StayFor(Minutes(25, 45));
            Go(_office, Gait.Walk);
        }

        _phone.StayUntil(At(date, 16.0 + _plan.Uniform(0, 2.0)));
        var back = _plan.Chance(0.8) ? mode : CommuteMode(date);
        Go(_home.Home, back);
        Evening(date);
    }

    /// <summary>A day at the hub (a co-working space a short walk or ride from home).</summary>
    private void HubDay(DateOnly date)
    {
        var mode = _plan.Chance(0.6) ? Gait.Walk : Gait.Cycle;
        _phone.StayUntil(At(date, 8.0 + _plan.Uniform(0, 1.0)));
        Go(_home.Hub, mode);
        _phone.StayUntil(At(date, 11.9 + _plan.Uniform(0, 0.6)));
        Go(_home.HubCafe, Gait.Walk);
        _phone.StayFor(Minutes(25, 45));
        Go(_home.Hub, Gait.Walk);
        _phone.StayUntil(At(date, 16.0 + _plan.Uniform(0, 1.5)));
        Go(_home.Home, mode);
        Evening(date);
    }

    private void HomeDay(DateOnly date)
    {
        if (_plan.Chance(0.5))
        {
            _phone.StayUntil(At(date, 12.0 + _plan.Uniform(0, 1.0)));
            Go(_home.Shop, Gait.Walk);
            _phone.StayFor(Minutes(15, 25));
            Go(_home.Home, Gait.Walk);
        }
        Evening(date);
    }

    private void Evening(DateOnly date)
    {
        if (date is { DayOfWeek: DayOfWeek.Thursday, Day: >= 14 and <= 20 })
        {
            // The monthly evening out.
            var venue = _venues[(date.Year * 12 + date.Month) % _venues.Length];
            _phone.StayUntil(At(date, 18.7 + _plan.Uniform(0, 0.6)));
            Go(venue, Gait.Drive);
            _phone.StayFor(Minutes(100, 160));
            Go(_home.Home, Gait.Drive);
            return;
        }

        var gymDay = date.DayOfWeek is DayOfWeek.Monday or DayOfWeek.Wednesday or DayOfWeek.Thursday;
        var roll = _plan.NextDouble();
        if (gymDay && roll < 0.65)
        {
            var mode = ShortTripMode(date);
            _phone.StayUntil(At(date, 18.6 + _plan.Uniform(0, 0.8)));
            Go(_home.Gym, mode);
            _phone.StayFor(Minutes(55, 85));
            Go(_home.Home, mode);
        }
        else if (roll < 0.80)
        {
            _phone.StayUntil(At(date, 19.0 + _plan.Uniform(0, 1.0)));
            ParkWalk();
        }
        else if (roll < 0.92)
        {
            _phone.StayUntil(At(date, 18.5 + _plan.Uniform(0, 1.5)));
            Go(_home.Shop, Gait.Walk);
            _phone.StayFor(Minutes(12, 25));
            Go(_home.Home, Gait.Walk);
        }
    }

    private void ParkWalk()
    {
        Go(_home.Park, Gait.Walk);
        _phone.StayFor(Minutes(8, 15));
        Go(_home.ParkFar, Gait.Walk);
        Go(_home.Home, Gait.Walk);
    }

    private void Saturday(DateOnly date)
    {
        _phone.StayUntil(At(date, 8.3 + _plan.Uniform(0, 1.4)));
        var forced = _saturdayGaps.Count > 0 && date >= _saturdayGaps.Peek();
        if (forced)
            _saturdayGaps.Dequeue();

        if (forced || _plan.Chance(0.68))
        {
            if (forced)
            {
                // The phone dies on the outing and is charged at home hours later.
                _phone.SwitchOff(_phone.Now + Minutes(45, 90), _phone.Now + TimeSpan.FromHours(_plan.Uniform(5.5, 8)));
            }

            if (_plan.Chance(0.2 + 0.5 * Summerness(date)))
                Ride();
            else
                HikeOut();
        }

        if (_plan.Chance(0.4))
        {
            _phone.StayUntil(At(date, 15.0 + _plan.Uniform(0, 1.5)));
            Go(_home.Shop, Gait.Walk);
            _phone.StayFor(Minutes(20, 40));
            Go(_home.Home, Gait.Walk);
        }
    }

    private void Ride()
    {
        var cafe = _plan.Pick(_home.RideCafes);
        Go(cafe, Gait.Cycle);
        _phone.StayFor(Minutes(15, 30));
        if (_plan.Chance(0.15))
        {
            Go(_plan.Pick(_home.RideCafes.Where(c => c != cafe).ToList()), Gait.Cycle);
            _phone.StayFor(Minutes(10, 20));
        }
        Go(_home.Home, Gait.Cycle);
    }

    private void HikeOut()
    {
        var hike = _plan.Pick(_hikes);
        Go(hike.Start, Gait.Drive);
        _phone.StayFor(Minutes(5, 10));
        Go(hike.ViewA, Gait.Walk);
        _phone.StayFor(Minutes(15, 25));
        Go(hike.ViewB, Gait.Walk);
        _phone.StayFor(Minutes(8, 15));
        Go(hike.Start, Gait.Walk);
        _phone.StayFor(Minutes(10, 20));
        Go(_home.Home, Gait.Drive);
    }

    private void Sunday(DateOnly date)
    {
        _phone.StayUntil(At(date, 9.0 + _plan.Uniform(0, 2.0)));
        var roll = _plan.NextDouble();
        if (roll < 0.5)
        {
            _phone.StayUntil(At(date, 11.0 + _plan.Uniform(0, 1.0)));
            Go(_family, Gait.Drive);
            _phone.StayFor(Minutes(180, 270));
            Go(_home.Home, Gait.Drive);
        }
        else if (roll < 0.8)
        {
            ParkWalk();
        }
    }

    /// <summary>On the move house day: several loads, the old home to the new one and back, then the night in the new one.</summary>
    private void MoveHouse(DateOnly date)
    {
        var oldHome = _home.Home;
        var newHome = _second.Home;
        _phone.StayUntil(At(date, 8.5));
        for (var load = 0; load < 3; load++)
        {
            Go(newHome, Gait.Drive);
            _phone.StayFor(Minutes(35, 55));
            Go(oldHome, Gait.Drive);
            _phone.StayFor(Minutes(30, 45));
        }
        Go(newHome, Gait.Drive);
        _home = _second;
        _phone.StayFor(Minutes(40, 60));
    }

    // ---- trips -------------------------------------------------------------------------------------------------

    /// <summary>
    /// A trip by air: to the airport, the flight, a transfer to the hotel, days out from it, then back the same way.
    /// Returns the local date at home when the person arrives there.
    /// </summary>
    private DateOnly RunTrip(Trip trip, DateOnly date)
    {
        _phone.StayUntil(At(date, 8.0 + _plan.Uniform(0, 1.5)));
        Go(_airport, Gait.Highway);
        _phone.StayUntil(Later(At(date, 11.5 + _plan.Uniform(0, 5)), _phone.Now + TimeSpan.FromMinutes(100)));
        Fly(trip.Airport);

        _zone = trip.Zone;
        _phone.StayFor(Minutes(40, 75));
        Go(trip.Hotel, Gait.Transit);
        var arrival = LocalDate(_phone.Now, _zone);
        if (LocalHour(_phone.Now, _zone) < 15)
            TripDay(trip, arrival, phoneOff: false);

        for (var day = 1; day < trip.Nights; day++)
            TripDay(trip, arrival.AddDays(day), phoneOff: day == trip.PhoneOffDay);

        var back = arrival.AddDays(trip.Nights);
        _phone.StayUntil(At(back, 8.0 + _plan.Uniform(0, 1.5)));
        Go(trip.Airport, Gait.Transit);
        _phone.StayUntil(Later(At(back, 11.5 + _plan.Uniform(0, 3)), _phone.Now + TimeSpan.FromMinutes(100)));
        Fly(_airport);

        _zone = _homeZone;
        _phone.StayFor(Minutes(40, 75));
        Go(_home.Home, Gait.Highway);
        return LocalDate(_phone.Now, _homeZone);
    }

    private void TripDay(Trip trip, DateOnly date, bool phoneOff)
    {
        _phone.StayUntil(Later(At(date, 9.0 + _plan.Uniform(0, 1.5)), _phone.Now + TimeSpan.FromHours(1)));
        if (phoneOff)
            _phone.SwitchOff(At(date, 10.0), At(date, 19.0));

        // Three of the six places, in the order they are drawn.
        var pool = trip.Pois.ToList();
        for (var stop = 0; stop < 3; stop++)
        {
            var poi = pool[_plan.Next(pool.Count)];
            pool.Remove(poi);
            Go(poi, Geo.DistanceMeters(_phone.Here, poi.Position) < 2500 ? Gait.Walk : Gait.Transit);
            _phone.StayFor(Minutes(40, 100));
        }
        Go(trip.Hotel, Gait.Transit);
    }

    private void Fly(Place to)
    {
        _phone.Fly(to.Position, Cruise, logInFlight: _plan.Chance(0.6));
        _at = to;
    }

    // ---- helpers -----------------------------------------------------------------------------------------------

    /// <summary>Walks, rides or drives to <paramref name="to"/> from where the person is, on the road that links the two places.</summary>
    private void Go(Place to, Gait gait)
    {
        var line = _roads.Between(_at, to);
        var route = new GeoPoint[line.Count];
        route[0] = _phone.Here;
        for (var k = 1; k < route.Length - 1; k++)
            route[k] = line[k];
        route[^1] = _phone.Spot(to.Position);

        if (gait == Gait.Drive && Geo.DistanceMeters(_at.Position, to.Position) > 12_000)
            gait = Gait.Highway;
        _phone.Travel(route, gait);
        _at = to;
    }

    /// <summary>Cycling in summer, mostly driving in winter.</summary>
    private Gait CommuteMode(DateOnly date) => _plan.Chance(0.12 + 0.5 * Summerness(date)) ? Gait.Cycle : Gait.Drive;

    /// <summary>For a short trip across the neighbourhood: mostly on foot.</summary>
    private Gait ShortTripMode(DateOnly date)
    {
        var roll = _plan.NextDouble();
        var cycle = 0.15 + 0.3 * Summerness(date);
        return roll < 0.1 ? Gait.Drive : roll < 0.1 + cycle ? Gait.Cycle : Gait.Walk;
    }

    /// <summary>0 in midwinter, 1 in midsummer.</summary>
    private static double Summerness(DateOnly date) => 0.5 * (1 + Math.Cos(2 * Math.PI * (date.DayOfYear - 200) / 365.0));

    private TimeSpan Minutes(double low, double high) => TimeSpan.FromMinutes(_plan.Uniform(low, high));

    private DateTime At(DateOnly date, double hour) => Utc(date, hour, _zone);

    private static DateTime Later(DateTime a, DateTime b) => a > b ? a : b;

    private static DateTime Utc(DateOnly date, double hour, TimeZoneInfo zone)
    {
        var local = date.ToDateTime(TimeOnly.MinValue).AddHours(hour);
        if (zone.IsInvalidTime(local))
            local = local.AddHours(1);
        return TimeZoneInfo.ConvertTimeToUtc(local, zone);
    }

    private static DateOnly LocalDate(DateTime utc, TimeZoneInfo zone) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(utc, zone));

    private static double LocalHour(DateTime utc, TimeZoneInfo zone) => TimeZoneInfo.ConvertTimeFromUtc(utc, zone).TimeOfDay.TotalHours;
}
