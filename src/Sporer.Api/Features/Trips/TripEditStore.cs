using System.Data;
using System.Globalization;
using Dapper;
using Npgsql;
using Sporer.Timeline;

namespace Sporer.Api.Features.Trips;

/// <summary>
/// The trip an edit is about, as the endpoints that edit it find it (see <see cref="TripEditStore.FindTargetAsync"/>).
/// <paramref name="Id"/> and <paramref name="LastNight"/> are the trip's nights as they are now, and <paramref name="LocalStartDate"/> and
/// <paramref name="LocalEndDate"/> its dates. <paramref name="Key"/> is what its edit is keyed by: the first night detection gave the trip
/// when it was edited (<c>detected_id</c>), or its own where it has none. <paramref name="Edit"/> is that edit, null where there is none.
/// <paramref name="Others"/> are the nights, first and last, of every other trip.
/// </summary>
public sealed record TripEditTarget(
    DateOnly Id, DateOnly LastNight, DateOnly LocalStartDate, DateOnly LocalEndDate, DateOnly Key, TripEdit? Edit,
    IReadOnlyList<(DateOnly FirstNight, DateOnly LastNight)> Others);

/// <summary>A trip the owner deleted, as the list of them gives it: the key to bring it back by, what it was called, and when it was deleted.</summary>
public sealed record DeletedTrip(DateOnly Key, string Label, DateTime DeletedAt);

