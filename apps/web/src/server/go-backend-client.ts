import { cookies } from "next/headers";
import { createHmac } from "node:crypto";
import type { Principal } from "@repo/shared/uol";

/** Structured failure returned by a Go endpoint; bindings can preserve stable UOL error codes. */
export class GoBackendRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "GoBackendRequestError";
    this.status = status;
    this.code = code;
  }
}

/** Call the Go backend from a server action while preserving the browser session. */
export async function requestGoJson<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await requestGoResponse(path, init);
  return (await response.json().catch(() => null)) as T;
}

/** Preserve an authenticated Go response body for streaming transport adapters. */
export async function requestGoResponse(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const base = (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(
    /\/$/u,
    ""
  );
  // Scheduled jobs run outside a Next request scope. In that context there is
  // no browser cookie to forward; cron/internal endpoints authenticate via
  // their explicit Authorization header instead.
  let cookieHeader = "";
  try {
    cookieHeader = (await cookies())
      .getAll()
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  } catch {
    cookieHeader = "";
  }
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body)
    headers.set("content-type", "application/json");
  if (cookieHeader) headers.set("cookie", cookieHeader);
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    throw new GoBackendRequestError(
      payload?.error?.message ||
        `Go backend request failed (${response.status})`,
      response.status,
      payload?.error?.code
    );
  }
  return response;
}

/** Call Go with a short-lived signed UOL principal when no browser session exists. */
export async function requestGoJsonForPrincipal<T>(
  principal: Extract<Principal, { type: "apiKey" }>,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const secret = process.env.GO_INTERNAL_PRINCIPAL_SECRET?.trim();
  if (!secret)
    throw new GoBackendRequestError(
      "Go internal principal bridge is not configured",
      503,
      "NOT_READY"
    );
  const payload = Buffer.from(
    JSON.stringify({
      type: "apiKey",
      userId: principal.userId,
      credentialKind: principal.credentialKind,
      apiKeyId: principal.apiKeyId,
      issuedAt: Math.floor(Date.now() / 1000),
    })
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  const headers = new Headers(init.headers);
  headers.set("X-Flux-Principal", payload);
  headers.set("X-Flux-Principal-Signature", signature);
  return requestGoJson<T>(path, { ...init, headers });
}
