/**
 * 公告列表的 Go 后端适配器。
 *
 * 公告的筛选、分页、已读状态和管理员统计由 Go/PostgreSQL 负责；这里仅保留
 * 领域契约的传输适配，避免生产路径再次直接导入 Next Drizzle 数据库。
 */
import { cookies } from "next/headers";

import type {
  AdminAnnouncementListOutput,
  UserAnnouncementListOutput,
} from "./list-contract";
import type { AdminAnnouncementPageRequest } from "./list-service-core";
import type { PaginationState } from "../pagination/state";

const goBase = () =>
  (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");

async function requestGo<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookieHeader = (await cookies())
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (cookieHeader) headers.set("cookie", cookieHeader);
  const response = await fetch(`${goBase()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!response.ok) {
    throw new Error(
      payload?.error?.message || `Go backend request failed (${response.status})`
    );
  }
  return payload as T;
}

/** 读取当前用户的公告分页。userId 仅用于保持既有领域函数签名。 */
export async function readUserAnnouncementsPage(
  _userId: string,
  input: PaginationState
): Promise<UserAnnouncementListOutput> {
  return requestGo<UserAnnouncementListOutput>(
    `/api/announcements?page=${input.page}&pageSize=${input.pageSize}`
  );
}

/** 读取管理员公告分页及全局统计。 */
export async function readAdminAnnouncementsPage(
  input: AdminAnnouncementPageRequest
): Promise<AdminAnnouncementListOutput> {
  return requestGo<AdminAnnouncementListOutput>(
    `/api/admin/announcements?page=${input.page}&pageSize=${input.pageSize}&published=${input.published}`
  );
}

/** 标记当前用户全部活跃公告为已读，Go 端使用集合 SQL 保证原子性。 */
export async function markAllActiveAnnouncementsReadForUser(
  _userId: string
): Promise<number> {
  const result = await requestGo<{ count?: number }>(
    "/api/announcements/read-all",
    { method: "POST", body: "{}" }
  );
  return result.count ?? 0;
}
