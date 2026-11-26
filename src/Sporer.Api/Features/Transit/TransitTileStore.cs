using Dapper;
using Npgsql;
using NpgsqlTypes;
using Sporer.Api.Features.Timeline;
using Sporer.Timeline;

namespace Sporer.Api.Features.Transit;

/// <summary>A tile that is waiting to be fetched and due, and how many times fetching it has failed so far.</summary>
public sealed record DueTile(TransitTile Tile, int Attempts);

/// <summary>A tile a rebuild needed and did not have, and the time span of the moves that asked for it.</summary>
public sealed record NeededTile(TransitTile Tile, DateTime FromUtc, DateTime ToUtc);

/// <summary>How many tiles are cached (fetched), waiting to be fetched, and set aside after failing too often.</summary>
public sealed record TransitTileCounts(long Cached, long Waiting, long Failed);

/// <summary>
/// The railway and bus-route lines kept in <c>transit_tile</c> (transit spec section 3). Processing reads only what is cached here, never the
/// network (<see cref="LoadAsync"/>), and records the tiles it needed and did not have (<see cref="RecordNeededAsync"/>); the
/// <see cref="TransitFetcher"/> fetches those (<see cref="FindDueAsync"/>) and stores them (<see cref="SaveFetchedAsync"/>), which adds the
/// stretch of the moves that waited for them to what the worker is to rebuild for the tiles that arrived (see
/// <see cref="ProcessingQueue.FlushTransitReadyAsync"/>). The parsed lines of the tiles used last are kept in memory (at most
/// <see cref="MemoryTiles"/>), by the time they were fetched, so that a tile deleted or fetched again in the database is never served stale.
/// </summary>
public sealed class TransitTileStore(NpgsqlDataSource dataSource, ProcessingQueue queue, ILogger<TransitTileStore> logger)
{
    /// <summary>How many tiles' parsed lines are kept in memory between rebuilds. A dense city tile is one or two megabytes.</summary>
    public const int MemoryTiles = 64;

    private readonly TileMemory _memory = new(MemoryTiles);

    /// <summary>
    /// The lines of those of <paramref name="tiles"/> that are cached (fetched; a tile with no line is cached and empty). A tile that is not
    /// cached is not in the answer. A cached tile whose stored lines are missing or cannot be read (they were changed by hand, or a restore
    /// left them out) is made to wait to be fetched again, and is not in the answer: left done, it would be neither cached nor waiting, and
    /// every rebuild of the moves that need it would ask for them to be rebuilt again at once (see <see cref="RecordNeededAsync"/>).
    /// </summary>
    public async Task<IReadOnlyDictionary<TransitTile, TransitLines>> LoadAsync(IEnumerable<TransitTile> tiles, CancellationToken ct = default)
    {
        var wanted = tiles.Distinct().Order().ToList();
        var found = new Dictionary<TransitTile, TransitLines>();
        if (wanted.Count == 0)
            return found;

        // What memory holds is sent along with when it was fetched: the database sends the lines only of a tile that memory does not have
        // as it is now. A snapshot, so that what memory drops in the meantime is still at hand.
        var known = wanted.Select(t => _memory.TryGet(t, out var entry) ? entry : null).ToList();
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var rows = await connection.QueryAsync<LoadRow>(new CommandDefinition(
            """
            select t.kind as Kind, t.lat_index as LatIndex, t.lon_index as LonIndex, t.fetched_at as FetchedAt,
                   case when t.fetched_at = u.known then null else t.lines end as Lines
            from unnest(@Kinds, @Lats, @Lons, @Known) as u(kind, lat_index, lon_index, known)
            join transit_tile t on t.kind = u.kind and t.lat_index = u.lat_index and t.lon_index = u.lon_index
            where t.state = 'done'
            """,
            new
            {
                Kinds = wanted.Select(t => KindName(t.Kind)).ToArray(),
                Lats = wanted.Select(t => t.LatIndex).ToArray(),
                Lons = wanted.Select(t => t.LonIndex).ToArray(),
                Known = new KnownTimes(known.Select(k => k?.FetchedAt).ToArray()),
            },
            cancellationToken: ct));

        var index = wanted.Select((tile, at) => (tile, at)).ToDictionary(x => x.tile, x => x.at);
        foreach (var row in rows)
        {
            var tile = new TransitTile(ParseKind(row.Kind), row.LatIndex, row.LonIndex);
            var fetchedAt = row.FetchedAt is { } at ? AsUtc(at) : (DateTime?)null;
            if (row.Lines is null)
            {
                // Not sent: memory holds them as they are now. Or there are none to send.
                if (known[index[tile]] is { } held && held.FetchedAt == fetchedAt)
                {
                    found[tile] = held.Lines;
                }
                else
                {
                    logger.LogWarning("Transit tile {Tile} is fetched but has no stored lines; it will be fetched again", tile);
                    await ResetWithoutLinesAsync(connection, tile, ct);
                }
                continue;
            }

            TransitLines lines;
            try
            {
                lines = new TransitLines(TransitLineBlob.Decode(row.Lines));
            }
            catch (FormatException ex)
            {
                logger.LogWarning(ex, "The stored lines of transit tile {Tile} cannot be read; it will be fetched again", tile);
                await ResetUnreadableAsync(connection, tile, fetchedAt, ct);
                continue;
            }

            if (fetchedAt is { } fetched) // a tile that does not say when it was fetched cannot be checked against memory, so is not kept there
                _memory.Set(tile, new HeldTile(fetched, lines));
            found[tile] = lines;
        }
        return found;
    }

