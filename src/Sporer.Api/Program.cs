using FastEndpoints;
using FastEndpoints.Swagger;
using Microsoft.Extensions.Options;
using Npgsql;
using Sporer.Api.Configuration;

var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureOptions<DataBaseOptionsSetup>();
builder.Services.AddSingleton(sp =>
    NpgsqlDataSource.Create(sp.GetRequiredService<IOptions<DataBaseOptions>>().Value.ConnectionString));
builder.Services
    .AddFastEndpoints([Sporer.Api.DiscoveredTypes.All])
    .SwaggerDocument();
var app = builder.Build();

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
