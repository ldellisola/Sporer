using Sporer.Timeline;

namespace Sporer.Api.Features.Trips;

/// <summary>The small line a trip is drawn with in the list: from home, through the places it slept at, and back.</summary>
public static class TripThumbnail
{
    /// <summary>Nights this close together were in the same place, as far as a drawing a few centimetres wide can tell.</summary>
    private const double SamePlaceMeters = 1000;

    /// <summary>
    /// The line of a trip: <paramref name="homeAtStart"/>, then the positions of its known <paramref name="nights"/> in order,
    /// then <paramref name="homeAtEnd"/>. An end with no home is left out. A night within a kilometre of the point kept before
    /// it adds nothing (a week in one city is one point), and it is measured from the last point kept, not from the night
    /// before, so that a slow drift of several kilometres still draws its way.
    /// </summary>
    public static IReadOnlyList<GeoPoint> Line(GeoPoint? homeAtStart, IEnumerable<GeoPoint> nights, GeoPoint? homeAtEnd)
    {
        var line = new List<GeoPoint>();
        if (homeAtStart is { } start)
            line.Add(start);

        GeoPoint? kept = null;
        foreach (var night in nights)
        {
            if (kept is { } last && Geo.DistanceMeters(last, night) <= SamePlaceMeters)
                continue;

            line.Add(night);
            kept = night;
        }

        if (homeAtEnd is { } end)
            line.Add(end);

        return line;
    }
}
