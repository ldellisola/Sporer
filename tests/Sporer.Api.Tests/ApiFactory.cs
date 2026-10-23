using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Sporer.Api.Tests;

/// <summary>
/// Hosts the real API against a test database. Background work is switched off by default;
/// pass <paramref name="settings"/> to override or add configuration values.
/// </summary>
public sealed class ApiFactory(string connectionString, IDictionary<string, string?>? settings = null)
    : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        var values = new Dictionary<string, string?>
        {
            ["TSDB_CONNECTION_STRING"] = connectionString,
            ["Processing:Enabled"] = "false",
            ["Nominatim:Enabled"] = "false",
        };

        if (settings is not null)
            foreach (var (key, value) in settings)
                values[key] = value;

        foreach (var (key, value) in values)
            builder.UseSetting(key, value);
    }
}
