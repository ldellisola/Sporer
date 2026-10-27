using Sporer.Api.Features.Trips;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

/// <summary>
/// How a trip is named from its nights, and how its nights are grouped into the cities it is drawn with. The nights are
/// given as (date, city, country), one per known night, in any order: the grouping is the function's own.
/// </summary>
public class TripNamingTests
{
    private static DateOnly D(int day) => new(2026, 9, day);

    /// <summary>The nights of a trip from the 1st of September: one place per night, given as "city, country".</summary>
    private static IReadOnlyList<(DateOnly Night, string? City, string? Country)> Nights(params (string? City, string? Country)[] places)
        => [.. places.Select((p, k) => (D(1 + k), p.City, p.Country))];

    private static TripNight At(int day, string? city, string? country, double lat = 0, double lon = 0)
        => new(D(day), city, country, new GeoPoint(lat, lon));

    // ---- the name ----------------------------------------------------------------------------------------------------

    [Fact]
    public void TripNaming_one_city()
    {
        Assert.Equal("Lisbon", TripNaming.Name(Nights(("Lisbon", "Portugal"), ("Lisbon", "Portugal"), ("Lisbon", "Portugal"))));
    }

    [Fact]
    public void TripNaming_two_cities()
    {
        Assert.Equal("Lisbon & Porto", TripNaming.Name(Nights(("Lisbon", "Portugal"), ("Lisbon", "Portugal"), ("Porto", "Portugal"))));
    }

    [Fact]
    public void TripNaming_three_cities_in_one_country()
    {
        Assert.Equal("Portugal", TripNaming.Name(Nights(("Lisbon", "Portugal"), ("Porto", "Portugal"), ("Faro", "Portugal"))));
    }

    [Fact]
    public void TripNaming_two_countries()
    {
        var nights = Nights(("Lisbon", "Portugal"), ("Porto", "Portugal"), ("Madrid", "Spain"));

        Assert.Equal("Portugal & Spain", TripNaming.Name(nights));
    }

    [Fact]
    public void TripNaming_three_countries()
    {
        var nights = Nights(("Lisbon", "Portugal"), ("Lisbon", "Portugal"), ("Madrid", "Spain"), ("Paris", "France"));

        Assert.Equal("Portugal, Spain & France", TripNaming.Name(nights));
    }

    [Fact]
    public void TripNaming_four_countries_say_how_many_more()
    {
        var nights = Nights(("Lisbon", "Portugal"), ("Madrid", "Spain"), ("Paris", "France"), ("Bern", "Switzerland"));

        Assert.Equal("Portugal, Spain & 2 more", TripNaming.Name(nights));
    }

    [Fact]
    public void TripNaming_five_countries()
    {
        var nights = Nights(
            ("Lisbon", "Portugal"), ("Madrid", "Spain"), ("Paris", "France"), ("Bern", "Switzerland"), ("Rome", "Italy"));

        Assert.Equal("Portugal, Spain & 3 more", TripNaming.Name(nights));
    }

    [Fact]
    public void TripNaming_no_city_uses_country()
    {
        Assert.Equal("Portugal", TripNaming.Name(Nights((null, "Portugal"), (null, "Portugal"))));
        Assert.Equal("Portugal & Spain", TripNaming.Name(Nights((null, "Portugal"), (null, "Spain"))));
        Assert.Equal("Portugal, Spain & France", TripNaming.Name(Nights((null, "Portugal"), (null, "Spain"), (null, "France"))));
        Assert.Equal("Portugal, Spain & 2 more", TripNaming.Name(Nights((null, "Portugal"), (null, "Spain"), (null, "France"), (null, "Italy"))));
    }

    [Fact]
    public void TripNaming_nothing_is_Trip()
    {
        Assert.Equal("Trip", TripNaming.Name([]));
        Assert.Equal("Trip", TripNaming.Name(Nights((null, null), (null, null))));
        Assert.Equal("Trip", TripNaming.Name(Nights(("", " "), (null, ""))));
    }

    [Fact]
    public void TripNaming_puts_the_city_with_most_nights_first_and_breaks_a_tie_by_the_earlier_night()
    {
        // Porto has the most nights, though Lisbon came first.
        Assert.Equal("Porto & Lisbon", TripNaming.Name(Nights(
            ("Lisbon", "Portugal"), ("Porto", "Portugal"), ("Porto", "Portugal"))));

        // One night each: the first night decides, however the list is ordered.
        Assert.Equal("Lisbon & Porto", TripNaming.Name([(D(3), "Porto", "Portugal"), (D(1), "Lisbon", "Portugal")]));
    }

    [Fact]
    public void TripNaming_counts_the_nights_of_a_city_wherever_they_fall()
    {
        // Lisbon on the 1st and the 3rd is one city with two nights: it outnumbers Porto and is named first.
        Assert.Equal("Lisbon & Porto", TripNaming.Name(Nights(("Lisbon", "Portugal"), ("Porto", "Portugal"), ("Lisbon", "Portugal"))));
    }

