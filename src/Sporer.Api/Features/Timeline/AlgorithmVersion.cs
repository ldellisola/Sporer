using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Sporer.Timeline;

namespace Sporer.Api.Features.Timeline;

/// <summary>
/// Names the algorithm that produced the stored timeline: the version of the detection code plus a fingerprint of the
/// thresholds it ran with. When the name changes, what is stored is out of date and the whole history is processed again.
/// </summary>
public static class AlgorithmVersion
{
    /// <summary>Bump this when the detection code changes in a way that changes its output.</summary>
    public const int CodeVersion = 1;

    /// <summary><c>"{CodeVersion}:{first 12 hex digits of the SHA-256 of the options as JSON}"</c>.</summary>
    public static string Compute(DetectionOptions options)
    {
        var json = JsonSerializer.Serialize(options);
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(json)));
        return $"{CodeVersion}:{hash[..12]}";
    }
}
