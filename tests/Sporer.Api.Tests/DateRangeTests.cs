using Sporer.Api.Features.Range;

namespace Sporer.Api.Tests;

public class DateRangeTests
{
    [Theory]
    [InlineData("2026-10-01", "2026-10-31", 31)]
    [InlineData("2026-10-22", "2026-10-22", 1)]
    [InlineData("2026-01-01", "2027-02-04", 400)]
    [InlineData("2024-02-28", "2024-03-01", 3)]
    [InlineData("0001-01-01", "0001-01-01", 1)]
    [InlineData("9999-12-31", "9999-12-31", 1)]
    public void Valid_range_is_parsed(string from, string to, int days)
    {
        Assert.True(DateRange.TryParse(from, to, out var range, out var error));

        Assert.Null(error);
        Assert.Equal(DateOnly.ParseExact(from, "yyyy-MM-dd"), range.From);
        Assert.Equal(DateOnly.ParseExact(to, "yyyy-MM-dd"), range.To);
        Assert.Equal(days, range.Days);
    }

    [Theory]
    [InlineData(null, "2026-10-31")]
    [InlineData("2026-10-01", null)]
    [InlineData(null, null)]
    [InlineData("", "")]
    [InlineData("   ", "2026-10-31")]
    [InlineData("2026-1-5", "2026-10-31")]
    [InlineData("2026-10-01", "2026-10-3")]
    [InlineData("20261001", "20261031")]
    [InlineData("2026/10/01", "2026/10/31")]
    [InlineData("01-10-2026", "31-10-2026")]
    [InlineData("2026-02-30", "2026-03-05")]
    [InlineData("2026-13-01", "2026-13-02")]
    [InlineData("2026-10-01T00:00", "2026-10-31")]
    [InlineData("2026-10-01Z", "2026-10-31")]
    [InlineData(" 2026-10-01", "2026-10-31")]
    [InlineData("2026-10-01", "2026-10-31 ")]
    [InlineData("+2026-10-01", "2026-10-31")]
    [InlineData("today", "tomorrow")]
    public void Malformed_dates_are_refused(string? from, string? to)
    {
        Assert.False(DateRange.TryParse(from, to, out var range, out var error));

        Assert.Equal(default, range);
        Assert.False(string.IsNullOrWhiteSpace(error));
        Assert.Contains("yyyy-MM-dd", error);
    }

    [Fact]
    public void Range_the_wrong_way_round_is_refused()
    {
        Assert.False(DateRange.TryParse("2026-10-31", "2026-10-01", out var range, out var error));

        Assert.Equal(default, range);
        Assert.False(string.IsNullOrWhiteSpace(error));
    }

    [Theory]
    [InlineData("2026-01-01", "2027-02-05")] // 401 days
    [InlineData("2026-01-01", "2028-01-01")]
    [InlineData("0001-01-01", "9999-12-31")]
    public void Range_of_more_than_400_days_is_refused(string from, string to)
    {
        Assert.False(DateRange.TryParse(from, to, out var range, out var error));

        Assert.Equal(default, range);
        Assert.Contains("400", error);
    }
}
