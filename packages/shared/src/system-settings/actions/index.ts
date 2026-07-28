"use server";

/**
 * 系统设置 Server Actions。
 *
 * 职责：验证真实管理员会话，把传输输入转换为 UOL 调用，并映射安全的用户反馈。
 * 审核策略写入、事务与审计全部由 moderation operation 和 policy service 持有。
 */

import { db } from "@repo/database";
import { adminAuditLog } from "@repo/database/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { AppUserRole } from "../../auth/roles";
import {
  moderationBlockRiskLevelSchema,
  type ResolvedModerationPolicyValues,
} from "../../moderation/policy-contract";
import type { SetGlobalRiskLevelResult } from "../../moderation/policy-service";
import {
  ActionUserError,
  adminAction,
  superAdminAction,
} from "../../safe-action";
import { invokeOperation, OperationError, type Principal } from "../../uol";
import "../../uol/operations/moderation";
import "../../uol/operations/system-settings";
import type { ImageCreditOverrides } from "../../image-backend/group-image-pricing";
import type { getAdminSystemSettingsSnapshot } from "../index";
import {
  importSystemSettingsFromEnv,
  initializeMissingSystemSettingsDefaults,
} from "../index";
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

/** 从已复查数据库角色的 Action 上下文构造可信人工会话 Principal。 */
function createSystemSettingsPrincipal(input: {
  userId: string;
  role: AppUserRole;
}): Principal {
  return { type: "user", userId: input.userId, role: input.role };
}

/** 把 UOL 错误映射为安全中文反馈，不透传 internal_error 内部消息。 */
function throwModerationPolicyActionError(error: unknown): never {
  if (!(error instanceof OperationError)) throw error;
  switch (error.code) {
    case "forbidden":
    case "unauthenticated":
      throw new ActionUserError("无权查看或修改全站审核策略");
    case "validation_error":
      throw new ActionUserError("审核级别或变更原因不合法");
    case "not_found":
      throw new ActionUserError("全站审核策略不存在");
    case "timeout":
    case "not_ready":
      throw new ActionUserError("审核策略服务暂时不可用，请稍后重试");
    default:
      throw new ActionUserError("审核策略操作失败，请稍后重试");
  }
}

const settingUpdateSchema = z.object({
  key: z.string().min(1),
  value: z.unknown().optional(),
  clear: z.boolean().optional(),
});

export const getSystemSettingsAction = superAdminAction
  .metadata({ action: "system-settings.get" })
  .action(async ({ ctx }) => {
    const result = await invokeOperation<{
      settings: Awaited<ReturnType<typeof getAdminSystemSettingsSnapshot>>;
      timestamp: string;
    }>(
      "settings.getSnapshot",
      {},
      createSystemSettingsPrincipal({ userId: ctx.userId, role: ctx.role })
    );
    return { settings: result.settings };
  });

/** 读取后端池等只读消费者所需的完整全局价格矩阵。 */
export const getGlobalModelPricingAction = adminAction
  .metadata({ action: "system-settings.model-pricing.get" })
  .action(async ({ ctx }) => {
    return await invokeOperation<{
      image: ImageCreditOverrides;
      videoCreditsPerSecond: Record<string, number>;
    }>(
      "settings.getModelPricing",
      {},
      createSystemSettingsPrincipal({ userId: ctx.userId, role: ctx.role })
    );
  });

