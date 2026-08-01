/**
 * API 上游脚本执行的脱敏可观测性。
 *
 * 使用方：通用执行器在请求或响应脚本失败时生成支持请求标识，并向 Pino 标准
 * 输出写入厂商无关事件；本模块不得接收脚本、正文、凭据、URL 或原始任务 ID。
 */
import { randomUUID } from "node:crypto";
import type { ApiUpstreamAdapterOperationId } from "@repo/shared/image-backend/api-upstream-script-contract";
import { logger } from "@repo/shared/logger";

/** 调用方可提供的账号池维度；全部是平台内部标识。 */
export interface ApiUpstreamObservabilityContext {
  readonly memberId?: string;
  readonly groupId?: string | null;
}

/** 创建不含用户或供应商数据的单次执行标识。 */
export function createApiUpstreamRequestId(): string {
  return `apiu_${randomUUID().replaceAll("-", "")}`;
}

/**
 * 写入统一脚本失败事件。
 *
 * @param input 仅包含平台枚举、内部账号池 ID 和随机请求标识。
 * @sideEffects 通过 Pino 向标准输出写一条 error 级结构化日志。
 * @failure 日志实现自身负责优雅降级；本函数不读取原始异常以避免敏感数据泄露。
 */
export function logApiUpstreamScriptFailure(input: {
  operation: ApiUpstreamAdapterOperationId;
  stage: "request" | "response";
  code: "request_script_failed" | "response_script_failed";
  requestSent: boolean;
  retryAction: "switch_member" | "hold_accepted_task" | "fail_before_send";
  requestId: string;
  platformModelId: string;
  taskSummary: "generation_submission" | "accepted_task";
  observability?: ApiUpstreamObservabilityContext;
}): void {
  logger.error(
    {
      event: "api_upstream_script_failed",
      operation: input.operation,
      stage: input.stage,
      code: input.code,
      requestSent: input.requestSent,
      retryAction: input.retryAction,
      memberId: input.observability?.memberId ?? null,
      groupId: input.observability?.groupId ?? null,
      platformModelId: input.platformModelId,
      requestId: input.requestId,
      taskSummary: input.taskSummary,
    },
    "api_upstream_script_failed"
  );
}
