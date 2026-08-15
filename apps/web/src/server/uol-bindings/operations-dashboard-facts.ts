/**
 * 运营总览基础事实 UOL late binding。
 *
 * 使用方：uol-bindings 启动桶。访问 operation 只信任真实 user Principal；epoch
 * operation 只信任 system Principal；自动 epoch 对 APP_TIME_ZONE 采取失败关闭策略。
 */
import { isValidTimeZone } from "@repo/shared/time-zone";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { bindOperationExecute, OperationError } from "@repo/shared/uol";
import {
  ensureCurrentOperationsEpoch,
  recordWebVisit,
} from "@repo/shared/uol/operations/operations-dashboard-facts";

import {
  ensureCurrentOperationsAnalyticsEpoch,
  OperationsFactsServiceError,
  recordOperationsWebVisit,
} from "@/features/operations-dashboard/operations-facts-service";

/** 将运营事实领域错误转换为稳定 UOL 错误。 */
function throwOperationsFactsOperationError(error: unknown): never {
  if (error instanceof OperationsFactsServiceError) {
    throw new OperationError("validation_error", error.message);
  }
  throw error;
}

/**
 * 读取不可变 epoch 所需的严格部署时区。
 *
 * @returns 显式配置且运行时支持的 IANA APP_TIME_ZONE。
 * @failure 缺失或非法时拒绝发布，禁止静默回退 UTC 后写入不可变日期。
 */
function getRequiredOperationsEpochTimeZone(): string {
  const timeZone = process.env.APP_TIME_ZONE?.trim();
  if (!timeZone || !isValidTimeZone(timeZone)) {
    throw new OperationError(
      "validation_error",
      "APP_TIME_ZONE 必须是有效的 IANA 时区"
    );
  }
  return timeZone;
}

bindOperationExecute(recordWebVisit, async (_input, principal) => {
  if (principal.type !== "user") {
    throw new OperationError(
      "unauthenticated",
      "User session authentication required"
    );
  }
  try {
    return await recordOperationsWebVisit({
      userId: principal.userId,
      timeZone: getAppTimeZone(),
    });
  } catch (error) {
    throwOperationsFactsOperationError(error);
  }
});

bindOperationExecute(ensureCurrentOperationsEpoch, async (input, principal) => {
  if (principal.type !== "system") {
    throw new OperationError("forbidden", "System access required");
  }
  try {
    return await ensureCurrentOperationsAnalyticsEpoch(
      input,
      getRequiredOperationsEpochTimeZone()
    );
  } catch (error) {
    throwOperationsFactsOperationError(error);
  }
});
