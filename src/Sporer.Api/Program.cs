using FastEndpoints;
using FastEndpoints.Swagger;
using Microsoft.Extensions.Options;
using Npgsql;
using Sporer.Api.Configuration;
using Sporer.Api.Database;

var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureOptions<DataBaseOptionsSetup>();
builder.Services.AddSingleton(sp =>
    NpgsqlDataSource.Create(sp.GetRequiredService<IOptions<DataBaseOptions>>().Value.ConnectionString));
builder.Services.AddSingleton<DatabaseWarnings>();
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
