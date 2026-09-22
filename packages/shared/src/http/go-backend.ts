import { headers } from "next/headers";

/** HTTP metadata stays available to domain transports without changing Error compatibility. */
export class GoBackendHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "GoBackendHttpError";
  }
}

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
  const requestHeaders = new Headers(init.headers);
  try {
    const cookie = (await headers()).get("cookie");
    if (cookie) requestHeaders.set("cookie", cookie);
  } catch {
    // Internal startup and maintenance callers have no Next request scope.
  }
  if (init.body && !requestHeaders.has("content-type")) {
    requestHeaders.set("content-type", "application/json");
  }

  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: requestHeaders,
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as T & {
    error?: { message?: string; code?: string };
  };
  if (!response.ok) {
    throw new GoBackendHttpError(
      payload?.error?.message || `Go backend request failed (${response.status})`,
      response.status,
      payload?.error?.code
    );
  }
  return payload as T;
}

/** Internal Go operations authenticate the trusted server with its cron key. */
export async function requestGoBackendInternalJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) throw new Error("Go internal credential is not configured");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${secret}`);
  return requestGoBackendJson<T>(path, { ...init, headers });
}
