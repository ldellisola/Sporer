using System.IO.Compression;
using FastEndpoints;
using FastEndpoints.Swagger;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.Options;
using Npgsql;
using Sporer.Api.Configuration;
using Sporer.Api.Database;
using Sporer.Api.Features.Places;
using Sporer.Api.Features.Range;
using Sporer.Api.Features.Timeline;
using Sporer.Api.Features.Trips;
using Sporer.Api.Http;
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
builder.Services.AddSingleton<RangeStore>();
builder.Services.AddSingleton<NightStore>();
builder.Services.AddSingleton<NightBuilder>();
builder.Services.AddSingleton<TripStore>();
builder.Services.AddSingleton<TripRefresher>();
builder.Services.AddSingleton<ITripRefresher>(sp => sp.GetRequiredService<TripRefresher>());
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
builder.Services.AddSingleton(sp =>
    sp.GetRequiredService<IConfiguration>().GetSection("Map").Get<MapOptions>() ?? new MapOptions());
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    // The app is reachable only through Traefik, over the VPN, and Traefik is not on loopback (the only address trusted
    // by default): whatever connects is the proxy, so any proxy is trusted. Never publish the app's own port.
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});
// ASP.NET compresses at its Fastest level unless told otherwise, and there Brotli (quality 1) comes out larger than gzip for JavaScript:
// the web app's three scripts were 680 kB with Brotli and 626 kB with gzip, against 525 kB at Optimal for both, which also takes the
// year's answer from 166 kB to 155 kB. Optimal costs next to nothing (the year takes 80 ms at p95 against 71, the largest script 26 ms
// against 11). The level above it saves a further 17 % on the scripts but takes up to two seconds for one of them and over a second for
// the year, so it is not used. Measured in docs/superpowers/plans/2026-10-24-sporer-plan-2-perf.md.
builder.Services.Configure<BrotliCompressionProviderOptions>(options => options.Level = CompressionLevel.Optimal);
builder.Services.Configure<GzipCompressionProviderOptions>(options => options.Level = CompressionLevel.Optimal);
builder.Services.AddResponseCompression(options =>
{
    // Traefik ends TLS and sends X-Forwarded-Proto: https, which the forwarded-headers middleware (above) turns into Request.IsHttps. The
    // compression middleware skips every https request unless told not to, so without this compression would silently stop in production
    // only: the app itself speaks plain http, and so does every test that does not send the header.
    options.EnableForHttps = true;
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
    // text/javascript is what .NET serves .js files as (application/javascript before .NET 9).
    options.MimeTypes =
    [
        "application/json", "text/html", "text/css", "application/javascript", "text/javascript", "image/svg+xml",
    ];
});
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

// The order is the design. Forwarded headers first, so that everything after sees the client's address and scheme.
// Compression wraps the rest, so the tag that conditional GET makes is over the uncompressed body, and a 304 needs no encoding.
// The exception handler wraps conditional GET, which holds a body back and so leaves the response clean for the handler.
// A write that is not sent as JSON, with a body or without, is turned away before any endpoint sees it, so it sits inside the exception handler and ahead of them.
app.UseForwardedHeaders();
// Compression is for what is read. A write's answer, above all Overland's {"result":"ok"}, goes out as it is.
app.UseWhen(
    context => HttpMethods.IsGet(context.Request.Method) || HttpMethods.IsHead(context.Request.Method),
    reads => reads.UseResponseCompression());
app.UseDefaultExceptionHandler();
app.UseMiddleware<JsonWritesMiddleware>();
app.UseMiddleware<ConditionalGetMiddleware>();
app
    .UseFastEndpoints(t=>
    {
        t.Endpoints.RoutePrefix = "api";
    })
    .UseSwaggerGen();

// The web app: files of the web root, and its own routes (/day/2026-10-22, ...) answered with index.html so that a deep link
// or a reload works. The API has no part in either: under /api a path that no endpoint serves is a 404, never index.html.
var webFiles = new StaticFileOptions
{
    OnPrepareResponse = file =>
    {
        // Vite names a bundle after its content, so a file under /assets never changes. The page that names the bundles does,
        // and so does everything else: those are asked about every time, which the files' own ETag makes cheap.
        // (index.html also comes here as the answer to a route, whose path may well start with /assets.)
        var hashed = file.Context.Request.Path.StartsWithSegments("/assets")
                     && !file.File.Name.Equals("index.html", StringComparison.OrdinalIgnoreCase);
        file.Context.Response.Headers.CacheControl = hashed ? "public, max-age=31536000, immutable" : "no-cache";
    },
};
app.UseWhen(context => !context.Request.Path.StartsWithSegments("/api"), files => files.UseStaticFiles(webFiles));
// Not the default pattern, {*path:nonfile}: it calls a last segment with a dot a file, and so would answer
// /range/2026-10-01..2026-10-22 with a 404. A file, here, is a segment that ends in a dot and letters or digits only.
app.MapFallbackToFile(@"{*path:regex(^(?!api($|/))(?!.*\.\w+$).*$)}", "index.html", webFiles);
app.MapFallbackToFile("/", "index.html", webFiles); // a catch-all with a constraint has no value to test at the root

app.Run();

public partial class Program;
