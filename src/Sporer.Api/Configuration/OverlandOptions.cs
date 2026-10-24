using Microsoft.Extensions.Options;

namespace Sporer.Api.Configuration;

public sealed class OverlandOptions
{
    /// <summary>What is said, in the log at start-up and in the status, when no token is set.</summary>
    public const string OpenIngestWarning = "Overland ingest is open; set OVERLAND_TOKEN";

    /// <summary>Shared secret Overland must send. Empty means the ingest endpoint is open.</summary>
    public string? Token { get; set; }
}

public sealed class OverlandOptionsSetup(IConfiguration configuration) : IConfigureOptions<OverlandOptions>
{
    public void Configure(OverlandOptions options)
    {
        var token = configuration.GetValue<string?>("OVERLAND_TOKEN");
        options.Token = string.IsNullOrEmpty(token) ? configuration["Overland:Token"] : token;
    }
}
