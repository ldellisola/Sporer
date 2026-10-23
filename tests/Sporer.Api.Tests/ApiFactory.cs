using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Sporer.Api.Tests;

/// <summary>
/// Hosts the real API against a test database. Background work is switched off and ingest is open by default;
/// pass <paramref name="settings"/> to override or add configuration values, and
/// <paramref name="time"/> to replace the app's <see cref="TimeProvider"/> (for example with a fake clock).
/// </summary>
public sealed class ApiFactory(
    string connectionString,
    IDictionary<string, string?>? settings = null,
    TimeProvider? time = null)
    : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        var values = new Dictionary<string, string?>
        {
            ["TSDB_CONNECTION_STRING"] = connectionString,
            ["Processing:Enabled"] = "false",
            ["Nominatim:Enabled"] = "false",
            ["OVERLAND_TOKEN"] = "",
            ["Overland:Token"] = "",
        };

        if (settings is not null)
            foreach (var (key, value) in settings)
                values[key] = value;

        // UseSetting values are visible to Program.cs before Build() and win over environment variables
        // for the keys set here. The token keys default to empty above, so a stray OVERLAND_TOKEN
        // on the machine running the tests cannot reach the app.
        foreach (var (key, value) in values)
            builder.UseSetting(key, value);

        if (time is not null)
            builder.ConfigureTestServices(services =>
            {
                services.RemoveAll<TimeProvider>();
                services.AddSingleton(time);
            });
    }
}
