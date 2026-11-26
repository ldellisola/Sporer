using System.Buffers.Binary;
using Sporer.Timeline;

namespace Sporer.Api.Features.Transit;

/// <summary>
/// The lines of a tile as <c>transit_tile.lines</c> holds them: a version byte (1), the number of lines, and for each line the number of
/// its points and then each point's latitude and longitude in microdegrees (about 0.1 m), all as little-endian 32-bit integers. A dense
/// city tile of 16 000 points is about 130 kB. A point that is not a position on the globe is not written, and splits its line there, as
/// <see cref="TransitLines"/> would; a line with no point left is not written at all.
/// </summary>
public static class TransitLineBlob
{
    private const byte Version = 1;
    private const double MicrodegreesPerDegree = 1_000_000;

    public static byte[] Encode(IEnumerable<IReadOnlyList<GeoPoint>> lines)
    {
        ArgumentNullException.ThrowIfNull(lines);

        var pieces = new List<List<GeoPoint>>();
        foreach (var line in lines)
        {
            var piece = new List<GeoPoint>();
            foreach (var point in line)
            {
                if (IsPosition(point))
                {
                    piece.Add(point);
                    continue;
                }
                if (piece.Count > 0)
                    pieces.Add(piece);
                piece = [];
            }
            if (piece.Count > 0)
                pieces.Add(piece);
        }

        var blob = new byte[1 + 4 + pieces.Sum(p => 4 + p.Count * 8)];
        blob[0] = Version;
        var at = 1;
        BinaryPrimitives.WriteInt32LittleEndian(blob.AsSpan(at), pieces.Count);
        at += 4;
        foreach (var piece in pieces)
        {
            BinaryPrimitives.WriteInt32LittleEndian(blob.AsSpan(at), piece.Count);
            at += 4;
            foreach (var point in piece)
            {
                BinaryPrimitives.WriteInt32LittleEndian(blob.AsSpan(at), Micro(point.Latitude));
                BinaryPrimitives.WriteInt32LittleEndian(blob.AsSpan(at + 4), Micro(point.Longitude));
                at += 8;
            }
        }
        return blob;
    }

    /// <summary>How many lines <see cref="Encode"/> writes for <paramref name="lines"/>.</summary>
    public static int CountLines(byte[] blob) => blob.Length >= 5 ? BinaryPrimitives.ReadInt32LittleEndian(blob.AsSpan(1)) : 0;

    /// <exception cref="FormatException"><paramref name="blob"/> is not what <see cref="Encode"/> writes.</exception>
    public static IReadOnlyList<IReadOnlyList<GeoPoint>> Decode(byte[] blob)
    {
        ArgumentNullException.ThrowIfNull(blob);
        if (blob.Length < 5 || blob[0] != Version)
            throw new FormatException("The lines of a tile do not start with the expected version and count.");

        var count = BinaryPrimitives.ReadInt32LittleEndian(blob.AsSpan(1));
        if (count < 0)
            throw new FormatException("The lines of a tile have a negative count.");

        var lines = new List<IReadOnlyList<GeoPoint>>(Math.Min(count, blob.Length / 12));
        var at = 5;
        for (var k = 0; k < count; k++)
        {
            if (blob.Length - at < 4)
                throw new FormatException("The lines of a tile end before their last line.");
            var points = BinaryPrimitives.ReadInt32LittleEndian(blob.AsSpan(at));
            at += 4;
            if (points < 0 || (long)points * 8 > blob.Length - at)
                throw new FormatException("A line of a tile has more points than the data holds.");

            var line = new GeoPoint[points];
            for (var p = 0; p < points; p++, at += 8)
            {
                line[p] = new GeoPoint(
                    BinaryPrimitives.ReadInt32LittleEndian(blob.AsSpan(at)) / MicrodegreesPerDegree,
                    BinaryPrimitives.ReadInt32LittleEndian(blob.AsSpan(at + 4)) / MicrodegreesPerDegree);
            }
            lines.Add(line);
        }

        if (at != blob.Length)
            throw new FormatException("The lines of a tile are followed by data that is not theirs.");
        return lines;
    }

    private static int Micro(double degrees) => (int)Math.Round(degrees * MicrodegreesPerDegree, MidpointRounding.AwayFromZero);

    /// <summary>A latitude within ±90 and a longitude within ±180, both finite (what Overpass sends, and what fits in 32 bits).</summary>
    private static bool IsPosition(GeoPoint p)
        => double.IsFinite(p.Latitude) && double.IsFinite(p.Longitude) && p.Latitude is >= -90 and <= 90 && p.Longitude is >= -180 and <= 180;
}
