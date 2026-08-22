/**
 * 视频参考视频与音频的 HTTPS URL 传输契约。
 *
 * 使用方：FluxMedia 视频两个外部协议 handler；负责把协议层 URL 映射为统一的
 * remote 媒体引用。实际内容、大小与媒体元数据在任务创建前由输入转存层复验。
 */

import type { MediaInputReference } from "@repo/shared/image-generation/media-contract";
import { z } from "zod";

const HTTPS_URL_PATTERN = /^https:\/\//iu;

/** 校验不携带凭据且扩展名匹配的参考媒体 URL。 */
function referenceUrlSchema(extensions: readonly string[]) {
  return z
    .string()
    .trim()
    .url()
    .refine((rawUrl) => {
      const url = new URL(rawUrl);
      const pathname = url.pathname.toLowerCase();
      return (
        HTTPS_URL_PATTERN.test(rawUrl) &&
        !url.username &&
        !url.password &&
        extensions.some((extension) => pathname.endsWith(extension))
      );
    }, "参考媒体必须是 HTTPS 直链且扩展名有效");
}

export const referenceVideoUrlSchema = referenceUrlSchema([".mp4", ".mov"]);
export const referenceAudioUrlSchema = referenceUrlSchema([".mp3", ".wav"]);

/** 将视频 URL 转成未声明大小的远程媒体引用。 */
export function toReferenceVideoRemoteInput(
  rawUrl: string
): MediaInputReference {
  const url = referenceVideoUrlSchema.parse(rawUrl);
  return {
    source: "remote",
    mimeType: url.toLowerCase().endsWith(".mov")
      ? "video/quicktime"
      : "video/mp4",
    url,
  };
}

/** 将音频 URL 转成未声明大小的远程媒体引用。 */
export function toReferenceAudioRemoteInput(
  rawUrl: string
): MediaInputReference {
  const url = referenceAudioUrlSchema.parse(rawUrl);
  const lower = url.toLowerCase();
  return {
    source: "remote",
    mimeType: lower.endsWith(".wav") ? "audio/wav" : "audio/mpeg",
    url,
  };
}
