"use server";

/**
 * 首页 SLA 展示开关的 Server Action 薄适配器。
 *
 * 使用方：首页管理员 client island；只解析布尔输入并调用 Go 后端，权限与设置写入
 * 由后端统一处理。
 */
import { logger } from "@repo/shared/logger";
import { ActionUserError, protectedAction } from "@repo/shared/safe-action";
import { z } from "zod";
import { requestGoJson } from "@/server/go-backend-client";

/** 首页 SLA 展示开关的已校验传输输入。 */
export type MarketingSlaVisibilityUpdateInput = { enabled: boolean };

/** 首页 SLA 展示开关的最小传输输出。 */
export type MarketingSlaVisibilityUpdateOutput = { enabled: boolean };

/** 首页 SLA 展示更新失败时允许写入日志的固定字段。 */
export type MarketingSlaVisibilityFailureEvent = {
  event: "marketing_sla_visibility_update_failed";
  safeCode: "forbidden" | "unauthenticated" | "unexpected_failure";
};

/** Server Action core 可注入依赖，测试无需执行 next-safe-action 会话中间件。 */
export type MarketingSlaVisibilityUpdateDependencies = {
  updateVisibility: (
    input: MarketingSlaVisibilityUpdateInput
  ) => Promise<MarketingSlaVisibilityUpdateOutput>;
  reportFailure: (event: MarketingSlaVisibilityFailureEvent) => void;
};

const defaultDependencies: MarketingSlaVisibilityUpdateDependencies = {
  updateVisibility: (input) =>
    requestGoJson<MarketingSlaVisibilityUpdateOutput>(
      "/api/marketing/sla-visibility",
      { method: "PUT", body: JSON.stringify(input) }
    ),
  reportFailure: (event) => {
    logger.error(event, "Homepage SLA visibility update failed");
  },
};

/**
 * 执行首页 SLA 展示开关的 Go 传输层核心逻辑。
 *
 * @param input - 已通过 Server Action schema 校验的布尔开关。
 * @param userId - protectedAction 会话提供的真实用户 ID。
 * @param dependencies - Go 后端调用与安全日志依赖。
 * @returns Go 后端返回的最小开关 DTO。
 * @sideEffects 调用 Go 设置接口；失败时记录固定字段。
 * @failure 权限错误映射为稳定管理员提示，其他错误映射为通用重试提示；原始异常不会
 * 进入日志或用户消息。
 */
export async function runMarketingSlaVisibilityUpdate(
  input: MarketingSlaVisibilityUpdateInput,
  _userId: string,
  dependencies: MarketingSlaVisibilityUpdateDependencies = defaultDependencies
): Promise<MarketingSlaVisibilityUpdateOutput> {
  try {
    return await dependencies.updateVisibility(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const permissionFailure =
      message.includes("没有权限") || message.includes("登录已失效");
    const safeCode = permissionFailure
      ? message.includes("登录已失效")
        ? "unauthenticated"
        : "forbidden"
      : "unexpected_failure";
    dependencies.reportFailure({
      event: "marketing_sla_visibility_update_failed",
      safeCode,
    });
    if (permissionFailure) {
      throw new ActionUserError("此操作需要管理员权限");
    }
    throw new ActionUserError("更新首页 SLA 展示失败，请稍后重试");
  }
}

/**
 * 解析管理员开关请求并把受保护会话转交可测试的传输 core。
 *
 * @returns next-safe-action 编码的成功结果或稳定用户错误。
 * @sideEffects 由 runMarketingSlaVisibilityUpdate 声明。
 * @failure schema 拒绝非布尔值或额外字段；core 失败时只返回管理员权限提示或通用
 * 重试提示，不暴露后端设置服务内部错误。
 */
export const updateMarketingSlaStatusVisibilityAction = protectedAction
  .metadata({ action: "marketing.slaStatus.visibility" })
  .schema(z.object({ enabled: z.boolean() }).strict())
  .action(({ parsedInput, ctx }) =>
    runMarketingSlaVisibilityUpdate(parsedInput, ctx.userId)
  );
