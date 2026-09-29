/**
 * Node 进程到 Go backend 的内部 JSON 请求边界。
 *
 * 使用方：运维脚本、集成测试等在浏览器之外运行的维护调用。请求使用 GO_BACKEND_URL
 * 绝对地址，并以部署环境中的 CRON_SECRET 作为内部凭据；浏览器构建不会引用本模块。
 */
import { GoBackendHttpError } from "./go-backend";

type GoErrorPayload = { error?: { message?: string; code?: string } } | null;

/** 以内部凭据调用 Go 内部端点并解析 JSON；非 2xx 抛出 GoBackendHttpError。 */
export async function requestGoBackendInternalJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) throw new Error("Go internal credential is not configured");
  const base = (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${secret}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store" });
  const payload = (await response.json().catch(() => null)) as T & GoErrorPayload;
  if (!response.ok) {
    throw new GoBackendHttpError(
      payload?.error?.message || `Go backend request failed (${response.status})`,
      response.status,
      payload?.error?.code
    );
  }
  return payload as T;
}
