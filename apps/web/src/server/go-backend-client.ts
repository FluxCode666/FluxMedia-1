import { cookies } from "next/headers";

/** Call the Go backend from a server action while preserving the browser session. */
export async function requestGoJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = (process.env.GO_BACKEND_URL || process.env.BETTER_AUTH_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");
  const cookieHeader = (await cookies()).getAll().map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  if (cookieHeader) headers.set("cookie", cookieHeader);
  const response = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store" });
  const payload = (await response.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload?.error?.message || `Go backend request failed (${response.status})`);
  return payload as T;
}
