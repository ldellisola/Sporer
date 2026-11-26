using Dapper;
using Npgsql;
using Sporer.Api.Features.Timeline;
using Sporer.Timeline;

namespace Sporer.Api.Features.Moves;

/// <summary>A mode the owner set, over the time span of the move it was set on. Times are UTC.</summary>
public sealed record ModeEdit(DateTime FromUtc, DateTime ToUtc, TravelMode Mode);

/// <summary>
/// The modes the owner set on moves (transit spec section 5): the rows of <c>mode_edit</c>, kept by time span (segment ids change on every
/// rebuild), so that they survive every rebuild and a full one. A move whose time an edit covers more than half of has the edit's mode
/// (<see cref="Find"/>); processing puts it over the detected mode. Setting or taking back a mode asks for the move's stretch to be rebuilt at
/// once (<see cref="ProcessingQueue.EnqueueNowAsync"/>).
/// </summary>
public sealed class ModeEditStore(NpgsqlDataSource dataSource, ProcessingQueue queue)
{
    /// <summary>The edits that overlap <paramref name="fromUtc"/> to <paramref name="toUtc"/> (touching an end is not overlapping), oldest first.</summary>
    public async Task<IReadOnlyList<ModeEdit>> FindOverlappingAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<EditRow>(new CommandDefinition(
            "select from_utc as FromUtc, to_utc as ToUtc, mode as Mode from mode_edit where from_utc < @To and to_utc > @From order by from_utc, id",
            new { From = AsUtc(fromUtc), To = AsUtc(toUtc) }, cancellationToken: ct));
        var edits = new List<ModeEdit>();
        foreach (var row in rows)
        {
            if (TravelModeNames.TryParse(row.Mode, out var mode)) // the table's check allows only these
                edits.Add(new ModeEdit(AsUtc(row.FromUtc), AsUtc(row.ToUtc), mode));
        }
        return edits;
    }

    /// <summary>
    /// The owner's mode for a move from <paramref name="startUtc"/> to <paramref name="endUtc"/>: that of the edit among
    /// <paramref name="edits"/> that covers the most of its time, when that is more than half of it; null when none does.
    /// </summary>
    public static TravelMode? Find(IReadOnlyList<ModeEdit> edits, DateTime startUtc, DateTime endUtc)
    {
        var length = endUtc - startUtc;
        ModeEdit? best = null;
        var bestOverlap = TimeSpan.Zero;
        foreach (var edit in edits)
        {
            var overlap = (edit.ToUtc < endUtc ? edit.ToUtc : endUtc) - (edit.FromUtc > startUtc ? edit.FromUtc : startUtc);
            if (overlap > bestOverlap)
                (best, bestOverlap) = (edit, overlap);
        }
        return best is not null && bestOverlap * 2 > length ? best.Mode : null;
    }

    /// <summary>
    /// Sets the mode of the stored move <paramref name="moveId"/> to <paramref name="mode"/>: the edit is stored over the move's time, in
    /// place of every edit that overlapped it, the stored move takes the mode at once (and says it is the owner's), and its stretch is asked
    /// to be rebuilt at once as of <paramref name="nowUtc"/> (so that its line and distance follow a change to or from a flight, and the
    /// trains next to it are joined). One transaction. False, with nothing done, when no stored move has that id.
    /// </summary>
    public async Task<bool> SetAsync(long moveId, TravelMode mode, DateTime nowUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        if (await FindMoveAsync(connection, transaction, moveId, ct) is not { } move)
            return false;

        var span = new { From = AsUtc(move.StartUtc), To = AsUtc(move.EndUtc) };
        await connection.ExecuteAsync(new CommandDefinition(
            "delete from mode_edit where from_utc < @To and to_utc > @From", span, transaction, cancellationToken: ct));
        await connection.ExecuteAsync(new CommandDefinition(
            "insert into mode_edit (from_utc, to_utc, mode, created_at) values (@From, @To, @Mode, @Now)",
            new { span.From, span.To, Mode = TravelModeNames.Name(mode), Now = AsUtc(nowUtc) }, transaction, cancellationToken: ct));
        await connection.ExecuteAsync(new CommandDefinition(
            "update segment set mode = @Mode, mode_edited = true where id = @Id",
            new { Id = moveId, Mode = TravelModeNames.Name(mode) }, transaction, cancellationToken: ct));
        await queue.EnqueueNowAsync(connection, transaction, span.From, span.To, nowUtc, ct);

        await transaction.CommitAsync(ct);
        return true;
    }

    /// <summary>
    /// Takes back the owner's mode of the stored move <paramref name="moveId"/>: every edit that overlaps its time is deleted, and its stretch is
    /// asked to be rebuilt at once as of <paramref name="nowUtc"/>, which brings back the detected mode. The stored move is left as it is until
    /// then. One transaction. False, with nothing done, when no stored move has that id.
    /// </summary>
    public async Task<bool> ClearAsync(long moveId, DateTime nowUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        if (await FindMoveAsync(connection, transaction, moveId, ct) is not { } move)
            return false;

        await connection.ExecuteAsync(new CommandDefinition(
            "delete from mode_edit where from_utc < @To and to_utc > @From",
            new { From = AsUtc(move.StartUtc), To = AsUtc(move.EndUtc) }, transaction, cancellationToken: ct));
        await queue.EnqueueNowAsync(connection, transaction, move.StartUtc, move.EndUtc, nowUtc, ct);

        await transaction.CommitAsync(ct);
        return true;
    }

    /// <summary>The stored move <paramref name="id"/>, locked until the transaction ends (a rebuild that would replace it waits); null when there is none.</summary>
    private static Task<MoveRow?> FindMoveAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, long id, CancellationToken ct)
        => connection.QuerySingleOrDefaultAsync<MoveRow?>(new CommandDefinition(
            "select start_utc as StartUtc, end_utc as EndUtc from segment where id = @Id and kind = 'move' for update",
            new { Id = id }, transaction, cancellationToken: ct));

    private static DateTime AsUtc(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
    };

    // Classes with setters rather than records: Dapper matches a record's constructor by exact column types.
    private sealed class EditRow
    {
        public DateTime FromUtc { get; set; }
        public DateTime ToUtc { get; set; }
        public string Mode { get; set; } = string.Empty;
    }

    private sealed class MoveRow
    {
        public DateTime StartUtc { get; set; }
        public DateTime EndUtc { get; set; }
    }
}
