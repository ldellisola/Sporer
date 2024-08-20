using FastEndpoints;
using FastEndpoints.Swagger;
using Sporer.Api.Configuration;

var builder = WebApplication.CreateBuilder(args);
builder.Services.ConfigureOptions<DataBaseOptionsSetup>();
builder.Services
    .AddFastEndpoints(t=> t.SourceGeneratorDiscoveredTypes.AddRange(Sporer.Api.DiscoveredTypes.All))
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