    /// <summary>
    /// Records that the moves of a rebuild needed <paramref name="needed"/> and did not have them: each tile is waiting to be fetched, for the
    /// time span of the moves that asked for it, widened to take in what it was waiting for already. A tile that is fetched already is never
    /// made to wait again; if it was fetched after the rebuild read the cache (the fetcher got there in between), the moves' stretch is asked
    /// to be rebuilt at once, as of <paramref name="nowUtc"/>, so that it is not missed. One transaction.
    /// </summary>
    public async Task RecordNeededAsync(IReadOnlyCollection<NeededTile> needed, DateTime nowUtc, CancellationToken ct = default)
    {
        if (needed.Count == 0)
            return;

        var spans = needed
            .GroupBy(n => n.Tile)
            .Select(g => new NeededTile(g.Key, AsUtc(g.Min(n => n.FromUtc)), AsUtc(g.Max(n => n.ToUtc))))
            .OrderBy(n => n.Tile) // always in the same order, so that two writers cannot wait on each other
            .ToList();

        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);
        var waiting = (await connection.QueryAsync<KeyRow>(new CommandDefinition(
            """
            insert into transit_tile (kind, lat_index, lon_index, waiting_from, waiting_to)
            select * from unnest(@Kinds, @Lats, @Lons, @Froms, @Tos)
            on conflict (kind, lat_index, lon_index) do update
              set waiting_from = least(transit_tile.waiting_from, excluded.waiting_from),
                  waiting_to = greatest(transit_tile.waiting_to, excluded.waiting_to)
              where transit_tile.state <> 'done'
            returning kind as Kind, lat_index as LatIndex, lon_index as LonIndex
            """,
            new
            {
                Kinds = spans.Select(s => KindName(s.Tile.Kind)).ToArray(),
                Lats = spans.Select(s => s.Tile.LatIndex).ToArray(),
                Lons = spans.Select(s => s.Tile.LonIndex).ToArray(),
                Froms = spans.Select(s => s.FromUtc).ToArray(),
                Tos = spans.Select(s => s.ToUtc).ToArray(),
            },
            transaction, cancellationToken: ct)))
            .Select(r => new TransitTile(ParseKind(r.Kind), r.LatIndex, r.LonIndex))
            .ToHashSet();

        // What was not written is done: it arrived after the rebuild looked.
        foreach (var (from, to) in spans.Where(s => !waiting.Contains(s.Tile)).Select(s => (s.FromUtc, s.ToUtc)).Distinct())
        {
            logger.LogInformation("A transit tile arrived while {FromUtc:o} to {ToUtc:o} was rebuilt; rebuilding it again", from, to);
            await queue.EnqueueNowAsync(connection, transaction, from, to, nowUtc, ct);
        }

