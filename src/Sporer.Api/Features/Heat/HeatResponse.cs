namespace Sporer.Api.Features.Heat;

/// <summary>
/// The time spent over a stretch of local days, cell by cell, as served by <c>GET /api/heat</c>, for the map's heat layer.
/// <paramref name="Cells"/> are <c>[lon, lat, seconds]</c> (the longitude first, as in GeoJSON): the centre of a cell of the
/// grid (see <see cref="Sporer.Api.Features.Range.RangeStore.FindHeatAsync"/>) and the seconds spent in it, the most first.
/// <paramref name="MaxSeconds"/> is the weight of the first, so that a client can scale the rest by it; 0 when there are none.
/// </summary>
public sealed record HeatResponse(long MaxSeconds, IReadOnlyList<double[]> Cells);
