using Dapper;
using Npgsql;

namespace Sporer.Api.Features.Settings;

/// <summary>
/// The owner's settings (<c>app_setting</c>: a key and a JSON value each). Nothing derived writes them, and the rebuild of the timeline keeps them.
/// The only one so far is the distance from home that makes a night away (<see cref="TripMinDistanceKmKey"/>): a number, or no row, which is
/// the distance that is configured. It is no part of <see cref="Sporer.Api.Features.Timeline.AlgorithmVersion"/>, so that changing it works the
/// trips out again (<see cref="Sporer.Api.Features.Trips.ITripRefresher.RecomputeAsync"/>) and rebuilds nothing.
/// </summary>
public sealed class SettingsStore(NpgsqlDataSource dataSource)
{
    /// <summary>The key of the distance, in kilometres, that a night must be from home to be away.</summary>
    public const string TripMinDistanceKmKey = "tripMinDistanceKm";

    /// <summary>The least distance that can be set.</summary>
    public const double MinTripDistanceKm = 5;

    /// <summary>The greatest distance that can be set.</summary>
    public const double MaxTripDistanceKm = 1000;

    /// <summary>The setting in the caller's transaction, which is where <see cref="Sporer.Api.Features.Trips.TripRefresher"/> reads it: null for none.</summary>
    internal static async Task<double?> LoadTripMinDistanceKmAsync(NpgsqlConnection connection, NpgsqlTransaction? transaction, CancellationToken ct)
        => await connection.ExecuteScalarAsync<double?>(new CommandDefinition(Select, new { Key = TripMinDistanceKmKey }, transaction, cancellationToken: ct));

    /// <summary>The distance the owner set, or null when there is none (or what is stored is not a number, which is no setting).</summary>
    public async Task<double?> GetTripMinDistanceKmAsync(CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        return await LoadTripMinDistanceKmAsync(connection, null, ct);
    }

    /// <summary>Stores the distance, or takes the setting back, with null: the row goes, and the distance that is configured is the one again.</summary>
    public async Task SetTripMinDistanceKmAsync(double? kilometers, CancellationToken ct = default)
    {
        await using var connection = await dataSource.OpenConnectionAsync(ct);
        if (kilometers is not { } value)
        {
            await connection.ExecuteAsync(new CommandDefinition(
                "delete from app_setting where key = @Key", new { Key = TripMinDistanceKmKey }, cancellationToken: ct));
            return;
        }

        await connection.ExecuteAsync(new CommandDefinition(
            """
            insert into app_setting (key, value, updated_at) values (@Key, to_jsonb(@Value::double precision), now())
            on conflict (key) do update set value = excluded.value, updated_at = now()
            """,
            new { Key = TripMinDistanceKmKey, Value = value }, cancellationToken: ct));
    }

    private const string Select =
        "select (value #>> '{}')::double precision from app_setting where key = @Key and jsonb_typeof(value) = 'number'";
}
