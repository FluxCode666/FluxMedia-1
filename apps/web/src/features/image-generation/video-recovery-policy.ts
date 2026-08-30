/**
 * 视频恢复状态机的 DB-free 纯策略。
 *
 * 职责：生成稳定对象存储键、保留安全的切换失败根因，并分类已接受 API 任务的可重试错误。
 * 使用方：video-operations 与 Vitest；不得导入数据库或 Web 运行时。
 */

import { buildGeneratedVideoStorageKey } from "@repo/shared/storage/bucket-config";

import { ApiAcceptedVideoError } from "./api-video-error";

const MAX_API_ADAPTER_QUERY_FAILURES = 3;

/** API 查询适配连续失败后的纯状态推进结论。 */
export interface ApiAdapterQueryFailureDecision {
  nextFailureCount: number;
  shouldRetry: boolean;
}

/**
 * 连续三次查询脚本或执行失败后终止原任务并进入退款。
 *
 * @param currentFailureCount 任务已持久化的连续失败次数。
 * @returns 下一次计数以及是否仍应保留原任务重试。
 * @sideEffects 无。
 * @failure 负数或非整数表示持久状态损坏，直接抛错并由恢复 worker 失败关闭。
 */
export function resolveApiAdapterQueryFailure(
  currentFailureCount: number
): ApiAdapterQueryFailureDecision {
  if (!Number.isInteger(currentFailureCount) || currentFailureCount < 0) {
    throw new Error("API 查询适配连续失败次数无效");
  }
  const nextFailureCount = currentFailureCount + 1;
  return {
    nextFailureCount,
    shouldRetry: nextFailureCount < MAX_API_ADAPTER_QUERY_FAILURES,
  };
}

/** 由用户和任务 ID 派生稳定对象键，worker 重放只覆盖同一对象。 */
export function createVideoStorageKey(userId: string, videoId: string): string {
  return buildGeneratedVideoStorageKey(userId, videoId);
}

/**
 * 当前成员失败且没有替代成员时，保留已知安全的账号级根因。
 *
 * @param upstreamError 上游适配器返回的已分类错误。
 * @returns 不泄露上游正文、URL 或凭据的用户可见错误。
 * @sideEffects 无。
 * @failure 未知上游错误统一回落为无可用后端，避免响应正文穿透。
 */
export function resolveVideoBackendExhaustionError(
  upstreamError: string
): string {
  switch (upstreamError) {
    default:
      return "当前分组没有可用于该模型的媒体后端";
  }
}

/** 判断错误是否来自已经被 API 接受的上游视频任务。 */
export function isAcceptedVideoError(error: unknown): boolean {
  return error instanceof ApiAcceptedVideoError;
}

/**
 * 已接受任务的网络、临时状态与鉴权状态都只重试原任务。
 *
 * 401/403 等错误只重试当前任务，避免把可能已成功的上游任务重复提交。
 */
export function shouldRetryAcceptedVideoError(error: unknown): boolean {
  return error instanceof ApiAcceptedVideoError && error.retryable;
}
