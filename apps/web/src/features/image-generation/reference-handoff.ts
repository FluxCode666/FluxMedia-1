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
  "refs",
  "sourceId",
  "sourceIds",
  "sourceName",
  "sourceNames",
  "intent",
  "sendRef",
] as const;

const MAX_REFERENCE_HANDOFF_IMAGES = 50;

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
  /** 多图交接时携带的完整参考图列表；旧版单图交接不设置该字段。 */
  readonly references?: readonly ReferenceHandoffReference[];
}

/** 已通过查询参数校验的单张图库参考图。 */
export interface ReferenceHandoffReference {
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
  const modeValues = searchParams.getAll("mode");
  const intentValues = searchParams.getAll("intent");
  const sendRefValues = searchParams.getAll("sendRef");
  if (
    modeValues.length !== 1 ||
    intentValues.length !== 1 ||
    sendRefValues.length !== 1 ||
    intentValues[0] !== sendRefValues[0]
  ) {
    return null;
  }
  const intent = intentValues[0] ?? "";

  // 新版多选使用 refs/sourceIds/sourceNames；旧版单选继续使用
  // ref/sourceId/sourceName。两套参数同时出现时拒绝，避免交接语义歧义。
  const legacyRefs = searchParams.getAll("ref");
  const multiRefs = searchParams.getAll("refs");
  const legacyIds = searchParams.getAll("sourceId");
  const multiIds = searchParams.getAll("sourceIds");
  const legacyNames = searchParams.getAll("sourceName");
  const multiNames = searchParams.getAll("sourceNames");
  const usingMulti =
    multiRefs.length > 0 || multiIds.length > 0 || multiNames.length > 0;
  const usingLegacy =
    legacyRefs.length > 0 || legacyIds.length > 0 || legacyNames.length > 0;
  if (usingMulti && usingLegacy) return null;

  const refs = usingMulti ? multiRefs : legacyRefs;
  const sourceIds = usingMulti ? multiIds : legacyIds;
  const sourceNames = usingMulti ? multiNames : legacyNames;
  if (
    refs.length < 1 ||
    refs.length > MAX_REFERENCE_HANDOFF_IMAGES ||
    refs.length !== sourceIds.length ||
    refs.length !== sourceNames.length
  ) {
    return null;
  }
  // Legacy 交接严格保持单图，防止旧客户端误把重复 ref 当作多图。
  if (!usingMulti && refs.length !== 1) return null;

  const references: ReferenceHandoffReference[] = [];
  for (let index = 0; index < refs.length; index += 1) {
    const parsed = referenceHandoffSchema.safeParse({
      mode: modeValues[0],
      ref: refs[index],
      sourceId: sourceIds[index],
      sourceName: sourceNames[index],
      intent,
      sendRef: intent,
    });
    if (!parsed.success) return null;
    references.push({
      imageUrl: parsed.data.ref,
      sourceId: parsed.data.sourceId,
      sourceName: parsed.data.sourceName,
    });
  }

  const first = references[0];
  if (!first) return null;
  return {
    id: intent,
    imageUrl: first.imageUrl,
    sourceId: first.sourceId,
    sourceName: first.sourceName,
    ...(usingMulti ? { references } : {}),
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
    searchParams.getAll("refs").length > 0 ||
    searchParams.getAll("sourceId").length > 0 ||
    searchParams.getAll("sourceIds").length > 0 ||
    searchParams.getAll("sourceName").length > 0 ||
    searchParams.getAll("sourceNames").length > 0 ||
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
