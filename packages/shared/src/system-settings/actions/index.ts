"use server";

/**
 * 系统设置 Server Actions。
 *
 * Actions 只负责验证登录会话、校验输入并转发到 Go API。管理员权限、事务、审计
 * 和设置数据均由 Go 后端持有，避免 Next Server Action 重新读取角色或数据库。
 */

import { cookies } from "next/headers";
import { z } from "zod";

import {
  moderationBlockRiskLevelSchema,
  type ResolvedModerationPolicyValues,
} from "../../moderation/policy-contract";
import type { SetGlobalRiskLevelResult } from "../../moderation/policy-service";
import { ActionUserError, protectedAction } from "../../safe-action";
import type { ImageCreditOverrides } from "../../image-backend/group-image-pricing";
import type { getAdminSystemSettingsSnapshot } from "../index";
import { siteLogoUrlSchema } from "../site-branding";

const globalModerationPolicyInputSchema = z
  .object({
    level: moderationBlockRiskLevelSchema,
    reason: z
      .string()
      .trim()
      .min(1, "请填写变更原因")
      .max(300, "变更原因最多 300 个字符"),
  })
  .strict();

/** 把 Go API 错误映射为安全中文反馈，不透传内部实现细节。 */
function throwModerationPolicyActionError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("权限") || message.includes("登录")) {
    throw new ActionUserError("无权查看或修改全站审核策略");
  }
  if (message.includes("不合法") || message.includes("不能为空")) {
    throw new ActionUserError("审核级别或变更原因不合法");
  }
  throw new ActionUserError("审核策略操作失败，请稍后重试");
}

const settingUpdateSchema = z.object({
  key: z.string().min(1),
  value: z.unknown().optional(),
  clear: z.boolean().optional(),
});

async function requestGo<T>(path: string, body?: unknown, method = "GET"): Promise<T> {
  const base = (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");
  const cookieHeader = (await cookies())
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(payload?.error?.message || "请求失败，请稍后重试");
  }
  return payload;
}

export const getSystemSettingsAction = protectedAction
  .metadata({ action: "system-settings.get" })
  .action(async () =>
    requestGo<{
      settings: Awaited<ReturnType<typeof getAdminSystemSettingsSnapshot>>;
    }>("/api/system-settings")
  );

/** 读取后端池等只读消费者所需的完整全局价格矩阵。 */
export const getGlobalModelPricingAction = protectedAction
  .metadata({ action: "system-settings.model-pricing.get" })
  .action(async () =>
    requestGo<{
      image: ImageCreditOverrides;
      videoBillingModes: Record<string, string>;
      videoCreditsPerItem: Record<string, number>;
      videoCreditsPerSecond: Record<string, number>;
    }>("/api/system-settings/model-pricing")
  );

/** 读取全站审核级别；管理员权限由 Go API 校验。 */
export const getGlobalModerationPolicyAction = protectedAction
  .metadata({ action: "system-settings.moderation.getGlobalPolicy" })
  .action(async () => {
    try {
      const raw = await requestGo<{
        policy: ResolvedModerationPolicyValues;
        recentAudits: Array<{ id: string; adminUserId: string | null; reason: string | null;
          before: Record<string, unknown> | null; after: Record<string, unknown> | null;
          metadata: Record<string, unknown> | null; createdAt: string }>;
      }>("/api/system-settings/moderation-policy");
      return { policy: raw.policy, recentAudits: raw.recentAudits.map(audit => ({ ...audit, createdAt: new Date(audit.createdAt) })) };
    } catch (error) {
      throwModerationPolicyActionError(error);
    }
  });

/** 更新全站审核级别；策略、事务与审计由 Go 后端统一完成。 */
export const setGlobalModerationPolicyAction = protectedAction
  .metadata({ action: "system-settings.moderation.setGlobalPolicy" })
  .schema(globalModerationPolicyInputSchema)
  .action(async ({ parsedInput }) => {
    try {
      const result = await requestGo<Omit<SetGlobalRiskLevelResult, "updatedAt"> & { updatedAt: string }>(
        "/api/system-settings/moderation-policy",
        parsedInput,
        "PUT"
      );
      return {
        success: true,
        ...result,
        updatedAt: new Date(result.updatedAt),
        message: result.changed
          ? "全站审核级别已更新"
          : "全站审核级别未发生变化",
      };
    } catch (error) {
      throwModerationPolicyActionError(error);
    }
  });

export const updateSystemSettingsAction = protectedAction
  .metadata({ action: "system-settings.update" })
  .schema(
    z.object({
      settings: z.array(settingUpdateSchema).min(1),
    })
  )
  .action(async ({ parsedInput }) =>
    requestGo<{ success: boolean; changedKeys: string[]; message: string }>(
      "/api/system-settings",
      { settings: parsedInput.settings },
      "PUT"
    )
  );

/** 保存或恢复网站 Logo；地址契约、权限与缓存副作用由 Go 后端持有。 */
export const setSiteLogoAction = protectedAction
  .metadata({ action: "system-settings.site-logo.set" })
  .schema(
    z
      .object({
        logoUrl: siteLogoUrlSchema.nullable(),
      })
      .strict()
  )
  .action(async ({ parsedInput }) =>
    requestGo<{ success: boolean; logoUrl: string; message: string }>(
      "/api/system-settings/site-logo",
      parsedInput,
      "PUT"
    )
  );

export const importSystemSettingsFromEnvAction = protectedAction
  .metadata({ action: "system-settings.importEnv" })
  .schema(z.object({ overwrite: z.boolean().optional() }).optional())
  .action(async ({ parsedInput }) =>
    requestGo<{ success: boolean; importedKeys: string[]; message: string }>(
      "/api/system-settings/import-env",
      { overwrite: parsedInput?.overwrite ?? true },
      "POST"
    )
  );

export const initializeSystemSettingsDefaultsAction = protectedAction
  .metadata({ action: "system-settings.initializeDefaults" })
  .action(async () =>
    requestGo<{
      success: boolean;
      initializedKeys: string[];
      message: string;
    }>("/api/system-settings/initialize-defaults", {}, "POST")
  );
