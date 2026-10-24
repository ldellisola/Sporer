using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Npgsql;
using NpgsqlTypes;
using Sporer.SyntheticData;

const string Usage = """
    Writes a fictional person's location history straight into locationlog, for development and performance checks.
    No real data is involved: the city, the person and their trips are made up, and the same options give the same rows.

    dotnet run --project tools/Sporer.SyntheticData -- --connection "<Npgsql connection string>"
        --from 2024-06-01 --to 2026-10-22 --moving-interval 5s --seed 42

      --connection        Npgsql connection string of a database the API has migrated (locationlog must exist).
      --from, --to        First and last local day of the history (yyyy-MM-dd).
      --moving-interval   Time between two fixes while moving: 5s, 1s, 500ms (default 5s). Finer means more rows. For
                          2024-06-01 to 2026-10-22 with seed 42: 5s is 1.08 million rows, 2s 2.7 million, 1s 5.4 million
                          and 500ms 10.7 million.
      --seed              Same seed, same history (default 42).
      --append            Write even if locationlog already has rows (they are never changed; this only adds).
      --dry-run           Count the rows and print their checksum without a database (--connection is not needed).

    Accuracy and motion are filled for the last 90 days only, like real history. Start the API against the database
    afterwards: it backfills the timeline from what is there. Starting it before the points are written would not (the
    points do not pass through ingest, so nothing marks them as new).
    """;

try
{
    var options = Arguments.Parse(args);
    if (options is null)
    {
        Console.WriteLine(Usage);
        return 0;
    }

    return await Writer.RunAsync(options);
}
catch (Exception ex) when (ex is ArgumentException or FormatException or InvalidOperationException or NpgsqlException)
{
    Console.Error.WriteLine(ex.Message);
    Console.Error.WriteLine("Run with --help for the options.");
    return 2;
}

internal sealed record Arguments(
    string? Connection, SimulatorOptions Simulation, bool Append, bool DryRun)
{
    /// <summary>The parsed options, or null when help was asked for.</summary>
    public static Arguments? Parse(string[] args)
    {
        if (args.Length == 0 || args.Any(a => a is "--help" or "-h"))
            return null;

        var values = new Dictionary<string, string>();
        var flags = new HashSet<string>();
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (!arg.StartsWith("--", StringComparison.Ordinal))
                throw new ArgumentException($"Unexpected argument '{arg}'.");

            var split = arg.IndexOf('=');
            if (split > 0)
                values[arg[2..split]] = arg[(split + 1)..];
            else if (arg is "--append" or "--dry-run")
                flags.Add(arg[2..]);
            else if (i + 1 < args.Length)
                values[arg[2..]] = args[++i];
            else
                throw new ArgumentException($"{arg} needs a value.");
        }

        var known = new HashSet<string> { "connection", "from", "to", "moving-interval", "seed" };
        if (values.Keys.FirstOrDefault(k => !known.Contains(k)) is { } unknown)
            throw new ArgumentException($"Unknown option --{unknown}.");

        var dryRun = flags.Contains("dry-run");
        if (!dryRun && !values.ContainsKey("connection"))
            throw new ArgumentException("--connection is required (or --dry-run).");

        var simulation = new SimulatorOptions(
            Date(values, "from"), Date(values, "to"),
            Interval(values.GetValueOrDefault("moving-interval", "5s")),
            values.TryGetValue("seed", out var seed) ? int.Parse(seed, CultureInfo.InvariantCulture) : 42);
        simulation.Validate();
        return new Arguments(values.GetValueOrDefault("connection"), simulation, flags.Contains("append"), dryRun);
    }

    private static DateOnly Date(Dictionary<string, string> values, string name)
        => values.TryGetValue(name, out var text) && DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            ? date
            : throw new ArgumentException($"--{name} is required, written yyyy-MM-dd.");

    private static TimeSpan Interval(string text)
    {
        var match = Regex.Match(text, @"^(\d+(?:\.\d+)?)(ms|s|m)$");
        if (!match.Success)
            throw new ArgumentException($"--moving-interval '{text}' is not a duration like 5s, 1s, 500ms or 1m.");

        var amount = double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
        return match.Groups[2].Value switch
        {
            "ms" => TimeSpan.FromMilliseconds(amount),
            "s" => TimeSpan.FromSeconds(amount),
            _ => TimeSpan.FromMinutes(amount),
        };
    }
}

internal static class Writer
{
    private const string Device = "synthetic-phone";
    private const string Copy =
        "COPY locationlog (time, longitude, latitude, device, speed, altitude, horizontal_accuracy, motion) FROM STDIN (FORMAT BINARY)";