    [Fact]
    public void TripNaming_cities_keep_two_cities_of_the_same_name_in_different_countries_apart()
    {
        var cities = TripNaming.Cities([At(1, "Valencia", "Spain"), At(2, "Valencia", "Venezuela"), At(3, "Valencia", "Venezuela")]);

        Assert.Equal([("Venezuela", 2), ("Spain", 1)], cities.Select(c => (c.Country, c.Nights)));
    }

    [Fact]
    public void TripNaming_names_a_trip_by_its_cities_and_ignores_a_night_that_has_only_a_country()
    {
        // The night in the countryside has a country and no city: the cities name the trip, as they are.
        Assert.Equal("Lisbon", TripNaming.Name(Nights(("Lisbon", "Portugal"), (null, "Portugal"), (null, "Portugal"))));
    }

    [Fact]
    public void TripNaming_orders_the_countries_by_their_own_nights()
    {
        // A has three nights, the most of any city; B and C have two each, in country Y, which has four nights to X's three.
        var nights = Nights(("A", "X"), ("A", "X"), ("A", "X"), ("B", "Y"), ("B", "Y"), ("C", "Y"), ("C", "Y"));

        Assert.Equal("Y & X", TripNaming.Name(nights));
    }

    [Fact]
    public void TripNaming_counts_a_night_with_only_a_country_toward_its_country()
    {
        var nights = Nights(("A", "X"), ("B", "Y"), ("C", "Z"), (null, "Z"), (null, "Z"));

        Assert.Equal("Z, X & Y", TripNaming.Name(nights));
    }

    // ---- the label ---------------------------------------------------------------------------------------------------

    [Theory]
    [InlineData(1, "1 night")]
    [InlineData(2, "2 nights")]
    [InlineData(4, "4 nights")]
    [InlineData(24, "24 nights")]
    [InlineData(1000, "1000 nights")]
    public void TripNaming_nights_label_singular_and_plural(int nights, string label)
    {
        Assert.Equal(label, TripNaming.NightsLabel(nights));
    }

    // ---- the cities ----------------------------------------------------------------------------------------------------

    [Fact]
    public void TripNaming_cities_group_by_city_and_country_most_nights_first()
    {
        var cities = TripNaming.Cities(
        [
            At(1, "Porto", "Portugal", 41, -8), At(2, "Lisbon", "Portugal", 38, -9), At(3, "Lisbon", "Portugal", 38, -9),
            At(4, "Madrid", "Spain", 40, -3),
        ]);

        Assert.Equal(
            [("Lisbon", "Portugal", 2), ("Porto", "Portugal", 1), ("Madrid", "Spain", 1)],
            cities.Select(c => (c.Name, c.Country, c.Nights)));
    }

    [Fact]
    public void TripNaming_cities_break_a_tie_by_the_earlier_first_night()
    {
        var cities = TripNaming.Cities([At(5, "Faro", "Portugal"), At(2, "Porto", "Portugal"), At(3, "Lisbon", "Portugal")]);

        Assert.Equal(["Porto", "Lisbon", "Faro"], cities.Select(c => c.Name));
    }

    [Fact]
    public void TripNaming_cities_are_placed_at_the_mean_of_their_nights()
    {
        var cities = TripNaming.Cities([At(1, "Lisbon", "Portugal", 38.70, -9.10), At(2, "Lisbon", "Portugal", 38.74, -9.20), At(3, "Porto", "Portugal", 41.15, -8.61)]);

        Assert.Equal(38.72, cities[0].Latitude, 10);
        Assert.Equal(-9.15, cities[0].Longitude, 10);
        Assert.Equal((41.15, -8.61), (cities[1].Latitude, cities[1].Longitude));
    }

    [Fact]
    public void TripNaming_cities_group_a_night_without_a_city_under_its_country_and_leave_out_a_night_with_neither()
    {
        var cities = TripNaming.Cities(
        [
            At(1, "Lisbon", "Portugal", 38, -9), At(2, null, "Spain", 40, -4), At(3, null, "Spain", 41, -3), At(4, null, null, 10, 10), At(5, " ", "", 20, 20),
        ]);

        Assert.Equal(
            [("Spain", (string?)"Spain", 2, 40.5, -3.5), ("Lisbon", "Portugal", 1, 38.0, -9.0)],
            cities.Select(c => (c.Name, c.Country, c.Nights, c.Latitude, c.Longitude)));
    }

    [Fact]
    public void TripNaming_cities_make_one_group_of_a_night_named_by_its_country_and_a_city_of_the_same_name_in_it()
    {
        // Singapore is a city and a country: a night whose place has only the country, and one whose place has the city, are
        // both "Singapore, Singapore" on the map, and so one entry.
        var cities = TripNaming.Cities(
        [
            At(1, null, "Singapore", 1.30, 103.80), At(2, "Singapore", "Singapore", 1.40, 103.90), At(3, "Lisbon", "Portugal", 38, -9),
        ]);

        Assert.Equal(
            [("Singapore", (string?)"Singapore", 2, 1.35, 103.85), ("Lisbon", "Portugal", 1, 38.0, -9.0)],
            cities.Select(c => (c.Name, c.Country, c.Nights, c.Latitude, c.Longitude)));
    }

