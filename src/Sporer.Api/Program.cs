using FastEndpoints;
using FastEndpoints.Swagger;
using Microsoft.Extensions.Options;
using Npgsql;
using Sporer.Api.Configuration;
using Sporer.Api.Database;
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
builder.Services
    .AddFastEndpoints([Sporer.Api.DiscoveredTypes.All])
    .SwaggerDocument();
var app = builder.Build();

// A failing migration throws here, so the app does not start; Overland keeps unsent points and retries.
DatabaseMigrator.Migrate(app.Services.GetRequiredService<IOptions<DataBaseOptions>>().Value.ConnectionString, app.Logger);
var databaseWarnings = app.Services.GetRequiredService<DatabaseWarnings>();
foreach (var warning in await DatabaseInspector.InspectAsync(app.Services.GetRequiredService<NpgsqlDataSource>()))
{
    databaseWarnings.Add(warning);
    app.Logger.LogWarning("Database check: {Warning}", warning);
}

if (string.IsNullOrEmpty(app.Services.GetRequiredService<IOptions<OverlandOptions>>().Value.Token))
    app.Logger.LogWarning("Overland ingest is open; set OVERLAND_TOKEN");

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