    public static async Task<int> RunAsync(Arguments arguments)
    {
        using var checksum = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long rows = 0;
        DateTime first = default, last = default;
        var watch = System.Diagnostics.Stopwatch.StartNew();

        void Note(in Fix fix)
        {
            if (rows++ == 0)
                first = fix.TimeUtc;
            last = fix.TimeUtc;
            Hash(checksum, fix);
            if (rows % 1_000_000 == 0)
                Console.Error.WriteLine($"  {rows:N0} rows ({watch.Elapsed.TotalSeconds:N0} s)");
        }

        if (arguments.DryRun)
        {
            Simulator.Run(arguments.Simulation, fix => Note(fix));
        }
        else
        {
            await using var connection = new NpgsqlConnection(arguments.Connection);
            await connection.OpenAsync();
            await CheckTableAsync(connection, arguments.Append);

            // One COPY, one transaction: a failure part way leaves nothing behind.
            await using (var writer = await connection.BeginBinaryImportAsync(Copy))
            {
                Simulator.Run(arguments.Simulation, fix =>
                {
                    Note(fix);
                    writer.StartRow();
                    writer.Write(fix.TimeUtc, NpgsqlDbType.TimestampTz);
                    writer.Write(fix.Longitude, NpgsqlDbType.Double);
                    writer.Write(fix.Latitude, NpgsqlDbType.Double);
                    writer.Write(Device, NpgsqlDbType.Text);
                    Nullable(writer, fix.Speed);
                    writer.Write((decimal)fix.Altitude, NpgsqlDbType.Numeric);
                    Nullable(writer, fix.Accuracy);
                    if (fix.Motion is { } motion)
                        writer.Write(motion, NpgsqlDbType.Array | NpgsqlDbType.Text);
                    else
                        writer.WriteNull();
                });
                await writer.CompleteAsync();
            }

            // So that the planner knows the table before autovacuum would have told it.
            await using var analyze = new NpgsqlCommand("ANALYZE locationlog", connection) { CommandTimeout = 0 };
            await analyze.ExecuteNonQueryAsync();
        }

        var hash = Convert.ToHexStringLower(checksum.GetHashAndReset())[..16];
        Console.WriteLine($"{(arguments.DryRun ? "Would write" : "Wrote")} {rows:N0} rows from {first:u} to {last:u}; checksum {hash}; {watch.Elapsed.TotalSeconds:N0} s");
        return 0;
    }

    private static async Task CheckTableAsync(NpgsqlConnection connection, bool append)
    {
        await using (var exists = new NpgsqlCommand("select to_regclass('locationlog') is not null", connection))
        {
            if (!(bool)(await exists.ExecuteScalarAsync())!)
            {
                throw new InvalidOperationException(
                    "locationlog does not exist. Start the API once against this database (with Processing__Enabled=false) so that it " +
                    "creates the schema, stop it, write the points, then start it again with processing enabled.");
            }
        }

        if (append)
            return;

        await using var any = new NpgsqlCommand("select exists (select 1 from locationlog)", connection);
        if ((bool)(await any.ExecuteScalarAsync())!)
            throw new InvalidOperationException("locationlog already has rows. Pass --append to add to them.");
    }

    private static void Nullable(NpgsqlBinaryImporter writer, double? value)
    {
        if (value is { } v)
            writer.Write(v, NpgsqlDbType.Double);
        else
            writer.WriteNull();
    }

    /// <summary>Every field of the row goes into the checksum, so two runs agree only if they wrote the same rows.</summary>
    private static void Hash(IncrementalHash hash, in Fix fix)
    {
        Span<byte> buffer = stackalloc byte[8 * 6 + 1];
        BinaryPrimitives.WriteInt64LittleEndian(buffer, fix.TimeUtc.Ticks);
        BinaryPrimitives.WriteDoubleLittleEndian(buffer[8..], fix.Latitude);
        BinaryPrimitives.WriteDoubleLittleEndian(buffer[16..], fix.Longitude);
        BinaryPrimitives.WriteDoubleLittleEndian(buffer[24..], fix.Speed ?? -1);
        BinaryPrimitives.WriteDoubleLittleEndian(buffer[32..], fix.Altitude);
        BinaryPrimitives.WriteDoubleLittleEndian(buffer[40..], fix.Accuracy ?? -1);
        buffer[48] = fix.Motion is { Length: > 0 } motion ? (byte)motion[0][0] : (byte)0;
        hash.AppendData(buffer);
    }
}
