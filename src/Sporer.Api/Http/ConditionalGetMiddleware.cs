using System.Buffers.Text;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Net.Http.Headers;

namespace Sporer.Api.Http;

/// <summary>
/// Gives every JSON answer of <c>GET /api/*</c> a strong <c>ETag</c> and <c>Cache-Control: no-cache</c>, and answers <c>304</c>
/// with no body to a request whose <c>If-None-Match</c> lists that tag: the browser asks every time and the server says
/// "unchanged" for the price of a header, instead of sending the same document again.
/// </summary>
/// <remarks>
/// <para>
/// The tag is the first 22 characters (132 bits) of the base64url SHA-256 of the body, in quotes. It is made over the bytes the
/// endpoint wrote, so this middleware must sit <em>inside</em> response compression: the tag then belongs to the body, whatever
/// its encoding, and the compression of a 200 never changes it.
/// </para>
/// <para>
/// Only a <c>GET</c> under <c>/api</c> is looked at (there is no <c>HEAD</c> route on the API, and a write is never tagged), and
/// among those only an answer that turns out to be <c>200</c> with a JSON content type is held back until it is whole; the
/// decision is made when the endpoint first writes or flushes, which is when its status and content type are known. Anything
/// else, an error document, a <c>204</c>, an event stream, is written through as it comes, exactly as the endpoint wrote it.
/// Nothing is sent to the client for a held-back answer before the endpoint has finished, so an exception leaves the response
/// untouched for the exception handler, which therefore has to sit outside this middleware as well.
/// </para>
/// <para>The held-back body is kept in memory. The API's documents are bounded (a day, at most 400 days of a range), so no limit is set.</para>
/// </remarks>
public sealed class ConditionalGetMiddleware(RequestDelegate next)
{
    private const int TagLength = 22;

    public async Task InvokeAsync(HttpContext context)
    {
        if (!HttpMethods.IsGet(context.Request.Method) || !context.Request.Path.StartsWithSegments("/api"))
        {
            await next(context);
            return;
        }

        var response = context.Response;
        var client = response.Body;
        var body = new DecidingBody(response, client);
        response.Body = body;
        try
        {
            await next(context);
            // Bytes an endpoint wrote through the pipe writer of the response, and did not flush, are still on their way to the body.
            await context.Features.GetRequiredFeature<IHttpResponseBodyFeature>().CompleteAsync();
        }
        finally
        {
            response.Body = client;
        }

        if (body.Held is not { } held)
            return; // written through as it came, or nothing was written

        using (held)
        {
            var bytes = held.GetBuffer().AsMemory(0, (int)held.Length);
            // An answer with no body at all has nothing to tag, whether or not the endpoint touched the body to say so.
            if (bytes.Length > 0 && IsTaggable(response))
            {
                var tag = '"' + Base64Url.EncodeToString(SHA256.HashData(bytes.Span))[..TagLength] + '"';
                response.Headers.ETag = tag;
                response.Headers.CacheControl = "no-cache";

                if (Matches(context.Request, tag))
                {
                    response.StatusCode = StatusCodes.Status304NotModified;
                    response.ContentType = null;
                    response.ContentLength = null;
                    return;
                }

                response.ContentLength = bytes.Length;
            }

            await client.WriteAsync(bytes, context.RequestAborted);
        }
    }

    private static bool IsTaggable(HttpResponse response)
        => response.StatusCode == StatusCodes.Status200OK
           && MediaTypeHeaderValue.TryParse(response.ContentType, out var type)
           && (type.MediaType.Equals("application/json", StringComparison.OrdinalIgnoreCase)
               || type.Suffix.Equals("json", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Whether <c>If-None-Match</c> lists <paramref name="tag"/> or is <c>*</c>. Weak comparison, as RFC 9110 has it for this
    /// header, so <c>W/"tag"</c> matches too. A header that cannot be read lists nothing.
    /// </summary>
    private static bool Matches(HttpRequest request, string tag)
    {
        var current = new EntityTagHeaderValue(tag);
        foreach (var listed in request.GetTypedHeaders().IfNoneMatch)
        {
            if (listed.Equals(EntityTagHeaderValue.Any) || listed.Compare(current, useStrongComparison: false))
                return true;
        }

        return false;
    }

    /// <summary>
    /// The body of the response while the endpoint runs. At the first write or flush it looks at the status and content type,
    /// which are final by then, and either keeps everything in <see cref="Held"/> or from then on passes everything on.
    /// </summary>
    private sealed class DecidingBody(HttpResponse response, Stream client) : Stream
    {
        private bool _decided;

        /// <summary>The body written so far, when it is being held back; null when it is passed on, or not decided yet.</summary>
        public MemoryStream? Held { get; private set; }

        private Stream Target()
        {
            if (!_decided)
            {
                _decided = true;
                if (IsTaggable(response))
                    Held = new MemoryStream();
            }

            return Held ?? client;
        }

        public override void Write(byte[] buffer, int offset, int count) => Target().Write(buffer, offset, count);

        public override void Write(ReadOnlySpan<byte> buffer) => Target().Write(buffer);

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => Target().WriteAsync(buffer, offset, count, cancellationToken);

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            => Target().WriteAsync(buffer, cancellationToken);

        public override void Flush()
        {
            if (ReferenceEquals(Target(), client))
                client.Flush();
        }

        public override Task FlushAsync(CancellationToken cancellationToken)
            => ReferenceEquals(Target(), client) ? client.FlushAsync(cancellationToken) : Task.CompletedTask;

        public override bool CanRead => false;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
