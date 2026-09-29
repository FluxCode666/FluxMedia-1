export type GoApiError = {
  code: string;
  message: string;
  details?: unknown;
};

/** Same-origin JSON client for Go endpoints that wrap successful payloads in `data`. */
export async function requestGoJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: GoApiError; message?: string }
    | T
    | null;
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new Error(error?.message || (payload && typeof payload === "object" && "message" in payload ? payload.message : undefined) || "请求失败，请稍后重试");
  }
  if (payload && typeof payload === "object" && "data" in payload) return payload.data as T;
  return payload as T;
}
