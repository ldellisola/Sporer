namespace Sporer.SyntheticData;

/// <summary>
/// A small deterministic generator (SplitMix64). <see cref="Random"/> promises the same sequence for a seed only within one
/// runtime version; the generator's output has to be the same for a seed wherever and whenever it runs, so it owns its
/// random numbers.
/// </summary>
internal sealed class Rng(ulong seed)
{
    private ulong _state = seed;

    /// <summary>A stream of its own for <paramref name="seed"/>: streams with different <paramref name="stream"/> numbers are unrelated.</summary>
    public static Rng For(int seed, int stream) => new(unchecked((ulong)seed * 0x9E3779B97F4A7C15UL + (ulong)stream * 0xD1B54A32D192ED03UL + 1));

    public ulong NextULong()
    {
        unchecked
        {
            _state += 0x9E3779B97F4A7C15UL;
            var z = _state;
            z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
            z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
            return z ^ (z >> 31);
        }
    }

    /// <summary>Uniform in [0, 1).</summary>
    public double NextDouble() => (NextULong() >> 11) * (1.0 / (1UL << 53));

    public double Uniform(double low, double high) => low + (high - low) * NextDouble();

    /// <summary>Uniform whole number in [0, <paramref name="count"/>).</summary>
    public int Next(int count) => (int)(NextDouble() * count);

    public bool Chance(double probability) => NextDouble() < probability;

    public T Pick<T>(IReadOnlyList<T> items) => items[Next(items.Count)];

    /// <summary>Two independent standard normal numbers (Box-Muller).</summary>
    public (double A, double B) Gauss2()
    {
        var u1 = 1.0 - NextDouble(); // (0, 1]: the logarithm is finite
        var u2 = NextDouble();
        var radius = Math.Sqrt(-2.0 * Math.Log(u1));
        var angle = 2.0 * Math.PI * u2;
        return (radius * Math.Cos(angle), radius * Math.Sin(angle));
    }

    public double Gauss() => Gauss2().A;
}
