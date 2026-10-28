using Microsoft.Net.Http.Headers;

namespace Sporer.Api.Http;

/// <summary>
/// Turns away a write that is not sent as JSON: a <c>POST</c>, <c>PUT</c> or <c>PATCH</c> under <c>/api</c> whose <c>Content-Type</c> is
/// not <c>application/json</c> (a charset is allowed) is answered <c>415</c> with problem details, and never reaches an endpoint. That
/// holds whether or not the request has a body: one without a <c>Content-Type</c> is turned away too. A write that takes no body is
/// sent as JSON all the same, with an empty body or <c>{}</c>.
/// </summary>
/// <remarks>
/// <para>
/// This is for the day the app sits behind a login that a browser keeps in a cookie (there is no CORS, so another site cannot read
/// an answer, but it can still make the browser send a request). The kinds of request a page can send to another site without being
/// asked first (a "simple" request) are a <c>GET</c>, <c>HEAD</c> or <c>POST</c> with, at most, a form, <c>multipart/form-data</c> or
/// <c>text/plain</c> body or no <c>Content-Type</c> at all (a <c>fetch</c> in <c>no-cors</c> mode with no body). None of them is
/// <c>application/json</c>, so a write that takes only that cannot be triggered that way, however an endpoint binds its request (a
/// form field can fill a request's property as well as a JSON one), and whether or not it reads a body.
/// </para>
/// <para>
/// <c>POST /api/overland</c> is left alone altogether: it is sent by an app and not by a page, it has its own token, and what it takes
/// is its own business (see <c>ConsumeEndpoint</c>). A <c>DELETE</c> is no part of this: it is never a simple request, so a page
/// of another site cannot make a browser send one without first asking with a CORS preflight, and the API serves no CORS, so the
/// preflight fails and the request is never sent. (<c>PUT</c> and <c>PATCH</c> are the same, and are checked all the same.)
/// </para>
/// </remarks>
public sealed class JsonWritesMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var request = context.Request;
        if (IsWrite(request) && !IsJson(request))
        {
            await Results.Problem(
                statusCode: StatusCodes.Status415UnsupportedMediaType,
                title: "Unsupported Media Type",
                detail: "A write must be sent as JSON, with the Content-Type application/json.")
                .ExecuteAsync(context);
            return;
        }

        await next(context);
    }

    private static bool IsWrite(HttpRequest request)
        => (HttpMethods.IsPost(request.Method) || HttpMethods.IsPut(request.Method) || HttpMethods.IsPatch(request.Method))
           && request.Path.StartsWithSegments("/api")
           && !request.Path.StartsWithSegments("/api/overland");

    private static bool IsJson(HttpRequest request)
        => MediaTypeHeaderValue.TryParse(request.ContentType, out var type)
           && type.MediaType.Equals("application/json", StringComparison.OrdinalIgnoreCase);
}
