using Dapper;
using Npgsql;
using Sporer.Timeline;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// The write side of the homes and trips (<c>home_period</c>, <c>trip</c>), and the window of the timeline that has been
/// rebuilt since they were last worked out (<c>night_refresh</c>). Everything in it is derived, and is rewritten as a whole
/// from the nights by <see cref="TripRefresher"/>.
/// </summary>
public sealed class TripStore(NpgsqlDataSource dataSource, NightStore nightStore)
{
    /// <summary>
    /// Adds <paramref name="fromUtc"/> to <paramref name="toUtc"/> to the window that waits to be refreshed: the window
    /// becomes the one stretch from the earliest start to the latest end of everything added since the last refresh, so what
    /// lies between two separate additions is refreshed too. It is stored, so that a restart does not lose it.
    /// </summary>
    public async Task ExtendPendingAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            // least and greatest skip a null, which is how an empty window takes the first one.
            """
            insert into night_refresh (id, from_utc, to_utc) values (1, @From, @To)
            on conflict (id) do update set
                from_utc = least(night_refresh.from_utc, excluded.from_utc),
                to_utc = greatest(night_refresh.to_utc, excluded.to_utc)
            """,
            new { From = AsUtc(fromUtc), To = AsUtc(toUtc) }, cancellationToken: ct));
    }

    /// <summary>The window that waits to be refreshed, or null when nothing does. It stays until <see cref="ClearPendingAsync"/>.</summary>
    public async Task<(DateTime From, DateTime To)?> TakePendingAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var row = await connection.QuerySingleOrDefaultAsync<PendingRow>(new CommandDefinition(
            "select from_utc as FromUtc, to_utc as ToUtc from night_refresh where id = 1", cancellationToken: ct));

        return row is { FromUtc: { } from, ToUtc: { } to } ? (AsUtc(from), AsUtc(to)) : null;
    }

    /// <summary>
    /// Empties the window, but only if it is still exactly <paramref name="fromUtc"/> to <paramref name="toUtc"/>, the one
    /// <see cref="TakePendingAsync"/> gave: whatever was added to it since has not been refreshed yet and must stay.
    /// </summary>
    public async Task ClearPendingAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            "update night_refresh set from_utc = null, to_utc = null where id = 1 and from_utc = @From and to_utc = @To",
            new { From = AsUtc(fromUtc), To = AsUtc(toUtc) }, cancellationToken: ct));
    }

    /// <summary>
    /// Replaces every detected home period and every trip by <paramref name="homes"/> and <paramref name="trips"/>. The home
    /// periods the owner set (<c>user</c>) are not touched. One transaction: readers see the old rows or the new ones, and a
    /// failure leaves the old ones.
    /// </summary>
    public async Task ReplaceDetectedAsync(
        IReadOnlyList<HomePeriod> homes, IReadOnlyList<DetectedTrip> trips, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        await ReplaceDetectedAsync(connection, transaction, homes, trips, ct);

        await transaction.CommitAsync(ct);
    }

    /// <summary>
    /// Replaces the nights dated <paramref name="from"/> to <paramref name="to"/> by <paramref name="nights"/> (as
    /// <see cref="NightStore"/> does) and every detected home period and trip by <paramref name="homes"/> and
    /// <paramref name="trips"/>, all in one
    /// transaction. The homes and trips are worked out from the nights, so a reader must never find new nights with the old
    /// trips, which two transactions would allow for as long as it took the second to run or, after a failure between them,
    /// for good: a failure leaves all of it as it was.
    /// </summary>
    public async Task ReplaceAllAsync(
        DateOnly from, DateOnly to, IReadOnlyList<(Night Night, string Source)> nights,
        IReadOnlyList<HomePeriod> homes, IReadOnlyList<DetectedTrip> trips, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        await nightStore.ReplaceAsync(connection, transaction, from, to, nights, ct);
        await ReplaceDetectedAsync(connection, transaction, homes, trips, ct);

        await transaction.CommitAsync(ct);
    }

    private static async Task ReplaceDetectedAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction,
        IReadOnlyList<HomePeriod> homes, IReadOnlyList<DetectedTrip> trips, CancellationToken ct)
    {
        await connection.ExecuteAsync(new CommandDefinition(
            "delete from home_period where source = 'detected'; delete from trip;", transaction: transaction, cancellationToken: ct));

        if (homes.Count > 0)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "insert into home_period (place_id, from_date, to_date, source) values (@PlaceId, @From, @To, 'detected')",
                homes.Select(h => new { h.PlaceId, h.From, h.To }).ToList(),
                transaction, cancellationToken: ct));
        }

        if (trips.Count > 0)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                """
                insert into trip (id, last_night, nights, start_utc, end_utc, start_tz, end_tz, local_start_date, local_end_date)
                values (@Id, @LastNight, @Nights, @StartUtc, @EndUtc, @StartZone, @EndZone, @LocalStartDate, @LocalEndDate)
                """,
                trips.Select(t => new
                {
                    Id = t.FirstNight,
                    t.LastNight,
                    t.Nights,
                    StartUtc = AsUtc(t.StartUtc),
                    EndUtc = t.EndUtc is { } end ? AsUtc(end) : (DateTime?)null,
                    t.StartZone,
                    t.EndZone,
                    t.LocalStartDate,
                    t.LocalEndDate,
                }).ToList(),
                transaction, cancellationToken: ct));
        }
    }

    /// <summary>Npgsql writes only UTC values to timestamptz. Everything in the timeline is UTC; unspecified means UTC too.</summary>
    private static DateTime AsUtc(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
    };

    // A class with setters rather than a record: Dapper matches a record's constructor by exact column types.
    private sealed class PendingRow
    {
        public DateTime? FromUtc { get; set; }
        public DateTime? ToUtc { get; set; }
    }
}
