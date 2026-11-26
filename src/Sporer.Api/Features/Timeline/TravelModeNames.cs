using System.Diagnostics.CodeAnalysis;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

/// <summary>
/// A move's mode as it is stored and sent: the <see cref="TravelMode"/> member's name in lower case, <c>walk</c>, <c>cycle</c>, <c>drive</c>,
/// <c>bus</c>, <c>train</c> or <c>flight</c> (the six that <c>segment.mode</c> and <c>mode_edit.mode</c> accept).
/// </summary>
public static class TravelModeNames
{
    private static readonly Dictionary<string, TravelMode> ByName =
        Enum.GetValues<TravelMode>().ToDictionary(Name, mode => mode, StringComparer.Ordinal);

    /// <summary>The six names, in the order the transit spec lists them.</summary>
    public static IReadOnlyList<string> All { get; } = ["walk", "cycle", "drive", "bus", "train", "flight"];

    public static string Name(TravelMode mode) => mode.ToString().ToLowerInvariant();

    /// <summary>The mode called exactly <paramref name="name"/> (lower case, no spaces), if there is one.</summary>
    public static bool TryParse([NotNullWhen(true)] string? name, out TravelMode mode)
    {
        if (name is not null && ByName.TryGetValue(name, out mode))
            return true;
        mode = default;
        return false;
    }
}
