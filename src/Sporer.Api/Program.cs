using FastEndpoints;
using FastEndpoints.Swagger;
using Microsoft.Extensions.Options;
using Npgsql;
using Sporer.Api.Configuration;
using Sporer.Api.Database;
using Sporer.Api.Features.Places;
using Sporer.Api.Features.Timeline;
using Sporer.Timeline;

var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureOptions<DataBaseOptionsSetup>();
builder.Services.ConfigureOptions<OverlandOptionsSetup>();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton(sp =>
    NpgsqlDataSource.Create(sp.GetRequiredService<IOptions<DataBaseOptions>>().Value.ConnectionString));
builder.Services.AddSingleton<DatabaseWarnings>();
builder.Services.AddSingleton(sp =>
    sp.GetRequiredService<IConfiguration>().GetSection("Detection").Get<DetectionOptions>() ?? new DetectionOptions());
builder.Services.AddSingleton<PointStore>();
builder.Services.AddSingleton<PlaceStore>();
builder.Services.AddSingleton<SegmentStore>();
builder.Services.AddSingleton<ITimelineProcessor, TimelineProcessor>();
builder.Services.AddSingleton(sp =>
    sp.GetRequiredService<IConfiguration>().GetSection("Processing").Get<ProcessingOptions>() ?? new ProcessingOptions());
builder.Services.AddSingleton<ProcessingQueue>();
builder.Services.AddSingleton<TimelineWorker>();
// Always registered, so tests can drive it by hand; it runs in the background only when processing is enabled.
if (builder.Configuration.GetValue("Processing:Enabled", true))
    builder.Services.AddHostedService(sp => sp.GetRequiredService<TimelineWorker>());
builder.Services.AddSingleton(sp =>
    sp.GetRequiredService<IConfiguration>().GetSection("Nominatim").Get<NominatimOptions>() ?? new NominatimOptions());
builder.Services
    .AddHttpClient<NominatimClient>((sp, client) =>
    {
        // Nominatim's usage policy asks for an identifying User-Agent; nothing is requested without one (see PlaceNamer).
        var userAgent = sp.GetRequiredService<NominatimOptions>().UserAgent;
        if (!string.IsNullOrWhiteSpace(userAgent) && !client.DefaultRequestHeaders.UserAgent.TryParseAdd(userAgent))
            client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", userAgent);
        client.Timeout = TimeSpan.FromSeconds(20);
        client.MaxResponseContentBufferSize = 1024 * 1024; // an answer is a few kB; a runaway one is not buffered
    })
    // The client lives as long as the PlaceNamer singleton, so its connections must not outlive DNS changes.
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) });
builder.Services.AddSingleton<PlaceNamer>();
// Always registered, so tests can drive it by hand; it runs in the background only when processing and naming are enabled
// and Nominatim has a user agent to be told. Naming without one would break the service's usage policy.
var nominatimEnabled = builder.Configuration.GetValue("Nominatim:Enabled", true);
var nominatimUserAgentSet = !string.IsNullOrWhiteSpace(builder.Configuration["Nominatim:UserAgent"]);
if (builder.Configuration.GetValue("Processing:Enabled", true) && nominatimEnabled && nominatimUserAgentSet)
    builder.Services.AddHostedService(sp => sp.GetRequiredService<PlaceNamer>());
builder.Services
    .AddFastEndpoints([Sporer.Api.DiscoveredTypes.All])
    .SwaggerDocument();
var app = builder.Build();

// The checks of locationLog come first, so that what they find is logged even if a migration then fails.
var databaseWarnings = app.Services.GetRequiredService<DatabaseWarnings>();
foreach (var warning in await DatabaseInspector.InspectAsync(app.Services.GetRequiredService<NpgsqlDataSource>()))
{
    databaseWarnings.Add(warning);
    app.Logger.LogWarning("Database check: {Warning}", warning);
}

// A failing migration throws here, so the app does not start; Overland keeps unsent points and retries.
DatabaseMigrator.Migrate(app.Services.GetRequiredService<IOptions<DataBaseOptions>>().Value.ConnectionString, app.Logger);

if (nominatimEnabled && !nominatimUserAgentSet)
{
    const string warning = "Place naming disabled: set Nominatim:UserAgent";
    databaseWarnings.Add(warning);
    app.Logger.LogWarning("{Warning}", warning);
}

if (string.IsNullOrEmpty(app.Services.GetRequiredService<IOptions<OverlandOptions>>().Value.Token))
    app.Logger.LogWarning("{Warning}", OverlandOptions.OpenIngestWarning);

app
    .UseFastEndpoints(t=>
    {
        t.Endpoints.RoutePrefix = "api";
    })
    .UseDefaultExceptionHandler()
    .UseSwaggerGen();

app.UseStaticFiles();
app.MapFallbackToFile("index.html");

app.Run();

public partial class Program;
