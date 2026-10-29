using Sporer.Api.Features.Day;
using Sporer.Api.Features.Points;

namespace Sporer.Api.Tests;

/// <summary>
/// Which local dates the points of a removal are on (<see cref="RemovedBatchDates"/>), against the widest span a date can have: the one
/// <see cref="DaySpan.Of"/> gives a date it knows no zone for, 14 hours before its UTC midnight to 14 hours after the next one.
/// </summary>
public class RemovedBatchDatesTests
{
    private static DateTime Utc(int month, int day, int hour, int minute = 0) => new(2026, month, day, hour, minute, 0, DateTimeKind.Utc);

    private static Task<(DateTime FromUtc, DateTime ToUtc)> Widest(DateOnly date) => Task.FromResult(DaySpan.Of(date, null));

    [Fact]
    public async Task A_time_at_13_hours_is_on_the_day_before_it_in_the_widest_span()
    {
        // 14 October's widest span ends at 14:00 UTC on the 15th: a time at 13:00 is on it, which a look back of 12 hours would not have found.
        var dates = await RemovedBatchDates.OfAsync([Utc(10, 15, 13)], Widest);

        Assert.Equal([new DateOnly(2026, 10, 14), new DateOnly(2026, 10, 15), new DateOnly(2026, 10, 16)], dates);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(9)]
    [InlineData(10)]
    [InlineData(11)]
    [InlineData(12)]
    [InlineData(13)]
    [InlineData(14)]
    [InlineData(23)]
    public async Task Every_date_whose_widest_span_holds_a_time_is_found_for_it(int hour)
    {
        foreach (var minute in new[] { 0, 1, 59 })
        {
            var time = Utc(10, 15, hour, minute);
            var expected = new List<DateOnly>();
            for (var date = new DateOnly(2026, 10, 12); date <= new DateOnly(2026, 10, 18); date = date.AddDays(1))
            {
                var (from, to) = DaySpan.Of(date, null);
                if (from <= time && time < to)
                    expected.Add(date);
            }

            var dates = await RemovedBatchDates.OfAsync([time], Widest);

            Assert.Equal(expected, dates);
        }
    }

    [Fact]
    public async Task A_time_exactly_at_the_end_of_the_widest_span_is_not_on_that_day()
    {
        // The end is exclusive: 14:00 UTC on the 15th is the first instant after 14 October's widest span.
        var dates = await RemovedBatchDates.OfAsync([Utc(10, 15, 14)], Widest);

        Assert.Equal([new DateOnly(2026, 10, 15), new DateOnly(2026, 10, 16)], dates);
    }

    [Fact]
    public async Task Dates_are_asked_about_once_each_however_many_times_there_are()
    {
        var asked = new List<DateOnly>();

        await RemovedBatchDates.OfAsync([Utc(10, 15, 3), Utc(10, 15, 13), Utc(10, 15, 20)], date =>
        {
            asked.Add(date);
            return Widest(date);
        });

        Assert.Equal(asked.Distinct().Count(), asked.Count);
        Assert.Equal([new DateOnly(2026, 10, 14), new DateOnly(2026, 10, 15), new DateOnly(2026, 10, 16)], asked);
    }
}