/// <summary>
/// What the owner changed of the trips (<c>trip_edit</c>): a name, dates, or that a trip is gone. It is the owner's own data, so no
/// refresh and no rebuild of the timeline writes to it; <see cref="TripRefresher"/> reads it, in the transaction that writes the trips,
/// and <see cref="TripEdits"/> puts it on the trips detection found. An edit is keyed by the first night of the trip as it was detected when
/// the edit was made (<c>detected_id</c>), and the row has at most one edit of it. A row that changes nothing (no name, no dates, not
/// deleted) is not kept.
/// </summary>
public sealed class TripEditStore(NpgsqlDataSource dataSource)
{
    /// <summary>
    /// Every edit, in the caller's transaction: <see cref="TripRefresher"/> reads them there, under the lock that every write of the trips is
    /// done under, so that an edit and a refresh never interleave.
    /// </summary>
    internal static async Task<IReadOnlyList<TripEdit>> LoadAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct)
    {
        var rows = await connection.QueryAsync<EditRow>(new CommandDefinition(
            $"select {EditColumns} from trip_edit order by detected_id", transaction: transaction, cancellationToken: ct));
        return [.. rows.Select(ToEdit)];
    }

    /// <summary>
    /// The trip whose id is <paramref name="id"/> (the date of its first night) with its edit and the nights of the other trips, or null when
    /// there is no such trip. Read in one snapshot, so that the trips and the edit are those of one moment.
    /// </summary>
    public async Task<TripEditTarget?> FindTargetAsync(DateOnly id, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);

        var trip = await connection.QuerySingleOrDefaultAsync<TripRow>(new CommandDefinition(
            """
            select to_char(id, 'YYYY-MM-DD') as FirstNight, to_char(last_night, 'YYYY-MM-DD') as LastNight,
                   to_char(local_start_date, 'YYYY-MM-DD') as LocalStartDate, to_char(local_end_date, 'YYYY-MM-DD') as LocalEndDate,
                   to_char(detected_id, 'YYYY-MM-DD') as DetectedId
            from trip where id = @Id
            """,
            new { Id = id }, transaction, cancellationToken: ct));
        if (trip is null)
            return null;

        var key = trip.DetectedId is null ? id : ParseDate(trip.DetectedId);
        var edit = await connection.QuerySingleOrDefaultAsync<EditRow>(new CommandDefinition(
            $"select {EditColumns} from trip_edit where detected_id = @Key", new { Key = key }, transaction, cancellationToken: ct));
        var others = await connection.QueryAsync<TripRow>(new CommandDefinition(
            "select to_char(id, 'YYYY-MM-DD') as FirstNight, to_char(last_night, 'YYYY-MM-DD') as LastNight from trip where id <> @Id order by id",
            new { Id = id }, transaction, cancellationToken: ct));

        await transaction.CommitAsync(ct);

        return new TripEditTarget(
            id, ParseDate(trip.LastNight), ParseDate(trip.LocalStartDate!), ParseDate(trip.LocalEndDate!), key,
            edit is null ? null : ToEdit(edit),
            [.. others.Select(o => (ParseDate(o.FirstNight), ParseDate(o.LastNight)))]);
    }

    /// <summary>
    /// The id of the trip whose edit is keyed by <paramref name="key"/> (<see cref="TripEditTarget.Key"/>) as the trips are stored now, or
    /// null when no trip has it.
    /// </summary>
    public async Task<DateOnly?> FindIdByKeyAsync(DateOnly key, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var id = await connection.QuerySingleOrDefaultAsync<string>(new CommandDefinition(
            "select to_char(id, 'YYYY-MM-DD') from trip where coalesce(detected_id, id) = @Key",
            new { Key = key }, cancellationToken: ct));
        return id is null ? null : ParseDate(id);
    }

    /// <summary>
    /// Replaces the edit of the trip by <paramref name="edit"/>, which is of a trip that is not deleted: what it says is what the trip is to
    /// be (a null name or date is as detected), so it replaces what the owner said before. An edit that says nothing is the
    /// absence of one, and the row is removed. The row's <c>detected_last_night</c> is the one it had: it says what the trip was when the
    /// edit was first made, which is what an edit that has lost its first night is found by.
    /// </summary>
    public async Task SaveAsync(TripEdit edit, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        if (edit.Name is null && edit.StartDate is null && edit.EndDate is null)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "delete from trip_edit where detected_id = @DetectedId and not deleted", new { edit.DetectedId }, cancellationToken: ct));
            return;
        }

        await connection.ExecuteAsync(new CommandDefinition(
            """
            insert into trip_edit (detected_id, detected_last_night, name, start_date, end_date, updated_at)
            values (@DetectedId, @DetectedLastNight, @Name, @StartDate, @EndDate, now())
            on conflict (detected_id) do update set
                name = excluded.name, start_date = excluded.start_date, end_date = excluded.end_date, updated_at = now()
            """,
            edit, cancellationToken: ct));
    }

    /// <summary>
    /// Marks the trip keyed by <paramref name="key"/> as deleted, and records <paramref name="label"/>, what it was called, for the list of
    /// the deleted. What else the edit says (a name, dates) is kept, to be there when the trip is brought back. A trip that had no edit gets
    /// one, with <paramref name="lastNight"/> as the last night it had.
    /// </summary>
    public async Task DeleteTripAsync(DateOnly key, DateOnly lastNight, string label, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            """
            insert into trip_edit (detected_id, detected_last_night, deleted, deleted_label, updated_at)
            values (@Key, @LastNight, true, @Label, now())
            on conflict (detected_id) do update set deleted = true, deleted_label = excluded.deleted_label, updated_at = now()
            """,
            new { Key = key, LastNight = lastNight, Label = label }, cancellationToken: ct));
    }

    /// <summary>The trips the owner deleted, the one deleted last first.</summary>
    public async Task<IReadOnlyList<DeletedTrip>> ListDeletedAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<DeletedRow>(new CommandDefinition(
            """
            select to_char(detected_id, 'YYYY-MM-DD') as Key, coalesce(deleted_label, to_char(detected_id, 'YYYY-MM-DD')) as Label,
                   updated_at as DeletedAt
            from trip_edit where deleted order by updated_at desc, detected_id desc
            """,
            cancellationToken: ct));
        return [.. rows.Select(r => new DeletedTrip(ParseDate(r.Key), r.Label, DateTime.SpecifyKind(r.DeletedAt, DateTimeKind.Utc)))];
    }

    /// <summary>
    /// Brings back the deleted trip keyed by <paramref name="key"/>: false when there is none. Its name and dates are as they were; where it
    /// had none the edit is not kept.
    /// </summary>
    public async Task<bool> RestoreAsync(DateOnly key, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var restored = await connection.ExecuteScalarAsync<long>(new CommandDefinition(
            """
            with gone as (
                delete from trip_edit
                where detected_id = @Key and deleted and name is null and start_date is null and end_date is null
                returning 1
            ), kept as (
                update trip_edit set deleted = false, deleted_label = null, updated_at = now()
                where detected_id = @Key and deleted and (name is not null or start_date is not null or end_date is not null)
                returning 1
            )
            select (select count(*) from gone) + (select count(*) from kept)
            """,
            new { Key = key }, cancellationToken: ct));
        return restored > 0;
    }

    private const string EditColumns =
        """
        to_char(detected_id, 'YYYY-MM-DD') as DetectedId, to_char(detected_last_night, 'YYYY-MM-DD') as DetectedLastNight, name as Name,
        to_char(start_date, 'YYYY-MM-DD') as StartDate, to_char(end_date, 'YYYY-MM-DD') as EndDate, deleted as Deleted
        """;

    private static TripEdit ToEdit(EditRow row) => new(
        ParseDate(row.DetectedId), ParseDate(row.DetectedLastNight), row.Name,
        row.StartDate is null ? null : ParseDate(row.StartDate), row.EndDate is null ? null : ParseDate(row.EndDate), row.Deleted);

    private static DateOnly ParseDate(string text) => DateOnly.ParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture);

    // Classes with setters rather than records: Dapper matches a record's constructor by exact column types.
    private sealed class EditRow
    {
        public string DetectedId { get; set; } = string.Empty;
        public string DetectedLastNight { get; set; } = string.Empty;
        public string? Name { get; set; }
        public string? StartDate { get; set; }
        public string? EndDate { get; set; }
        public bool Deleted { get; set; }
    }

    private sealed class TripRow
    {
        public string FirstNight { get; set; } = string.Empty;
        public string LastNight { get; set; } = string.Empty;
        public string? LocalStartDate { get; set; }
        public string? LocalEndDate { get; set; }
        public string? DetectedId { get; set; }
    }

    private sealed class DeletedRow
    {
        public string Key { get; set; } = string.Empty;
        public string Label { get; set; } = string.Empty;
        public DateTime DeletedAt { get; set; }
    }
}
