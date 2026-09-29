/**
 * 管理员 agent 令牌 Server Actions。
 *
 * 职责：校验浏览器输入并委托 Go 后端 /api/admin/agent-tokens* 完成签发、列表和
 * 撤销。令牌是全局管理员凭据，能力由勾选的 scope 决定；scope 清单以 Go 注册表为准，
 * 这里只校验格式，未知 scope 由后端拒绝。明文令牌只在签发响应中出现一次。
 */
import { adminAction } from "@repo/shared/safe-action";
import {
  type AdminAgentScope,
  type AdminAgentTokenItem,
  adminAgentScopeIdSchema,
  type CreatedAdminAgentToken,
} from "@repo/shared/uol/operations/admin-agent";
import { z } from "zod";
import { requestGoJson } from "@/lib/go-backend-request";

/** 令牌列表页快照：令牌元数据与可签发的 scope 定义。 */
export interface AdminAgentTokenList {
  tokens: AdminAgentTokenItem[];
  availableScopes: AdminAgentScope[];
}

const createAdminAgentTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scopes: z.array(adminAgentScopeIdSchema).min(1).max(32),
    expiresInDays: z.number().int().min(1).max(90).default(30),
  })
  .strict();

const tokenIdSchema = z
  .object({ id: z.string().trim().min(1).max(128) })
  .strict();

/**
 * 调用 Go 令牌管理接口。
 *
 * @param path Go 路由路径。
 * @param method HTTP 方法。
 * @param body 可选 JSON 请求体。
 * @returns Go 返回的 JSON。
 */
async function requestAgentTokens<T>(
  path: string,
  method: string,
  body?: unknown
): Promise<T> {
  return requestGoJson<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** 列出管理员 agent 令牌元数据与可签发 scope。 */
export const listAdminAgentTokensAction = adminAction
  .metadata({ action: "adminAgent.listTokens" })
  .action(async () =>
    requestAgentTokens<AdminAgentTokenList>("/api/admin/agent-tokens", "GET")
  );

/** 签发管理员 agent 令牌，返回仅出现一次的明文。 */
export const createAdminAgentTokenAction = adminAction
  .metadata({ action: "adminAgent.createToken" })
  .schema(createAdminAgentTokenSchema)
  .action(async ({ parsedInput }) =>
    requestAgentTokens<CreatedAdminAgentToken>(
      "/api/admin/agent-tokens",
      "POST",
      parsedInput
    )
  );

/** 撤销管理员 agent 令牌，撤销后立即失效。 */
export const revokeAdminAgentTokenAction = adminAction
  .metadata({ action: "adminAgent.revokeToken" })
  .schema(tokenIdSchema)
  .action(async ({ parsedInput }) =>
    requestAgentTokens<{ id: string; revoked: boolean }>(
      `/api/admin/agent-tokens/${encodeURIComponent(parsedInput.id)}/revoke`,
      "POST",
      {}
    )
  );
