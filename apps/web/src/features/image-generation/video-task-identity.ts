/**
 * 视频任务的 Principal 作用域幂等标识。
 *
 * 职责：将用户、可选 API Key 与客户端请求键稳定派生为视频任务 ID，
 * 使数据库主键成为跨进程的最终幂等约束。本模块不导入数据库，便于纯单测。
 */

import { createHash } from "node:crypto";

import type { MediaInputReference } from "@repo/shared/image-generation/media-contract";
import type { Principal } from "@repo/shared/uol";
import type { CanonicalVideoGenerateInput } from "@repo/shared/uol/operations/video-generation";

/** 为站内会话、外部 API Key 与 MCP Key 生成互不重叠的所有者作用域。 */
export function createVideoPrincipalScope(principal: Principal): string {
  if (principal.type === "user") return `user:${principal.userId}`;
  if (principal.type === "apiKey") {
    return `${principal.credentialKind}:${principal.userId}:${principal.apiKeyId}`;
  }
  throw new Error("视频任务要求用户或 API Key Principal");
}

/**
 * 为一次 Principal 作用域内的客户端请求生成稳定任务 ID。
 *
 * @param input 已持久化 Principal 作用域和已校验请求键。
 * @returns 不暴露原始所有者或请求键的稳定视频任务 ID。
 */
export function createVideoTaskId(input: {
  principalScope: string;
  clientRequestId: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.principalScope.length}:${input.principalScope}`)
    .update(`:${input.clientRequestId.length}:${input.clientRequestId}`)
    .digest("hex")
    .slice(0, 40);
  return `video_${digest}`;
}

/**
 * 把媒体引用投影为字段顺序固定的 JSON-safe 指纹片段。
 *
 * @param reference - 已通过共享媒体 schema 的单个引用。
 * @returns 保留来源语义且不受调用方对象键顺序影响的普通对象。
 * @sideEffects 无。
 * @failure 不抛错；所有联合分支已由 TypeScript 穷尽。
 */
function canonicalizeVideoMediaReference(
  reference: MediaInputReference
): Record<string, unknown> {
  if (reference.source === "data") {
    return {
      source: reference.source,
      mimeType: reference.mimeType,
      base64: reference.base64,
      byteLength: reference.byteLength,
    };
  }
  if (reference.source === "storage") {
    return {
      source: reference.source,
      mimeType: reference.mimeType,
      storageKey: reference.storageKey,
      storageBucket: reference.storageBucket ?? null,
      byteLength: reference.byteLength,
    };
  }
  return {
    source: reference.source,
    mimeType: reference.mimeType,
    url: reference.url,
    byteLength: reference.byteLength,
  };
}

/**
 * 对动态能力解析后的规范视频请求生成内容指纹。
 *
 * @param input - 已解析声音默认值并通过静态、动态能力校验的规范请求。
 * @returns 用于识别“同键不同请求”的 SHA-256 指纹。
 * @sideEffects 无。
 * @failure 不抛错；具名位置与 referenceImages 顺序均进入指纹语义。
 */
export function createVideoRequestFingerprint(
  input: CanonicalVideoGenerateInput
): string {
  const canonical = {
    clientRequestId: input.clientRequestId,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt ?? null,
    model: input.model,
    duration: input.duration,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    generateAudio: input.generateAudio,
    backendGroupId: input.backendGroupId ?? null,
    firstFrame: input.firstFrame
      ? canonicalizeVideoMediaReference(input.firstFrame)
      : null,
    lastFrame: input.lastFrame
      ? canonicalizeVideoMediaReference(input.lastFrame)
      : null,
    referenceImages: (input.referenceImages ?? []).map(
      canonicalizeVideoMediaReference
    ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
