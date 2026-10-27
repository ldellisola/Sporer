using Dapper;
using Npgsql;
using Sporer.Api.Features.Timeline;
using Sporer.Timeline;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// Reads and rewrites <c>night</c>: where the person slept each night, derived from the timeline. A row says how it was
/// located (<c>stay</c>, <c>point</c>, or <c>none</c> for an unknown night with no position).
/// </summary>
public sealed class NightStore(NpgsqlDataSource dataSource)
{
    /// <summary>
    /// Replaces the nights dated <paramref name="from"/> to <paramref name="to"/> (both included) by
    /// <paramref name="nights"/>, which is the shape <see cref="NightBuilder.BuildAsync"/> returns and must lie within that
    /// range. Every date of the range is deleted first, so one the builder left out (a night that has not happened, or has no
    /// time zone to be read in) loses its stored row. One transaction: readers see the old rows or the new ones, and a failure
    /// leaves the old ones.
    /// </summary>
    public async Task ReplaceAsync(
        DateOnly from, DateOnly to, IReadOnlyList<(Night Night, string Source)> nights, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        await connection.ExecuteAsync(new CommandDefinition(
            "delete from night where date >= @From and date <= @To",
            new { From = from, To = to }, transaction, cancellationToken: ct));

        if (nights.Count > 0)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                """
                insert into night (date, instant_utc, zone, source, place_id, latitude, longitude)
                values (@Date, @InstantUtc, @Zone, @Source, @PlaceId, @Latitude, @Longitude)
                """,
                nights.Select(n => new
                {
                    n.Night.Date,
                    InstantUtc = AsUtc(n.Night.InstantUtc),
                    n.Night.Zone,
                    n.Source,
                    n.Night.PlaceId,
                    Latitude = n.Night.Position?.Latitude,
                    Longitude = n.Night.Position?.Longitude,
                }).ToList(),
                transaction, cancellationToken: ct));
        }

        await transaction.CommitAsync(ct);
    }

    /// <summary>
    /// Every night, in date order. The place ids are as they were stored, which may be those of places merged into another
    /// since (see <see cref="PlaceStore.LoadSurvivorsAsync"/>).
    /// </summary>
    public async Task<IReadOnlyList<Night>> LoadAllAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<NightRow>(new CommandDefinition(
            """
            select to_char(date, 'YYYY-MM-DD') as Date, instant_utc as InstantUtc, zone as Zone, place_id as PlaceId,
                   latitude as Latitude, longitude as Longitude
            from night
            order by date
            """,
            cancellationToken: ct));

        return rows.Select(r => new Night(
            DateOnly.ParseExact(r.Date, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
            AsUtc(r.InstantUtc),
            r.Zone,
            r.PlaceId,
            r.Latitude is { } latitude && r.Longitude is { } longitude ? new GeoPoint(latitude, longitude) : null)).ToList();
    }

    /// <summary>Npgsql writes only UTC values to timestamptz. Everything in the timeline is UTC; unspecified means UTC too.</summary>
    private static DateTime AsUtc(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
    };

    // A class with setters rather than a record: Dapper matches a record's constructor by exact column types.
    private sealed class NightRow
    {
        public string Date { get; set; } = string.Empty;
        public DateTime InstantUtc { get; set; }
        public string Zone { get; set; } = string.Empty;
        public long? PlaceId { get; set; }
        public double? Latitude { get; set; }
        public double? Longitude { get; set; }
    }
}
