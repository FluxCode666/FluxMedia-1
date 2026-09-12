/**
 * MCP User Key 管理操作
 *
 * 职责：提供终端用户管理自己的 MCP 密钥的 CRUD 操作：
 * - 创建（generate + hash + store，明文仅返回一次）
 * - 列表（脱敏展示，不含 hash/明文）
 * - 撤销（set isActive=false, revokedAt=now）
 * - 删除（仅已撤销的 key 可删除）
 *
 * 使用方：Server Action / MCP 设置页面
 * 关键依赖：@repo/database（db、mcpApiKey schema）、nanoid、crypto
 *
 * 安全约束：
 * - 明文 key 仅在创建时返回一次，后续不可恢复
 * - 所有操作校验 userId 归属，防止越权
 */
"use server";

import { cookies } from "next/headers";

async function go<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = (process.env.GO_BACKEND_URL || process.env.BETTER_AUTH_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");
  const cookie = (await cookies()).getAll().map((item) => `${item.name}=${item.value}`).join("; ");
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(base + path, { ...init, headers, cache: "no-store" });
  const payload = (await response.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload?.error?.message || `请求失败 (${response.status})`);
  return payload;
}

/** MCP key 前缀 - 用于快速区分 key 类型 */
type MCPKeyListItem = {
  id: string;
  name: string;
  keyPrefix: string;
  lastFour: string;
  isActive: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

function parseKeyDates(key: MCPKeyListItem) {
  return {
    ...key,
    lastUsedAt: key.lastUsedAt ? new Date(key.lastUsedAt) : null,
    revokedAt: key.revokedAt ? new Date(key.revokedAt) : null,
    createdAt: new Date(key.createdAt),
  };
}

/**
 * 创建新的 MCP 用户密钥。
 *
 * 生成随机密钥 -> SHA-256 哈希 -> 存入数据库。
 * 明文仅此次返回，不可恢复。
 *
 * @param userId - 所属用户 ID
 * @param name - 用户自定义名称（可选，默认 "Default MCP key"）
 * @returns 包含明文密钥的创建结果（明文仅此次可见）
 */
export async function createMcpKey(
  userId: string,
  name?: string,
): Promise<{
  id: string;
  key: string;
  name: string;
  keyPrefix: string;
  lastFour: string;
  createdAt: Date;
}> {
  // userId is retained for source compatibility; Go derives ownership from
  // the authenticated Better Auth session and never trusts this argument.
  void userId;
  const result = await go<{
    id: string;
    key: string;
    name: string;
    keyPrefix: string;
    lastFour: string;
    createdAt: string;
  }>("/api/mcp/keys", { method: "POST", body: JSON.stringify({ name }) });
  return { ...result, createdAt: new Date(result.createdAt) };
}

/**
 * 列出用户的 MCP 密钥（脱敏，不含 hash/明文）。
 *
 * @param userId - 用户 ID
 * @returns 脱敏的 key 列表
 */
export async function listMcpKeys(userId: string): Promise<
  Array<{
    id: string;
    name: string;
    keyPrefix: string;
    lastFour: string;
    isActive: boolean;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  }>
> {
  void userId;
  const keys = await go<MCPKeyListItem[]>("/api/mcp/keys");
  return keys.map(parseKeyDates);
}

/**
 * 撤销 MCP 密钥（不可逆）。
 *
 * 将 isActive 设为 false、revokedAt 设为当前时间。
 * 已撤销的 key 不可恢复，仅可进一步删除。
 *
 * @param userId - 用户 ID（归属校验）
 * @param keyId - 要撤销的 key ID
 * @returns 是否成功（key 不存在或非该用户所有返回 false）
 */
export async function revokeMcpKey(
  userId: string,
  keyId: string,
): Promise<boolean> {
  void userId;
  const result = await go<{ success: boolean }>(`/api/mcp/keys/${encodeURIComponent(keyId)}/revoke`, { method: "POST", body: "{}" });
  return result.success;
}

/**
 * 删除 MCP 密钥（仅允许删除已撤销的 key）。
 *
 * 安全约束：仅 isActive=false 的 key 可被物理删除。
 * 防止误删正在使用的 key。
 *
 * @param userId - 用户 ID（归属校验）
 * @param keyId - 要删除的 key ID
 * @returns 是否成功（key 不存在、非该用户所有、或仍 active 均返回 false）
 */
export async function deleteMcpKey(
  userId: string,
  keyId: string,
): Promise<boolean> {
  void userId;
  const result = await go<{ success: boolean }>(`/api/mcp/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
  return result.success;
}
