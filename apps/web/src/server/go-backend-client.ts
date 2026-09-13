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
export async function requestGoJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");
  const cookieHeader = (await cookies()).getAll().map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  if (cookieHeader) headers.set("cookie", cookieHeader);
  const response = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store" });
  const payload = (await response.json().catch(() => null)) as T & { error?: { message?: string; code?: string } };
  if (!response.ok) {
    throw new GoBackendRequestError(
      payload?.error?.message || `Go backend request failed (${response.status})`,
      response.status,
      payload?.error?.code
    );
  }
  return payload as T;
}

/** Call Go with a short-lived signed UOL principal when no browser session exists. */
export async function requestGoJsonForPrincipal<T>(
  principal: Extract<Principal, { type: "apiKey" }>,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const secret = process.env.GO_INTERNAL_PRINCIPAL_SECRET?.trim();
  if (!secret) throw new GoBackendRequestError("Go internal principal bridge is not configured", 503, "NOT_READY");
  const payload = Buffer.from(JSON.stringify({
    type: "apiKey",
    userId: principal.userId,
    credentialKind: principal.credentialKind,
    apiKeyId: principal.apiKeyId,
    issuedAt: Math.floor(Date.now() / 1000),
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  const headers = new Headers(init.headers);
  headers.set("X-Flux-Principal", payload);
  headers.set("X-Flux-Principal-Signature", signature);
  return requestGoJson<T>(path, { ...init, headers });
}
