/**
 * 视频任务的 Principal 作用域幂等标识。
 *
 * 职责：将用户、可选 API Key 与客户端请求键稳定派生为视频任务 ID，
 * 使数据库主键成为跨进程的最终幂等约束。本模块不导入数据库，便于纯单测。
 */

import { createHash } from "node:crypto";

/**
 * 为一次 Principal 作用域内的客户端请求生成稳定任务 ID。
 *
 * @param input 用户 ID、API Key ID（站内请求为空）和已校验请求键。
 * @returns 不暴露原始所有者或请求键的稳定视频任务 ID。
 */
export function createVideoTaskId(input: {
  userId: string;
  apiKeyId?: string;
  clientRequestId: string;
}): string {
  const ownerScope = input.apiKeyId
    ? `api-key:${input.userId}:${input.apiKeyId}`
    : `user:${input.userId}`;
  const digest = createHash("sha256")
    .update(`${ownerScope.length}:${ownerScope}`)
    .update(`:${input.clientRequestId.length}:${input.clientRequestId}`)
    .digest("hex")
    .slice(0, 40);
  return `video_${digest}`;
}

/**
 * 对经过 UOL schema 归一的视频请求生成内容指纹。
 *
 * @param input 已校验且字段顺序稳定的视频 operation 输入。
 * @returns 用于识别“同键不同请求”的 SHA-256 指纹。
 */
export function createVideoRequestFingerprint(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
