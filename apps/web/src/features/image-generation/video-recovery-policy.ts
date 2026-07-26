/**
 * 视频恢复状态机的 DB-free 纯策略。
 *
 * 职责：生成稳定对象存储键、约束原 token 刷新身份，并分类已接受 Adobe 任务的
 * 可重试错误。
 * 使用方：video-operations 与 Vitest；不得导入数据库或 Web 运行时。
 */

import {
  AdobeAcceptedVideoError,
  isRetryableStatus,
} from "@repo/shared/adobe/firefly-direct";

/** 由用户和任务 ID 派生稳定对象键，worker 重放只覆盖同一对象。 */
export function createVideoStorageKey(userId: string, videoId: string): string {
  return `${userId}/videos/${videoId}.mp4`;
}

/**
 * 接受任务刷新凭据时只允许复用原 token ID。
 *
 * WHY：Adobe 的 poll URL 已绑定提交账号；切换 token 可能读取不到任务，也可能把鉴权
 * 故障误判成上游失败。刷新缺失或身份变化都作为可重试错误保留任务。
 */
export function requireOriginalAcceptedVideoToken(input: {
  tokenId: string;
  refreshed: { id: string; value: string } | null;
}): string {
  if (!input.refreshed || input.refreshed.id !== input.tokenId) {
    throw new AdobeAcceptedVideoError(
      "Adobe 视频恢复原账号刷新失败，任务将保留重试",
      { errorType: "network" }
    );
  }
  return input.refreshed.value;
}

/**
 * 已接受任务的网络、临时状态与鉴权状态都只重试原任务。
 *
 * 401/403 可能只是持久 token 过期；适配器会先刷新原账号的同一 token ID。即使刷新
 * 暂时失败，也不能把可能已成功的上游任务退款或向其他账号重新提交。
 */
export function shouldRetryAcceptedVideoError(error: unknown): boolean {
  return (
    error instanceof AdobeAcceptedVideoError &&
    (error.statusCode === undefined ||
      error.statusCode === 401 ||
      error.statusCode === 403 ||
      isRetryableStatus(error.statusCode))
  );
}
