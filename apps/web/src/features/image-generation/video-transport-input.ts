/**
 * 视频传输层输入图适配器。
 *
 * 职责：为站内与外部视频创建路由提供同一 data URL 校验和 JSON-safe UOL 媒体
 * 引用转换；本模块只处理已内嵌的数据，不读取网络或对象存储。
 */

import { z } from "zod";

/** 视频输入图 data URL 的统一传输约束。 */
export const videoInputImageDataUrlSchema = z
  .string()
  .min(1)
  .max(20_000_000)
  .regex(/^data:image\/[a-zA-Z.+-]+;base64,/, "Invalid image data URL");

/**
 * 将已校验的图片 data URL 转为 UOL JSON-safe 媒体引用。
 *
 * @param value 通过 videoInputImageDataUrlSchema 校验的 data URL。
 * @returns 不额外分配解码 Buffer 的 base64 媒体引用。
 */
export function toVideoMediaInputReference(value: string) {
  const match = value.match(/^data:(image\/[a-zA-Z.+-]+);base64,(.*)$/);
  const mimeType = match?.[1] ?? "image/png";
  const base64 = match?.[2] ?? "";
  return {
    source: "data" as const,
    mimeType,
    base64,
    byteLength: Buffer.byteLength(base64, "base64"),
  };
}
