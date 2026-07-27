"use server";

/**
 * 首页 SLA 展示开关的 Server Action 薄适配器。
 *
 * 使用方：首页管理员 client island；只解析布尔输入、构造真实用户 Principal、调用
 * UOL 并映射安全反馈，权限与设置写入由统一操作层负责。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import type { AppUserRole } from "@repo/shared/auth/roles";
import { logger } from "@repo/shared/logger";
import { ActionUserError, protectedAction } from "@repo/shared/safe-action";
import {
  OperationError,
  type OperationErrorCode,
} from "@repo/shared/uol/errors";
import type { Principal } from "@repo/shared/uol/principal";
import { z } from "zod";
import { ensureUolInitialized } from "@/server/uol-init";

/** 首页 SLA 展示开关的已校验传输输入。 */
export type MarketingSlaVisibilityUpdateInput = { enabled: boolean };

/** 首页 SLA 展示开关的最小传输输出。 */
export type MarketingSlaVisibilityUpdateOutput = { enabled: boolean };

/** 首页 SLA 展示更新失败时允许写入日志的固定字段。 */
export type MarketingSlaVisibilityFailureEvent = {
  event: "marketing_sla_visibility_update_failed";
  safeCode: OperationErrorCode | "unexpected_failure";
};

type UserPrincipal = Extract<Principal, { type: "user" }>;

/** Server Action core 可注入依赖，测试无需执行 next-safe-action 会话中间件。 */
export type MarketingSlaVisibilityUpdateDependencies = {
  initializeUol: () => Promise<void>;
  loadRole: (userId: string) => Promise<AppUserRole>;
  invokeVisibilityOperation: (
    name: "settings.setMarketingSlaVisibility",
    input: MarketingSlaVisibilityUpdateInput,
    principal: UserPrincipal
  ) => Promise<MarketingSlaVisibilityUpdateOutput>;
  reportFailure: (event: MarketingSlaVisibilityFailureEvent) => void;
};

const defaultDependencies: MarketingSlaVisibilityUpdateDependencies = {
  initializeUol: ensureUolInitialized,
  loadRole: getUserRoleById,
  invokeVisibilityOperation: async (name, input, principal) => {
    const { invokeOperation } = await import("@repo/shared/uol");
    return invokeOperation<MarketingSlaVisibilityUpdateOutput>(
      name,
      input,
      principal
    );
  },
  reportFailure: (event) => {
    logger.error(event, "Homepage SLA visibility update failed");
  },
};

/**
 * 执行首页 SLA 展示开关的传输层核心逻辑。
 *
 * @param input - 已通过 Server Action schema 校验的布尔开关。
 * @param userId - protectedAction 会话提供的真实用户 ID。
 * @param dependencies - UOL 初始化、角色读取、网关调用与安全日志依赖。
 * @returns UOL 返回的最小开关 DTO。
 * @sideEffects 初始化 UOL、读取当前角色、调用设置写 operation；失败时记录固定字段。
 * @failure 权限错误映射为稳定管理员提示，其他错误映射为通用重试提示；原始异常不会
 * 进入日志或用户消息。
 */
export async function runMarketingSlaVisibilityUpdate(
  input: MarketingSlaVisibilityUpdateInput,
  userId: string,
  dependencies: MarketingSlaVisibilityUpdateDependencies = defaultDependencies
): Promise<MarketingSlaVisibilityUpdateOutput> {
  try {
    await dependencies.initializeUol();
    const role = await dependencies.loadRole(userId);
    return await dependencies.invokeVisibilityOperation(
      "settings.setMarketingSlaVisibility",
      input,
      { type: "user", userId, role }
    );
  } catch (error) {
    const safeCode =
      error instanceof OperationError ? error.code : "unexpected_failure";
    dependencies.reportFailure({
      event: "marketing_sla_visibility_update_failed",
      safeCode,
    });
    if (
      error instanceof OperationError &&
      (error.code === "forbidden" || error.code === "unauthenticated")
    ) {
      throw new ActionUserError("此操作需要管理员权限");
    }
    throw new ActionUserError("更新首页 SLA 展示失败，请稍后重试");
  }
}

/**
 * 解析管理员开关请求并把真实会话 userId 转交可测试的传输 core。
 *
 * @returns next-safe-action 编码的成功结果或稳定用户错误。
 * @sideEffects 由 runMarketingSlaVisibilityUpdate 声明。
 * @failure schema 拒绝非布尔值或额外字段；core 失败时只返回管理员权限提示或通用
 * 重试提示，不暴露 UOL 和设置服务内部错误。
 */
export const updateMarketingSlaStatusVisibilityAction = protectedAction
  .metadata({ action: "marketing.slaStatus.visibility" })
  .schema(z.object({ enabled: z.boolean() }).strict())
  .action(({ parsedInput, ctx }) =>
    runMarketingSlaVisibilityUpdate(parsedInput, ctx.userId)
  );
