using System.Globalization;
using Dapper;
using Npgsql;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;
using Sporer.Timeline;

namespace Sporer.Api.Features.Homes;

/// <summary>
/// A stored home period, as <c>GET /api/homes</c> lists it: <paramref name="PlaceId"/> and <paramref name="PlaceName"/> are the place
/// that survives merges and its name (the owner's, else OpenStreetMap's, else null), and <paramref name="Source"/> is <c>detected</c> or
/// <c>user</c>. Both ends are inclusive night dates; a null <paramref name="To"/> is open.
/// </summary>
public sealed record HomeEntry(long Id, long PlaceId, string? PlaceName, DateOnly From, DateOnly? To, string Source);

/// <summary>What <see cref="HomeStore.DeleteUserAsync"/> found: the period, and whether it could be deleted.</summary>
public enum DeleteHomeOutcome
{
    Deleted,
    NotFound,

    /// <summary>The period is one that detection found, which is worked out afresh each time and is not the owner's to delete.</summary>
    Detected,
}

/// <summary>
/// The home periods (<c>home_period</c>): the ones the owner sets (<c>user</c>), which nothing derived ever writes (the refresh rewrites
/// only <c>detected</c> ones, in <see cref="TripStore"/>), and the list of all of them. The owner's periods never share a date:
/// <see cref="AddUserAsync"/> refuses one that would. A detected period is overlapped freely, because where they overlap the owner's wins
/// (<see cref="HomeOverrides"/>).
/// </summary>
public sealed class HomeStore(NpgsqlDataSource dataSource)
{
    /// <summary>
    /// The owner's home periods, earliest first, in the caller's transaction: <see cref="TripRefresher"/> reads them there, under the lock that
    /// every write of the homes and trips is done under. A period names the place the owner gave it, which may have been merged into another
    /// since: the caller resolves it.
    /// </summary>
    internal static async Task<IReadOnlyList<HomePeriod>> LoadUserAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct)
    {
        var rows = await connection.QueryAsync<PeriodRow>(new CommandDefinition(
            """
            select place_id as PlaceId, to_char(from_date, 'YYYY-MM-DD') as FromDate, to_char(to_date, 'YYYY-MM-DD') as ToDate
            from home_period where source = 'user' order by from_date, id
            """,
            transaction: transaction, cancellationToken: ct));
        return [.. rows.Select(r => new HomePeriod(r.PlaceId, ParseDate(r.FromDate), r.ToDate is null ? null : ParseDate(r.ToDate)))];
    }

    /// <summary>
    /// Every stored home period, detected and the owner's, in date order, each with the place that survives merges and its name: what is
    /// stored, and not the homes in effect (a detected period is listed whole, however much of it an owner's period covers). A period
    /// whose place's merges never end (a cycle, which the app does not write but the schema allows) is listed at the place it names, with
    /// no name.
    /// </summary>
    public async Task<IReadOnlyList<HomeEntry>> ListAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<EntryRow>(new CommandDefinition(
            $"""
            with recursive
            named as (
                select place_id from home_period
            ),
            {PlaceStore.Survivors}
            select h.id as Id, coalesce(survivor.id, h.place_id) as PlaceId, coalesce(p.user_name, p.osm_name) as PlaceName,
                   to_char(h.from_date, 'YYYY-MM-DD') as FromDate, to_char(h.to_date, 'YYYY-MM-DD') as ToDate, h.source as Source
            from home_period h
            left join survivor on survivor.origin = h.place_id
            left join place p on p.id = survivor.id
            order by h.from_date, h.id
            """,
            cancellationToken: ct));

        return [.. rows.Select(r => new HomeEntry(r.Id, r.PlaceId, r.PlaceName, ParseDate(r.FromDate), r.ToDate is null ? null : ParseDate(r.ToDate), r.Source))];
    }

    /// <summary>
    /// Stores the owner's home period at <paramref name="placeId"/> (the place that survives merges, which the caller has found) from
    /// <paramref name="from"/> to <paramref name="to"/>, both inclusive, null for one that goes on. Returns its id, or null, with nothing
    /// stored, when it would share a date with another period of the owner's. The check and the insert are in one transaction that holds the
    /// lock that homes are written under (<see cref="TripRefresher.AdvisoryLockKey"/>), so that two at once cannot both find the dates free,
    /// and a refresh never reads half of it.
    /// </summary>
    public async Task<long?> AddUserAsync(long placeId, DateOnly from, DateOnly? to, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        await TripRefresher.LockAsync(connection, transaction, ct);

        var overlaps = await connection.ExecuteScalarAsync<bool>(new CommandDefinition(
            """
            select exists (
                select 1 from home_period
                where source = 'user'
                  and from_date <= coalesce(@To::date, 'infinity'::date)
                  and coalesce(to_date, 'infinity'::date) >= @From::date)
            """,
            new { From = from, To = to }, transaction, cancellationToken: ct));
        if (overlaps)
            return null;

        var id = await connection.ExecuteScalarAsync<long>(new CommandDefinition(
            "insert into home_period (place_id, from_date, to_date, source) values (@PlaceId, @From, @To, 'user') returning id",
            new { PlaceId = placeId, From = from, To = to }, transaction, cancellationToken: ct));

        await transaction.CommitAsync(ct);
        return id;
    }

    /// <summary>
    /// Deletes the owner's home period <paramref name="id"/>. A detected period is not deleted (it would be found again by the next refresh), and
    /// no period of that id is not found. Under the same lock as <see cref="AddUserAsync"/>.
    /// </summary>
    public async Task<DeleteHomeOutcome> DeleteUserAsync(long id, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        await TripRefresher.LockAsync(connection, transaction, ct);

        var source = await connection.ExecuteScalarAsync<string?>(new CommandDefinition(
            "select source from home_period where id = @Id", new { Id = id }, transaction, cancellationToken: ct));
        if (source is null)
            return DeleteHomeOutcome.NotFound;
        if (source != "user")
            return DeleteHomeOutcome.Detected;

        await connection.ExecuteAsync(new CommandDefinition(
            "delete from home_period where id = @Id", new { Id = id }, transaction, cancellationToken: ct));

        await transaction.CommitAsync(ct);
        return DeleteHomeOutcome.Deleted;
    }

    private static DateOnly ParseDate(string text) => DateOnly.ParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture);

    // Classes with setters rather than records: Dapper matches a record's constructor by exact column types.
    private sealed class PeriodRow
    {
        public long PlaceId { get; set; }
        public string FromDate { get; set; } = string.Empty;
        public string? ToDate { get; set; }
    }

    private sealed class EntryRow
    {
        public long Id { get; set; }
        public long PlaceId { get; set; }
        public string? PlaceName { get; set; }
        public string FromDate { get; set; } = string.Empty;
        public string? ToDate { get; set; }
        public string Source { get; set; } = string.Empty;
    }
}
