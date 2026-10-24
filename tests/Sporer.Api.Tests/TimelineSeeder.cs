namespace Sporer.Api.Tests;

/// <summary>
/// Writes places, segments, dirty ranges and backfill state straight into the database, so that a test can pin a rule with
/// exactly the rows it needs (a processed track also makes the rows, but not the ones a rule is about). Every call is
/// cancelled with the running test.
/// </summary>
public static class TimelineSeeder
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public static Task<long> InsertPlaceAsync(
        string cs, string? userName = null, string? osmName = null, string? city = null, string? country = null,
        double lat = 59.92, double lon = 10.75, long? mergedInto = null) => Sql.ScalarAsync<long>(cs,
        """
        insert into place (latitude, longitude, osm_name, city, country, user_name, merged_into_id, geocode_state)
        values (@lat, @lon, @osmName, @city, @country, @userName, @mergedInto, 'done') returning id
        """,
        new { lat, lon, osmName, city, country, userName, mergedInto }, Ct);

    /// <remarks>
    /// The local dates are given, not worked out from the times: a test says what the stored row says. <paramref name="geometry"/>
    /// is stored as both the detail and the coarse line.
    /// </remarks>
    public static Task<long> InsertSegmentAsync(
        string cs, string kind, DateTime start, DateTime end, DateOnly localStart, DateOnly localEnd,
        string startTz = "Europe/Oslo", string? endTz = null, long? placeId = null, string? mode = null,
        double? distance = null, string? geometry = null) => Sql.ScalarAsync<long>(cs,
        """
        insert into segment (kind, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date, place_id,
                             mode, distance_m, geometry_detail, geometry_coarse)
        values (@kind, @start, @end, @startTz, @endTz, @localStart, @localEnd, @placeId,
                @mode, @distance, @geometry::jsonb, @geometry::jsonb) returning id
        """,
        new { kind, start, end, startTz, endTz = endTz ?? startTz, localStart, localEnd, placeId, mode, distance, geometry }, Ct);

    public static Task InsertDirtyRangeAsync(string cs, DateTime from, DateTime to, int attempts = 0, DateTime? nextAttemptAt = null)
        => Sql.ExecAsync(cs,
            "insert into dirty_range (from_utc, to_utc, attempts, next_attempt_at, last_error) values (@from, @to, @attempts, @nextAttemptAt, @error)",
            new { from, to, attempts, nextAttemptAt, error = attempts > 0 ? "boom" : null }, Ct);

    public static Task SetBackfillAsync(string cs, DateTime? from, DateTime? to, DateTime? cursor) => Sql.ExecAsync(cs,
        "update processing_state set backfill_from = @from, backfill_to = @to, backfill_cursor = @cursor where id = 1",
        new { from, to, cursor }, Ct);
}
