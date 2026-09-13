import { headers } from "next/headers";

/**
 * Server-only request helper for first-party Go endpoints.
 *
 * The web server must forward the browser session cookie when a Server
 * Component or legacy server operation asks the Go backend for data. Keeping
 * this boundary in shared code prevents those read paths from opening a
 * second Drizzle connection in Next.js.
 */
export async function requestGoBackendJson<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const base = (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(
    /\/$/u,
    ""
  );
  const incoming = await headers();
  const requestHeaders = new Headers(init.headers);
  const cookie = incoming.get("cookie");
  if (cookie) requestHeaders.set("cookie", cookie);
  if (init.body && !requestHeaders.has("content-type")) {
    requestHeaders.set("content-type", "application/json");
  }

  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: requestHeaders,
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(
      payload?.error?.message || `Go backend request failed (${response.status})`
    );
  }
  return payload as T;
}