/** 读取全站审核级别，只负责把真实 super_admin 会话传入 UOL。 */
export const getGlobalModerationPolicyAction = superAdminAction
  .metadata({ action: "system-settings.moderation.getGlobalPolicy" })
  .action(async ({ ctx }) => {
    try {
      const policy = await invokeOperation<ResolvedModerationPolicyValues>(
        "moderation.getGlobalRiskPolicy",
        {},
        createSystemSettingsPrincipal({
          userId: ctx.userId,
          role: ctx.role,
        })
      );
      // WHY: 策略读取保持由 UOL 统一解析；审计只做固定 action 的只读投影，
      // 不复用通用设置写入口，也不把无关管理员 metadata 暴露给组件。
      const recentAudits = await db
        .select({
          id: adminAuditLog.id,
          adminUserId: adminAuditLog.adminUserId,
          reason: adminAuditLog.reason,
          before: adminAuditLog.before,
          after: adminAuditLog.after,
          metadata: adminAuditLog.metadata,
          createdAt: adminAuditLog.createdAt,
        })
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.action, "moderation.setGlobalRiskLevel"),
            isNull(adminAuditLog.targetUserId)
          )
        )
        .orderBy(desc(adminAuditLog.createdAt))
        .limit(10);
      return { policy, recentAudits };
    } catch (error) {
      throwModerationPolicyActionError(error);
    }
  });

/** 更新全站审核级别；策略、事务与审计由 UOL 下层统一完成。 */
export const setGlobalModerationPolicyAction = superAdminAction
  .metadata({ action: "system-settings.moderation.setGlobalPolicy" })
  .schema(globalModerationPolicyInputSchema)
  .action(async ({ parsedInput, ctx }) => {
    try {
      const result = await invokeOperation<SetGlobalRiskLevelResult>(
        "moderation.setGlobalRiskLevel",
        parsedInput,
        createSystemSettingsPrincipal({
          userId: ctx.userId,
          role: ctx.role,
        })
      );
      return {
        success: true,
        ...result,
        message: result.changed
          ? "全站审核级别已更新"
          : "全站审核级别未发生变化",
      };
    } catch (error) {
      throwModerationPolicyActionError(error);
    }
  });

export const updateSystemSettingsAction = superAdminAction
  .metadata({ action: "system-settings.update" })
  .schema(
    z.object({
      settings: z.array(settingUpdateSchema).min(1),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const result = await invokeOperation<{
      success: boolean;
      changedKeys: string[];
    }>(
      "settings.update",
      { updates: parsedInput.settings },
      createSystemSettingsPrincipal({ userId: ctx.userId, role: ctx.role })
    );

    return {
      success: result.success,
      changedKeys: result.changedKeys,
      message: "系统设置已保存",
    };
  });

/** 保存或恢复网站 Logo；地址契约、权限与缓存副作用统一由 UOL 持有。 */
export const setSiteLogoAction = superAdminAction
  .metadata({ action: "system-settings.site-logo.set" })
  .schema(
    z
      .object({
        logoUrl: siteLogoUrlSchema.nullable(),
      })
      .strict()
  )
  .action(async ({ parsedInput, ctx }) => {
    const result = await invokeOperation<{ logoUrl: string }>(
      "settings.setSiteLogo",
      parsedInput,
      createSystemSettingsPrincipal({ userId: ctx.userId, role: ctx.role })
    );
    return {
      ...result,
      success: true,
      message: parsedInput.logoUrl
        ? "网站 Logo 已更新"
        : "网站 Logo 已恢复为默认资源",
    };
  });

export const importSystemSettingsFromEnvAction = superAdminAction
  .metadata({ action: "system-settings.importEnv" })
  .schema(z.object({ overwrite: z.boolean().optional() }).optional())
  .action(async ({ parsedInput, ctx }) => {
    const importedKeys = await importSystemSettingsFromEnv({
      updatedBy: ctx.userId,
      overwrite: parsedInput?.overwrite ?? true,
    });
    return {
      success: true,
      importedKeys,
      message:
        importedKeys.length > 0
          ? `已导入 ${importedKeys.length} 个环境变量配置`
          : "没有可导入的环境变量配置",
    };
  });

export const initializeSystemSettingsDefaultsAction = superAdminAction
  .metadata({ action: "system-settings.initializeDefaults" })
  .action(async ({ ctx }) => {
    const initializedKeys = await initializeMissingSystemSettingsDefaults({
      updatedBy: ctx.userId,
    });
    return {
      success: true,
      initializedKeys,
      message:
        initializedKeys.length > 0
          ? `已初始化 ${initializedKeys.length} 个默认配置`
          : "默认配置已存在，无需初始化",
    };
  });
