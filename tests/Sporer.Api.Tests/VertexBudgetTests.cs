using Sporer.Api.Features.Range;
using Sporer.Timeline;

namespace Sporer.Api.Tests;

public class VertexBudgetTests
{
    /// <summary>
    /// <paramref name="count"/> vertices 100 m apart, east from a base point: the first and the last on the base line, the ones
    /// between alternately <paramref name="amplitudeMeters"/> north and as far south of it. A tolerance below the amplitude
    /// removes next to nothing of such a line; one from the amplitude up removes all but its two ends.
    /// </summary>
    private static GeoPoint[] ZigZag(int count, double amplitudeMeters)
    {
        var origin = new GeoPoint(59.9, 10.7);
        return Enumerable.Range(0, count)
            .Select(k => Geo.Offset(origin, k == 0 || k == count - 1 ? 0 : k % 2 == 0 ? amplitudeMeters : -amplitudeMeters, 100.0 * k))
            .ToArray();
    }

    private static int Total(IEnumerable<IReadOnlyList<GeoPoint>> lines) => lines.Sum(l => l.Count);

    [Fact]
    public void Lines_within_the_budget_are_returned_as_they_are()
    {
        IReadOnlyList<IReadOnlyList<GeoPoint>> lines = [ZigZag(400, 500), ZigZag(300, 500)];

        var fitted = VertexBudget.Fit(lines, maxVertices: 700);

        Assert.Same(lines, fitted);
    }

    [Fact]
    public void Tolerance_doubles_from_100_meters_and_stops_at_the_first_that_fits()
    {
        // 7 000 vertices against a budget of 6 000. At 100 m next to nothing goes; at 200 m the 50 lines with the 150 m swing
        // are cut to their ends (5 000 vertices), which is enough: the 20 with a 450 m swing must keep their vertices.
        var small = Enumerable.Range(0, 50).Select(_ => ZigZag(100, 150)).ToList();
        var big = Enumerable.Range(0, 20).Select(_ => ZigZag(100, 450)).ToList();
        var lines = small.Concat(big).ToList();

        var fitted = VertexBudget.Fit(lines, maxVertices: 6_000);

        Assert.Equal(70, fitted.Count);
        for (var k = 0; k < small.Count; k++)
            Assert.Equal([small[k][0], small[k][^1]], fitted[k]);
        for (var k = small.Count; k < lines.Count; k++)
        {
            Assert.InRange(fitted[k].Count, 50, 100);
            Assert.Equal(lines[k][0], fitted[k][0]);
            Assert.Equal(lines[k][^1], fitted[k][^1]);
        }
    }

    [Fact]
    public void Every_line_keeps_its_ends_and_only_vertices_it_had_in_their_order()
    {
        var originals = new[] { 30.0, 250, 450, 900, 1800 }.SelectMany(a => Enumerable.Repeat(a, 40)).Select(a => ZigZag(400, a)).ToList();

        var fitted = VertexBudget.Fit(originals, maxVertices: 30_000);

        Assert.InRange(Total(fitted), 2 * originals.Count, 30_000);
        for (var k = 0; k < originals.Count; k++)
        {
            Assert.Equal(originals[k][0], fitted[k][0]);
            Assert.Equal(originals[k][^1], fitted[k][^1]);
            var at = 0;
            foreach (var point in fitted[k])
            {
                while (at < originals[k].Length && originals[k][at] != point)
                    at++;
                Assert.True(at < originals[k].Length, $"Line {k} has a vertex that is not on the original, or out of order.");
                at++;
            }
        }
    }

    [Fact]
    public async Task Terminates_when_the_ends_alone_are_over_the_budget()
    {
        // 30 001 lines of two vertices are 60 002 vertices, and no tolerance can remove an end: the budget cannot be met, the
        // lines are returned as short as they can be, and the search for a tolerance ends.
        var lines = Enumerable.Range(0, 30_001)
            .Select(k => (IReadOnlyList<GeoPoint>)[new GeoPoint(59.9, 10.7), new GeoPoint(59.9 + k * 1e-6, 10.8)])
            .ToList();

        var fitted = await Task.Run(() => VertexBudget.Fit(lines)).WaitAsync(TimeSpan.FromSeconds(60), TestContext.Current.CancellationToken);

        Assert.Equal(30_001, fitted.Count);
        Assert.All(fitted, line => Assert.Equal(2, line.Count));
    }

    [Fact]
    public async Task Terminates_with_the_ends_kept_when_a_line_cannot_be_reduced_enough()
    {
        // Three long lines against a budget below the six vertices their ends need: they end up as the ends and no further.
        var lines = Enumerable.Range(0, 3).Select(k => (IReadOnlyList<GeoPoint>)ZigZag(1000, 300 + k)).ToList();

        var fitted = await Task.Run(() => VertexBudget.Fit(lines, maxVertices: 4)).WaitAsync(TimeSpan.FromSeconds(60), TestContext.Current.CancellationToken);

        Assert.All(fitted.Zip(lines), pair => Assert.Equal([pair.Second[0], pair.Second[^1]], pair.First));
    }

    [Fact]
    public void Empty_lines_and_no_lines_are_fine()
    {
        Assert.Empty(VertexBudget.Fit([]));

        IReadOnlyList<IReadOnlyList<GeoPoint>> lines = [[], [new GeoPoint(59.9, 10.7)], ZigZag(100, 500)];
        var fitted = VertexBudget.Fit(lines, maxVertices: 10);

        Assert.Empty(fitted[0]);
        Assert.Single(fitted[1]);
        Assert.Equal(2, fitted[2].Count);
    }
}
