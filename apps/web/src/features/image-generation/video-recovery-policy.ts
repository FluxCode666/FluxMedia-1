/**
 * 视频恢复状态机的 DB-free 纯策略。
 *
 * 职责：生成稳定对象存储键，并分类已接受 Adobe 任务的可重试错误。
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

/** 已接受任务只有网络层或可重试 HTTP 状态继续轮询原任务。 */
export function shouldRetryAcceptedVideoError(error: unknown): boolean {
  return (
    error instanceof AdobeAcceptedVideoError &&
    (error.statusCode === undefined || isRetryableStatus(error.statusCode))
  );
}