        await transaction.CommitAsync(ct);
    }

    /// <summary>
    /// The tile to fetch next at <paramref name="nowUtc"/>: of those waiting (or set aside) whose next attempt is due, the one wanted by the
    /// most recent travels (the latest end of the moves waiting for it), railways before bus routes. Null when none is due.
    /// </summary>
    public async Task<DueTile?> FindDueAsync(DateTime nowUtc, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var row = await connection.QueryFirstOrDefaultAsync<DueRow>(new CommandDefinition(
            """
            select kind as Kind, lat_index as LatIndex, lon_index as LonIndex, attempts as Attempts
            from transit_tile
            where state in ('pending', 'failed') and (next_attempt_at is null or next_attempt_at <= @Now)
            order by waiting_to desc nulls last, case kind when 'rail' then 0 else 1 end, lat_index, lon_index
            limit 1
            """,
            new { Now = AsUtc(nowUtc) }, cancellationToken: ct));
        return row is null ? null : new DueTile(new TransitTile(ParseKind(row.Kind), row.LatIndex, row.LonIndex), row.Attempts);
    }

    /// <summary>
    /// Stores the fetched <paramref name="lines"/> of <paramref name="tile"/> (none, for a tile that has none), marks it done, and adds the
    /// stretch of the moves that were waiting for it to the stretch the worker is to rebuild for the tiles that arrived, as of
    /// <paramref name="nowUtc"/> (see <see cref="ProcessingQueue.AddTransitReadyAsync"/>: it is asked for with the tiles that arrive soon
    /// after, not on its own); all in one transaction. Returns that stretch, or null when nothing was waiting.
    /// </summary>
    public async Task<(DateTime FromUtc, DateTime ToUtc)?> SaveFetchedAsync(
        TransitTile tile, IEnumerable<IReadOnlyList<GeoPoint>> lines, DateTime nowUtc, CancellationToken ct = default)
    {
        var blob = TransitLineBlob.Encode(lines);
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        // Locked, so that a rebuild that widens the span in the meantime either comes first (and its widening is in what is read here) or
        // after (and finds the tile done, see RecordNeededAsync).
        var span = await connection.QuerySingleOrDefaultAsync<SpanRow>(new CommandDefinition(
            """
            select waiting_from as FromUtc, waiting_to as ToUtc from transit_tile
            where kind = @Kind and lat_index = @LatIndex and lon_index = @LonIndex
            for update
            """,
            Key(tile), transaction, cancellationToken: ct));

        await connection.ExecuteAsync(new CommandDefinition(
            """
            insert into transit_tile (kind, lat_index, lon_index, state, lines, line_count, attempts, next_attempt_at, last_error, fetched_at,
                                      waiting_from, waiting_to)
            values (@Kind, @LatIndex, @LonIndex, 'done', @Lines, @LineCount, 0, null, null, @FetchedAt, null, null)
            on conflict (kind, lat_index, lon_index) do update set
                state = 'done', lines = excluded.lines, line_count = excluded.line_count, attempts = 0, next_attempt_at = null,
                last_error = null, fetched_at = excluded.fetched_at, waiting_from = null, waiting_to = null
            """,
            new
            {
                Kind = KindName(tile.Kind), tile.LatIndex, tile.LonIndex, Lines = blob, LineCount = TransitLineBlob.CountLines(blob),
                FetchedAt = AsUtc(nowUtc),
            },
            transaction, cancellationToken: ct));

        (DateTime, DateTime)? rebuilt = null;
        if (span is { FromUtc: { } from, ToUtc: { } to })
        {
            rebuilt = (AsUtc(from), AsUtc(to));
            await queue.AddTransitReadyAsync(connection, transaction, from, to, nowUtc, ct);
        }

        await transaction.CommitAsync(ct);
        return rebuilt;
    }

    /// <summary>
    /// Records a failed fetch of <paramref name="tile"/>: its attempts, why, when it is due again, and whether it is set aside
    /// (<c>failed</c>) or still waiting (<c>pending</c>). The stretch waiting for it stays.
    /// </summary>
    public async Task SaveFailureAsync(TransitTile tile, int attempts, bool setAside, DateTime retryAtUtc, string error, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await connection.ExecuteAsync(new CommandDefinition(
            """
            update transit_tile
            set state = @State, attempts = @Attempts, next_attempt_at = @RetryAt, last_error = @Error
            where kind = @Kind and lat_index = @LatIndex and lon_index = @LonIndex and state <> 'done'
            """,
            new
            {
                Kind = KindName(tile.Kind), tile.LatIndex, tile.LonIndex, State = setAside ? "failed" : "pending", Attempts = attempts,
                RetryAt = AsUtc(retryAtUtc), Error = error,
            },
            cancellationToken: ct));
    }

    /// <summary>How many tiles are cached, waiting, and set aside. Reads only.</summary>
    public async Task<TransitTileCounts> CountAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        var row = await connection.QuerySingleAsync<CountRow>(new CommandDefinition(
            """
            select count(*) filter (where state = 'done') as Cached,
                   count(*) filter (where state = 'pending') as Waiting,
                   count(*) filter (where state = 'failed') as Failed
            from transit_tile
            """,
            cancellationToken: ct));
        return new TransitTileCounts(row.Cached, row.Waiting, row.Failed);
    }

    /// <summary>
    /// A done tile whose lines cannot be read waits to be fetched again, from scratch. Only if it is still the row that was read (fetched at
    /// <paramref name="fetchedAt"/>, or with no time, as it was): one that was fetched again in the meantime is left alone.
    /// </summary>
    private static Task ResetUnreadableAsync(NpgsqlConnection connection, TransitTile tile, DateTime? fetchedAt, CancellationToken ct)
        => connection.ExecuteAsync(new CommandDefinition(
            """
            update transit_tile
            set state = 'pending', lines = null, line_count = 0, attempts = 0, next_attempt_at = null, last_error = null, fetched_at = null
            where kind = @Kind and lat_index = @LatIndex and lon_index = @LonIndex and state = 'done' and fetched_at is not distinct from @FetchedAt
            """,
            new { Kind = KindName(tile.Kind), tile.LatIndex, tile.LonIndex, FetchedAt = fetchedAt }, cancellationToken: ct));

    /// <summary>
    /// A done tile with no stored lines waits to be fetched again, from scratch. Only while it still has none: one that was fetched again or
    /// mended in the meantime is left alone. (Not by when it was fetched, as <see cref="ResetUnreadableAsync"/> does: a row whose lines were
    /// lost may have lost that too.)
    /// </summary>
    private static Task ResetWithoutLinesAsync(NpgsqlConnection connection, TransitTile tile, CancellationToken ct)
        => connection.ExecuteAsync(new CommandDefinition(
            """
            update transit_tile
            set state = 'pending', lines = null, line_count = 0, attempts = 0, next_attempt_at = null, last_error = null, fetched_at = null
            where kind = @Kind and lat_index = @LatIndex and lon_index = @LonIndex and state = 'done' and lines is null
            """,
            Key(tile), cancellationToken: ct));

    /// <summary><c>rail</c> or <c>bus</c>, as <c>transit_tile.kind</c> holds it.</summary>
    public static string KindName(TransitKind kind) => kind switch
    {
        TransitKind.Rail => "rail",
        TransitKind.Bus => "bus",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown kind of tile."),
    };

    private static TransitKind ParseKind(string name) => name switch
    {
        "rail" => TransitKind.Rail,
        "bus" => TransitKind.Bus,
        _ => throw new InvalidOperationException($"transit_tile has the unknown kind '{name}'."),
    };

    private static object Key(TransitTile tile) => new { Kind = KindName(tile.Kind), tile.LatIndex, tile.LonIndex };

    private static DateTime AsUtc(DateTime value) => value.Kind switch
    {
        DateTimeKind.Utc => value,
        DateTimeKind.Local => value.ToUniversalTime(),
        _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
    };

    /// <summary>A nullable timestamptz array for Dapper, which has no type for one of its own.</summary>
    private sealed class KnownTimes(DateTime?[] values) : SqlMapper.ICustomQueryParameter
    {
        public void AddParameter(System.Data.IDbCommand command, string name)
            => ((NpgsqlCommand)command).Parameters.Add(new NpgsqlParameter(name, NpgsqlDbType.Array | NpgsqlDbType.TimestampTz)
            {
                Value = values.Select(v => v is { } t ? (object)AsUtc(t) : DBNull.Value).ToArray(),
            });
    }

    /// <summary>The parsed lines of a tile, and when the copy they were read from was fetched.</summary>
    private sealed record HeldTile(DateTime FetchedAt, TransitLines Lines);

    /// <summary>The tiles used last, at most a given number of them (the one used longest ago goes first). Safe to share between threads.</summary>
    private sealed class TileMemory(int capacity)
    {
        private readonly Dictionary<TransitTile, LinkedListNode<(TransitTile Tile, HeldTile Held)>> _nodes = [];
        private readonly LinkedList<(TransitTile Tile, HeldTile Held)> _order = new();
        private readonly Lock _lock = new();

        public bool TryGet(TransitTile tile, out HeldTile? held)
        {
            lock (_lock)
            {
                if (_nodes.TryGetValue(tile, out var node))
                {
                    _order.Remove(node);
                    _order.AddFirst(node);
                    held = node.Value.Held;
                    return true;
                }
            }
            held = null;
            return false;
        }

        public void Set(TransitTile tile, HeldTile held)
        {
            lock (_lock)
            {
                if (_nodes.Remove(tile, out var old))
                    _order.Remove(old);
                _nodes[tile] = _order.AddFirst((tile, held));
                while (_nodes.Count > capacity && _order.Last is { } last)
                {
                    _order.RemoveLast();
                    _nodes.Remove(last.Value.Tile);
                }
            }
        }
    }

    // Classes with setters rather than records: Dapper matches a record's constructor by exact column types.
    private sealed class LoadRow
    {
        public string Kind { get; set; } = string.Empty;
        public int LatIndex { get; set; }
        public int LonIndex { get; set; }
        public DateTime? FetchedAt { get; set; }
        public byte[]? Lines { get; set; }
    }

    private sealed class KeyRow
    {
        public string Kind { get; set; } = string.Empty;
        public int LatIndex { get; set; }
        public int LonIndex { get; set; }
    }

    private sealed class DueRow
    {
        public string Kind { get; set; } = string.Empty;
        public int LatIndex { get; set; }
        public int LonIndex { get; set; }
        public int Attempts { get; set; }
    }

    private sealed class SpanRow
    {
        public DateTime? FromUtc { get; set; }
        public DateTime? ToUtc { get; set; }
    }

    private sealed class CountRow
    {
        public long Cached { get; set; }
        public long Waiting { get; set; }
        public long Failed { get; set; }
    }
}
