using Dapper;
using Npgsql;
using Sporer.Api.Features.Homes;
using Sporer.Api.Features.Settings;
using Sporer.Api.Features.Timeline;
using Sporer.Timeline;

namespace Sporer.Api.Features.Trips;

/// <summary>Brings the nights, the home periods and the trips up to date after the timeline was rebuilt, or the places were changed.</summary>
public interface ITripRefresher
{
    /// <summary>
    /// Refreshes after the timeline between <paramref name="fromUtc"/> and <paramref name="toUtc"/> was rebuilt. The window
    /// says which nights to build again; the homes and the trips are always worked out afresh from every night, and the owner's
    /// edits of the trips (<see cref="TripEditStore"/>) are put on the trips found.
    /// </summary>
    Task RefreshAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct);

    /// <summary>
    /// Works out the homes and the trips afresh from the nights as they are stored, and builds no night: it is for a change that
    /// moves the homes and trips but not the nights (places merged or separated, which the nights keep as they were and are read
    /// through) or the owner's edits of the trips (renamed, re-dated, deleted or brought back). It holds the same lock as
    /// <see cref="RefreshAsync"/>, so the two never interleave their reads and writes.
    /// </summary>
    Task RecomputeAsync(CancellationToken ct);
}

/// <summary>
/// The one path from the stored timeline to the nights, homes and trips: it builds the nights of the window that changed,
/// then works out the home periods from all of them, and the trips from those and the homes the owner set, and puts the owner's
/// edits of the trips on the ones it finds. Whether a place is home depends on 90 nights, and a trip
/// on the nights on both sides of it, so a change in one window can move either of them anywhere in the history. They are
/// therefore not patched but recomputed in memory (a few thousand nights and the stays), and the new nights, homes and trips
/// are written together in one transaction.
/// </summary>
/// <remarks>
/// <para>
/// What is written is worked out from what is stored, and two that work it out at once, each from what the other has yet to
/// write, would leave the one that writes last with homes and trips that are not those of the nights it leaves. So the whole of it,
/// every read and the write, is done under one lock: <c>pg_advisory_xact_lock(<see cref="AdvisoryLockKey"/>)</c>, taken first in the
/// transaction that writes, and held until it commits or is rolled back. The reads go through the other stores, on connections
/// of their own, which is no matter: they read what is committed, and everything that writes the nights, the homes and the trips
/// holds the lock to do it, so what they read cannot change under them. The worker's refresh and the recompute of an edit
/// are serialized, in whichever order they get the lock, and each works from what the other left.
/// </para>
/// <para>
/// What does not hold the lock is what changes the places and reprocesses segments (a merge, the segmenter's rebuild of a window):
/// a read that lands in the middle of one is of the one state or of the other, and whatever changed asks for a refresh or a
/// recompute of its own afterwards, which waits for the lock and works from what is there then. The restart of a backfill
/// (<c>ProcessingQueue.RestartBackfillAsync</c>) deletes the segments, nights, homes and trips, and does hold it (P4-R11).
/// </para>
/// </remarks>
public sealed class TripRefresher(
    NpgsqlDataSource dataSource,
    NightBuilder builder,
    NightStore nights,
    SegmentStore segments,
    PlaceStore places,
    TripStore trips,
    DetectionOptions options) : ITripRefresher
{
    /// <summary>
    /// The key of the advisory lock that serializes <see cref="RefreshAsync"/> and <see cref="RecomputeAsync"/> (and whatever else
    /// works out the homes and trips): the bytes of "SPORTRIP". An arbitrary number, the one this lock has in the database.
    /// </summary>
    internal const long AdvisoryLockKey = 0x5350_4F52_5452_4950;

    /// <summary>
    /// Takes the lock <see cref="AdvisoryLockKey"/> names, which is held until the transaction ends: whatever writes the nights, homes or trips
    /// does it first in its transaction, so that it is the only one to read and write them (P4-R11).
    /// </summary>
    internal static Task LockAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct)
        => connection.ExecuteAsync(new CommandDefinition(
            "select pg_advisory_xact_lock(@Key)", new { Key = AdvisoryLockKey }, transaction, cancellationToken: ct));

    public Task RefreshAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct) => RunAsync((fromUtc, toUtc), ct);

    public Task RecomputeAsync(CancellationToken ct) => RunAsync(null, ct);

    /// <summary>
    /// With a <paramref name="window"/>, the nights of it are built afresh and written with the homes and trips; without, the nights
    /// are those that are stored, all of them as they are, and only the homes and trips are written.
    /// </summary>
    private async Task RunAsync((DateTime From, DateTime To)? window, CancellationToken ct)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        await using var transaction = await connection.BeginTransactionAsync(ct);

        // First, before anything is read for what is written below: whoever has it is the only one to read and write the derived tables.
        await LockAsync(connection, transaction, ct);

        // The nights of the window are built afresh. They are not stored yet: the nights, the homes and the trips are written
        // together at the end, so that the trips a reader finds always belong to the nights it finds.
        var (from, to, built) = window is { } rebuilt
            ? await builder.BuildAsync(rebuilt.From, rebuilt.To, ct)
            : (default, default, []);

        // Every stored night outside the window, and the built ones in it: the dates the builder left out have none now. (Without a
        // window, every stored night as it is.)
        var survivors = await places.LoadSurvivorsAsync(ct);
        var stored = await nights.LoadAllAsync(ct);
        var all = (window is null ? stored : stored.Where(n => n.Date < from || n.Date > to).Concat(built.Select(b => b.Night)))
            .OrderBy(n => n.Date)
            // A night keeps the place its stay had, which may have been merged into another since: the home is the survivor.
            .Select(n => n.PlaceId is { } id && survivors.TryGetValue(id, out var survivor) ? n with { PlaceId = survivor } : n)
            .ToList();

        // What the owner set, read here, in the transaction that holds the lock, as the edits of the trips are: the homes they gave, and the
        // distance that makes a night away. A home names the place the owner chose, which may have been merged into another since.
        var userHomes = (await HomeStore.LoadUserAsync(connection, transaction, ct))
            .Select(h => survivors.TryGetValue(h.PlaceId, out var survivor) ? h with { PlaceId = survivor } : h)
            .ToList();
        var tripDistance = await SettingsStore.LoadTripMinDistanceKmAsync(connection, transaction, ct);

        // The position of every place the nights are at, read once: home detection groups the places that are near each other, and trip
        // detection measures the nights from the homes' positions, which are among them (a home is a place of the nights). The places of the
        // homes the owner set are read too: they need not be places that any night was at.
        var positions = await places.LoadPositionsAsync(
            all.Where(n => n.PlaceId is not null).Select(n => n.PlaceId!.Value).Concat(userHomes.Select(h => h.PlaceId)), ct);

        // The homes detection found are what is stored of them, and what the owner set is put over them only to measure the nights from. The
        // distance is the owner's if they set one (it is no part of the algorithm's version: see AlgorithmVersion), else the configured one.
        var homes = HomeDetector.Detect(all, positions, options);
        var tripOptions = tripDistance is { } kilometers ? options with { TripMinDistanceKm = kilometers } : options;
        var detected = TripDetector.Detect(
            all, HomeOverrides.Apply(homes, userHomes), positions, await segments.LoadStayPositionsAsync(ct), tripOptions);

        // The owner's edits of the trips, read here, in the transaction that holds the lock, so that an edit and a refresh never interleave:
        // what is written is made from the edits as they are once this has the lock. Detection is worked out afresh each time, and the edits
        // are put on what it finds, so that they hold across refreshes and rebuilds of the timeline.
        var edits = await TripEditStore.LoadAsync(connection, transaction, ct);
        var edited = TripEdits.Apply(detected, edits, TripEdits.ZoneOfNearestNight(all));

        if (window is null)
            await TripStore.ReplaceDetectedAsync(connection, transaction, homes, edited, ct);
        else
            await trips.ReplaceAllAsync(connection, transaction, from, to, built, homes, edited, ct);

        await transaction.CommitAsync(ct);
    }
}
