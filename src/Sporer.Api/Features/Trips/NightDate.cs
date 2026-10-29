using System.Globalization;
using FluentValidation.Results;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// A night date in a request body (<c>yyyy-MM-dd</c>), as the endpoints that take the dates of a trip or of a home read it: the dates that the
/// owner gives (<c>PUT /api/trips/{id}</c>, <c>POST /api/homes</c>) are all of one kind, so they are read in one way, in one range, with one
/// message. (A date in a route is read as <see cref="TripId"/> and <c>DayDate</c> do.)
/// </summary>
internal static class NightDate
{
    /// <summary>The earliest date that can be given: nothing was ever logged before it.</summary>
    public static readonly DateOnly Earliest = new(1970, 1, 1);

    /// <summary>The latest date that can be given.</summary>
    public static readonly DateOnly Latest = new(2099, 12, 31);

    /// <summary>
    /// The date <paramref name="text"/> says, exactly as <c>yyyy-MM-dd</c> and from <see cref="Earliest"/> to <see cref="Latest"/>. Null is no date:
    /// as detected, or none, where the date is not <paramref name="required"/>. What is wrong is added to <paramref name="failures"/> as a failure
    /// of <paramref name="property"/> (a missing date where one is required, a text that is not a date, a date out of range), and the answer is
    /// null.
    /// </summary>
    public static DateOnly? Read(string? text, string property, bool required, ICollection<ValidationFailure> failures)
    {
        if (text is null)
        {
            if (required)
                failures.Add(new(property, "The date must be given, as yyyy-MM-dd."));
            return null;
        }

        if (!DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            || date < Earliest || date > Latest)
        {
            failures.Add(new(property,
                $"The date must be written yyyy-MM-dd, from {TripMapping.Text(Earliest)} to {TripMapping.Text(Latest)}" + (required ? "." : ", or be null.")));
            return null;
        }

        return date;
    }
}
