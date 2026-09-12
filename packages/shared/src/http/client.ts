/** Plain JSON transport. No React Flight encoding or Next-Action headers. */
export type JsonValue<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? JsonValue<U>[]
    : T extends object
      ? { [K in keyof T]: JsonValue<T[K]> }
      : T;

export type JsonEndpoint = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  jsonQuery?: readonly string[];
};
export type JsonFailure = {
  code: string;
  message: string;
  details?: unknown;
};
export type ActionResult = {
  data?: unknown;
  serverError?: string;
  validationErrors?: unknown;
};
type Handler = (...args: never[]) => Promise<ActionResult | undefined>;
export type JsonAction<T extends Handler> = (
  ...args: Parameters<T>
) => Promise<JsonValue<NonNullable<Awaited<ReturnType<T>>>>>;

export function buildJsonRequest(endpoint: JsonEndpoint, input?: unknown) {
  const fields = { ...((input ?? {}) as Record<string, unknown>) };
  const path = endpoint.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = fields[key];
    if (typeof value !== "string" || !value || value === "." || value === "..") {
      throw new Error(`Missing path parameter: ${key}`);
    }
    delete fields[key];
    return encodeURIComponent(value);
  });
  const headers = { Accept: "application/json" };
  const init: RequestInit = {
    method: endpoint.method,
    credentials: "same-origin",
    cache: "no-store",
    headers,
  };
  if (endpoint.method === "GET") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      query.set(key, endpoint.jsonQuery?.includes(key) ? JSON.stringify(value) : String(value));
    }
    return { url: path + (query.size ? `?${query}` : ""), init };
  }
  init.headers = { ...headers, "Content-Type": "application/json" };
  init.body = JSON.stringify(fields);
  return { url: path, init };
}

/** Keep form state compatibility locally; the wire contract uses data/error only. */
export function createJsonAction<T extends Handler>(endpoint: JsonEndpoint): JsonAction<T> {
  return (async (...args: Parameters<T>) => {
    try {
      const { url, init } = buildJsonRequest(endpoint, args[0]);
      const response = await fetch(url, init);
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object") throw new Error("Invalid JSON response");
      if (response.ok && "data" in payload) return { data: payload.data };
      if (!response.ok && "error" in payload && payload.error && typeof payload.error === "object") {
        const error = payload.error as JsonFailure;
        if (typeof error.code === "string" && typeof error.message === "string") {
          if (error.code === "VALIDATION_ERROR" && error.details) return { validationErrors: error.details };
          return { serverError: error.message };
        }
      }
      return { serverError: "服务返回了无效响应，请稍后重试" };
    } catch {
      return { serverError: "网络请求失败，请稍后重试" };
    }
  }) as JsonAction<T>;
}
