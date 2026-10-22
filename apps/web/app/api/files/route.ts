import { API_BASE } from "../../../lib/api";

/**
 * The file endpoint, on this origin.
 *
 * Every other call to the API happens on the server, so cross-origin has
 * never come up. An upload is the one exception: the browser sends the bytes
 * itself, to a URL that was signed for it. In production that URL points at
 * the bucket, which answers its own CORS preflight and takes the PUT
 * directly. In development it points at our own API on another port, and the
 * browser refuses the request before it is ever sent.
 *
 * So the signed URL points here instead, and this forwards.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: verify the signature. That check lives
 * in SignedUrlFileStore and is reached through the API's own files route,
 * which is the only place that holds the signing secret. Re-implementing it
 * here would put security-critical logic in two places, and two copies of a
 * check are two things that drift — the version that stops rejecting forged
 * URLs would keep working perfectly, which is exactly how nobody notices.
 *
 * The signature is host-independent: it covers the method, the key, the
 * expiry, the content type and the byte limit, and not the origin. That is
 * what makes forwarding sound rather than a workaround — the URL this handler
 * passes on verifies exactly as it would have at the bucket.
 *
 * It adds no authority of its own. It holds no secret, reads no cookie and
 * sets no header the caller did not send, so it can grant nothing the signed
 * URL did not already grant.
 */

/** Only the query string travels; the path is fixed on both sides. */
function target(request: Request): string {
  const incoming = new URL(request.url);
  return `${API_BASE}/v1/files${incoming.search}`;
}

/**
 * Upload.
 *
 * The body is passed through as raw bytes and the content type with it,
 * because both were signed — the API compares them against the signature and
 * rejects a mismatch, so altering either here would only produce a confusing
 * failure.
 */
export async function PUT(request: Request): Promise<Response> {
  const body = await request.arrayBuffer();

  const response = await fetch(target(request), {
    method: "PUT",
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/octet-stream",
    },
    body,
  });

  /**
   * The API's own status and body are returned unchanged, including the
   * failures. A forged or expired URL has to reach the caller as the refusal
   * the API gave, not as a generic error from a proxy that swallowed it.
   */
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

/** Download, by the same route and for the same reason. */
export async function GET(request: Request): Promise<Response> {
  const response = await fetch(target(request), { method: "GET" });

  return new Response(await response.arrayBuffer(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/octet-stream",
    },
  });
}
