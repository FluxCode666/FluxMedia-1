/**
 * 图库到简易生图页的参考图交接契约。
 *
 * 使用方是图库灯箱和 `GeneratePageClient`。本模块只解析一次性查询意图并清理 URL，
 * 不下载媒体、不读取用户状态，也不接受第三方图片地址。
 */

import { z } from "zod";

const REFERENCE_HANDOFF_PARAM_KEYS = [
  "mode",
  "ref",
  "sourceId",
  "sourceName",
  "intent",
  "sendRef",
] as const;

const referenceHandoffSchema = z
  .object({
    mode: z.literal("image"),
    ref: z.string().trim().min(1).max(8_192),
    sourceId: z.string().trim().min(1).max(256),
    sourceName: z.string().trim().min(1).max(256),
    intent: z.string().trim().min(1).max(256),
    sendRef: z.string().trim().min(1).max(256),
  })
  .refine((value) => value.intent === value.sendRef, {
    message: "Reference handoff intents must match",
  })
  .refine(
    (value) => {
      try {
        const parsed = new URL(value.ref, "https://fluxmedia.invalid");
        return (
          value.ref.startsWith("/api/storage/") &&
          parsed.origin === "https://fluxmedia.invalid" &&
          parsed.pathname.startsWith("/api/storage/")
        );
      } catch {
        return false;
      }
    },
    { message: "Reference image must use first-party storage" }
  );

/** 已通过查询参数和第一方存储路径校验的图库参考图。 */
export interface ReferenceHandoffIntent {
  readonly id: string;
  readonly imageUrl: string;
  readonly sourceId: string;
  readonly sourceName: string;
}

/** URLSearchParams 与 Next.js ReadonlyURLSearchParams 共用的最小只读接口。 */
export interface ReferenceHandoffSearchParams {
  get(name: string): string | null;
  getAll(name: string): string[];
}

/**
 * 解析图库灯箱生成的一次性参考图意图。
 *
 * @param searchParams 浏览器或 Next.js 提供的只读查询参数。
 * @returns 参数唯一、意图一致且指向站内存储时返回交接对象，否则返回 null。
 * @sideEffects 无。
 * @failure 非法、重复、外站或过长输入统一安全返回 null。
 */
export function parseReferenceHandoffIntent(
  searchParams: ReferenceHandoffSearchParams
): ReferenceHandoffIntent | null {
  if (
    REFERENCE_HANDOFF_PARAM_KEYS.some(
      (key) => searchParams.getAll(key).length !== 1
    )
  ) {
    return null;
  }

  const parsed = referenceHandoffSchema.safeParse(
    Object.fromEntries(
      REFERENCE_HANDOFF_PARAM_KEYS.map((key) => [key, searchParams.get(key)])
    )
  );
  if (!parsed.success) return null;

  return {
    id: parsed.data.intent,
    imageUrl: parsed.data.ref,
    sourceId: parsed.data.sourceId,
    sourceName: parsed.data.sourceName,
  };
}

/**
 * 判断 URL 是否携带图库参考图交接信号。
 *
 * @param searchParams 浏览器或 Next.js 提供的只读查询参数。
 * @returns 存在 ref 或 sendRef 时返回 true；不代表参数已通过完整校验。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function hasReferenceHandoffParams(
  searchParams: ReferenceHandoffSearchParams
): boolean {
  return (
    searchParams.getAll("ref").length > 0 ||
    searchParams.getAll("sendRef").length > 0
  );
}

/**
 * 从当前 URL 移除已消费的图库交接参数。
 *
 * @param currentUrl 浏览器当前完整 URL。
 * @returns 保留 pathname、其他查询参数和 hash 的同源相对 URL。
 * @sideEffects 克隆输入 URL，不修改调用方对象，也不执行导航。
 * @failure URL 由调用方构造并保证合法；参数缺失时返回等价相对 URL。
 */
export function removeReferenceHandoffParams(currentUrl: URL): string {
  const nextUrl = new URL(currentUrl.toString());
  for (const key of REFERENCE_HANDOFF_PARAM_KEYS) {
    nextUrl.searchParams.delete(key);
  }
  return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
}
