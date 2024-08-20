using Microsoft.Extensions.Options;

namespace Sporer.Api.Configuration;

public sealed class DataBaseOptions
{
    public string ConnectionString { get; set; } = string.Empty;
}

public sealed class DataBaseOptionsSetup(IConfiguration configuration) : IConfigureOptions<DataBaseOptions>
{
    public void Configure(DataBaseOptions options)
    {
        options.ConnectionString =
            configuration.GetValue<string?>("TSDB_CONNECTION_STRING") ??
            configuration.GetConnectionString("TSDB") ??
            throw new ArgumentException("Connection String missing");
    }
}