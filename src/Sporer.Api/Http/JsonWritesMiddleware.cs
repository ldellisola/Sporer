using Microsoft.Net.Http.Headers;

namespace Sporer.Api.Http;

/// <summary>
/// Turns away a write whose body is not JSON: a <c>POST</c>, <c>PUT</c> or <c>PATCH</c> under <c>/api</c> with a <c>Content-Type</c>
/// other than <c>application/json</c> (a charset is allowed), or with a body and no <c>Content-Type</c>, is answered <c>415</c>
/// with problem details, and never reaches an endpoint.
/// </summary>
/// <remarks>
/// <para>
/// This is for the day the app sits behind a login that a browser keeps in a cookie (there is no CORS, so another site cannot read
/// an answer, but it can still make the browser send a request): the kinds of body a page can send to another site without being
/// asked first are a form, <c>multipart/form-data</c> and <c>text/plain</c>, and none of them is JSON. A write that takes only JSON
/// cannot be triggered that way, however an endpoint binds its request (a form field can fill a request's property as well as a
/// JSON one).
/// </para>
/// <para>
/// A request with no body and no <c>Content-Type</c> is let through: some writes take no body (a retry, a restore), and a form comes
/// with a content type even when it has no fields. <c>POST /api/overland</c> is left alone altogether: it is sent by an app and
/// not by a page, it has its own token, and what it takes is its own business (see <c>ConsumeEndpoint</c>). A <c>DELETE</c> is
/// no part of this: none takes a body.
/// </para>
/// </remarks>
public sealed class JsonWritesMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var request = context.Request;
        if (IsWrite(request) && !IsJsonOrNothing(request))
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

    private static bool IsJsonOrNothing(HttpRequest request)
        => string.IsNullOrWhiteSpace(request.ContentType)
            ? !HasBody(request)
            : MediaTypeHeaderValue.TryParse(request.ContentType, out var type)
              && type.MediaType.Equals("application/json", StringComparison.OrdinalIgnoreCase);

    /// <summary>Whether the request says it has a body: a length above zero, or a body of no stated length (chunked).</summary>
    private static bool HasBody(HttpRequest request)
        => request.ContentLength is > 0
           || (request.ContentLength is null && request.Headers.ContainsKey(HeaderNames.TransferEncoding));
}
