/**
 * 运营总览基础事实 UOL late binding。
 *
 * 使用方：uol-bindings 启动桶。访问 operation 只信任真实 user Principal；epoch
 * operation 只信任 system Principal，并统一使用部署 APP_TIME_ZONE 验证自然日边界。
 */
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { bindOperationExecute, OperationError } from "@repo/shared/uol";
import {
  initializeOperationsEpoch,
  recordWebVisit,
} from "@repo/shared/uol/operations/operations-dashboard-facts";

import {
  initializeOperationsAnalyticsEpoch,
  OperationsFactsServiceError,
  recordOperationsWebVisit,
} from "@/features/operations-dashboard/operations-facts-service";

/** 将运营事实领域错误转换为稳定 UOL 错误。 */
function throwOperationsFactsOperationError(error: unknown): never {
  if (error instanceof OperationsFactsServiceError) {
    if (error.code === "validation_error") {
      throw new OperationError("validation_error", error.message);
    }
    throw new OperationError("conflict", error.message);
  }
  throw error;
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

bindOperationExecute(initializeOperationsEpoch, async (input, principal) => {
  if (principal.type !== "system") {
    throw new OperationError("forbidden", "System access required");
  }
  try {
    return await initializeOperationsAnalyticsEpoch(input, getAppTimeZone());
  } catch (error) {
    throwOperationsFactsOperationError(error);
  }
});
