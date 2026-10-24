using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Sporer.Api.Tests;

/// <summary>
/// Hosts the real API against a test database. Background work is switched off and ingest is open by default;
/// pass <paramref name="settings"/> to override or add configuration values,
/// <paramref name="time"/> to replace the app's <see cref="TimeProvider"/> (for example with a fake clock), and
/// <paramref name="configureServices"/> to replace services (for example the HTTP handler Nominatim is reached through),
/// <paramref name="webRoot"/> to serve static files from another directory than the project's own wwwroot (which belongs to
/// the web build: a test never writes into it).
/// </summary>
public sealed class ApiFactory(
    string connectionString,
    IDictionary<string, string?>? settings = null,
    TimeProvider? time = null,
    Action<IServiceCollection>? configureServices = null,
    string? webRoot = null)
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

        // The Web SDK lists what lies in the project's wwwroot when it builds (the web app's build output, if it has been built),
        // and in the Development environment the host serves that list ahead of the web root. A test must not see whatever
        // the last `npm run build` left there, so the list is pointed at a file that does not exist.
        builder.UseSetting(WebHostDefaults.StaticWebAssetsKey, "no-static-web-assets.json");

        // The web root is a setting like the others, so Program.cs sees it before Build() and the static files come from there.
        if (webRoot is not null)
            builder.UseWebRoot(webRoot);

        builder.ConfigureTestServices(services =>
        {
            if (time is not null)
            {
                services.RemoveAll<TimeProvider>();
                services.AddSingleton(time);
            }

            configureServices?.Invoke(services);
        });
    }
}
