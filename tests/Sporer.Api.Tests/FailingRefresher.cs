using Sporer.Api.Features.Trips;

namespace Sporer.Api.Tests;

/// <summary>
/// An <see cref="ITripRefresher"/> whose <see cref="RecomputeAsync"/> fails, for the tests of what an edit does when the homes and trips
/// cannot be worked out: the first <paramref name="failures"/> calls throw (every call, when it is null), and the ones after them go
/// on to <paramref name="inner"/>. With no <paramref name="inner"/>, a refresh is not expected, and fails too.
/// </summary>
internal sealed class FailingRefresher(ITripRefresher? inner = null, int? failures = null) : ITripRefresher
{
    private int _calls;

    /// <summary>How many times a recompute was asked for.</summary>
    public int Recomputes => Volatile.Read(ref _calls);

    public Task RefreshAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct)
        => inner?.RefreshAsync(fromUtc, toUtc, ct) ?? throw new NotSupportedException("this refresher only recomputes, and fails");

    public Task RecomputeAsync(CancellationToken ct)
    {
        var call = Interlocked.Increment(ref _calls);
        if (inner is null || call <= failures)
            throw new InvalidOperationException("the homes and trips cannot be worked out");
        return inner.RecomputeAsync(ct);
    }
}