    [Fact]
    public void TripNaming_cities_keep_a_night_named_by_its_country_apart_from_a_city_of_that_name_in_another_country()
    {
        // Peru, Indiana is not Peru.
        var cities = TripNaming.Cities([At(1, null, "Peru"), At(2, "Peru", "United States")]);

        Assert.Equal([("Peru", (string?)"Peru"), ("Peru", "United States")], cities.Select(c => (c.Name, c.Country)));
    }

    [Fact]
    public void TripNaming_cities_keep_a_city_that_has_no_country()
    {
        var cities = TripNaming.Cities([At(1, "Somewhere", null, 1, 2)]);

        var city = Assert.Single(cities);
        Assert.Equal(("Somewhere", (string?)null, 1), (city.Name, city.Country, city.Nights));
    }

    [Fact]
    public void TripNaming_cities_of_nothing_are_none()
    {
        Assert.Empty(TripNaming.Cities([]));
        Assert.Empty(TripNaming.Cities([At(1, null, null)]));
    }

    // ---- the line of a day -----------------------------------------------------------------------------------------------

    /// <summary>The stays of a day, as (city, place name), in time order.</summary>
    private static IReadOnlyList<(string? City, string? PlaceName)> Stays(params (string? City, string? PlaceName)[] stays) => stays;

    [Fact]
    public void TripNaming_day_line_is_the_city_of_a_day_spent_in_one()
    {
        Assert.Equal("Oslo", TripNaming.DayLine(Stays(("Oslo", "Home")), hasMoves: false));
    }

    [Fact]
    public void TripNaming_day_line_says_the_cities_in_order_and_a_city_that_follows_itself_once()
    {
        var stays = Stays(("Oslo", "Airport"), ("Oslo", "Cafe"), ("Lisbon", "Hotel"), ("Lisbon", "Market"));

        Assert.Equal("Oslo → Lisbon", TripNaming.DayLine(stays, hasMoves: true));
    }

    [Fact]
    public void TripNaming_day_line_says_a_city_again_when_the_person_returns_to_it()
    {
        Assert.Equal("Oslo → Lisbon → Oslo", TripNaming.DayLine(Stays(("Oslo", null), ("Lisbon", null), ("Oslo", null)), hasMoves: true));
    }

    [Fact]
    public void TripNaming_day_line_passes_over_a_stay_with_no_city_while_another_has_one()
    {
        // The stay with no city does not come between the two in Lisbon, and its name is not used: the cities say the day.
        Assert.Equal("Lisbon", TripNaming.DayLine(Stays(("Lisbon", "Hotel"), (null, "Mountain hut"), ("Lisbon", "Cafe")), hasMoves: false));
        Assert.Equal("Lisbon", TripNaming.DayLine(Stays((null, "Mountain hut"), ("Lisbon", null)), hasMoves: false));
    }

    [Fact]
    public void TripNaming_day_line_without_any_city_is_the_place_names_the_same_way()
    {
        var stays = Stays((null, "Hut A"), (null, "Hut A"), (null, null), (null, "Hut B"));

        Assert.Equal("Hut A → Hut B", TripNaming.DayLine(stays, hasMoves: true));
    }

    [Fact]
    public void TripNaming_day_line_counts_an_empty_city_or_name_as_none()
    {
        Assert.Equal("Hut", TripNaming.DayLine(Stays(("", "Hut"), (" ", "Hut")), hasMoves: false));
        Assert.Equal("Travelling", TripNaming.DayLine(Stays(("", " "), (" ", "")), hasMoves: true));
    }

    [Fact]
    public void TripNaming_day_line_with_nothing_to_describe_it_by_is_travelling_with_a_move_and_no_data_without()
    {
        Assert.Equal("Travelling", TripNaming.DayLine(Stays(), hasMoves: true));
        Assert.Equal("No data", TripNaming.DayLine(Stays(), hasMoves: false));
        // Stays at places the geocoder has not named leave the day as it is with no stays at all.
        Assert.Equal("Travelling", TripNaming.DayLine(Stays((null, null), (null, null)), hasMoves: true));
        Assert.Equal("No data", TripNaming.DayLine(Stays((null, null)), hasMoves: false));
    }

    [Fact]
    public void TripNaming_city_key_is_the_name_it_is_drawn_under_and_the_country()
    {
        Assert.Equal(("Lisbon", "Portugal"), TripNaming.CityKey("Lisbon", "Portugal"));
        Assert.Equal(("Portugal", "Portugal"), TripNaming.CityKey(null, "Portugal"));
        Assert.Equal(("Portugal", "Portugal"), TripNaming.CityKey(" ", "Portugal"));
        Assert.Equal(("Somewhere", null), TripNaming.CityKey("Somewhere", ""));
        Assert.Equal(TripNaming.CityKey("Singapore", "Singapore"), TripNaming.CityKey(null, "Singapore")); // one city
        Assert.NotEqual(TripNaming.CityKey("Peru", "United States"), TripNaming.CityKey(null, "Peru"));
        Assert.Null(TripNaming.CityKey(null, null));
        Assert.Null(TripNaming.CityKey("", " "));
    }
}
