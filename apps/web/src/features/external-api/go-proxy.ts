import type { NextRequest } from "next/server";

/**
 * Forward the public OpenAI/Gemini compatible API to the Go gateway.
 *
 * Keeping this as a thin transport proxy means authentication, quota, task
 * persistence, and response contracts all come from the Go implementation.
 * The Authorization header and request body are passed through unchanged so
 * external clients do not need to know which process serves the endpoint.
 */
export async function proxyExternalApi(
  request: NextRequest,
  _context?: unknown
): Promise<Response> {
  const base = (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(
    /\/$/u,
    ""
  );
  const incoming = new URL(request.url);
  const headers = new Headers(request.headers);
  // Fetch computes these for the upstream connection. Forwarding stale values
  // can truncate streamed or multipart requests.
  headers.delete("host");
  headers.delete("content-length");

  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
  const body = hasBody ? await request.arrayBuffer() : undefined;
  const upstream = await fetch(`${base}${incoming.pathname}${incoming.search}`, {
    method: request.method,
    headers,
    body,
    cache: "no-store",
    redirect: "manual",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
