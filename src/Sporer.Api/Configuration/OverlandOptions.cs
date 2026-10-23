using Microsoft.Extensions.Options;

namespace Sporer.Api.Configuration;

public sealed class OverlandOptions
{
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
