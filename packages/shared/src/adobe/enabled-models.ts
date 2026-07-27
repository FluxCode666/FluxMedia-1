/**
 * Adobe 后端开放模型的共享约束与匹配规则。
 *
 * 使用方：Adobe 后端管理表单、UOL 保存操作、后端池调度器与外接 `/v1/models` 列表。
 * 关键依赖：Firefly 图像/视频目录与 Zod；本模块不依赖数据库或网络，确保配置、调度和
 * 模型发现采用同一套白名单语义。
 */
import { z } from "zod";

import { FIREFLY_IMAGE_FAMILY_MODEL_IDS } from "./firefly-direct/catalog";
import { isFireflyVideoModelId } from "./firefly-direct/video-catalog";
import type { AdobeImageFamily } from "./firefly-request";

/** Adobe 后端可配置的图像模型族 ID，顺序同时作为管理端展示顺序。 */
export const ADOBE_IMAGE_MODEL_IDS = [...FIREFLY_IMAGE_FAMILY_MODEL_IDS];

/** Adobe 图片适配器支持的上游家族，顺序与公开模型目录一致。 */
export const ADOBE_IMAGE_FAMILIES: AdobeImageFamily[] = [
  "gpt-image-2",
  "gpt-image-1.5",
  "nano-banana",
  "nano-banana2",
  "nano-banana-pro",
];

const ADOBE_IMAGE_MODEL_ID_SET = new Set(
  ADOBE_IMAGE_MODEL_IDS.map((modelId) => modelId.toLowerCase())
);

/** 单个 Adobe 后端最多配置 5 个已知图像模型族，防止异常配置放大。 */
const MAX_ADOBE_ENABLED_MODEL_IDS = ADOBE_IMAGE_MODEL_IDS.length;

/**
 * 将历史裸模型族或当前 Firefly 模型族 ID 规范为可持久化的模型 ID。
 *
 * @param value - 来自管理端表单或旧数据库 JSON 的单个模型标识。
 * @returns 已知模型族的规范 ID；未知或空值返回 null。
 */
export function normalizeAdobeEnabledModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  const modelId = trimmed.startsWith("firefly-")
    ? trimmed
    : `firefly-${trimmed}`;
  return ADOBE_IMAGE_MODEL_ID_SET.has(modelId) ? modelId : null;
}

/**
 * 标准化 Adobe 后端图像模型白名单，删除非法、重复配置并保留首次出现顺序。
 *
 * @param value - 来自管理端输入或数据库 JSON 列的未知值。
 * @returns 可安全用于持久化、展示和调度的规范模型 ID 列表。
 */
export function normalizeAdobeEnabledModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const modelIds: string[] = [];
  const seen = new Set<string>();
  for (const valueItem of value) {
    const modelId = normalizeAdobeEnabledModelId(valueItem);
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds.slice(0, MAX_ADOBE_ENABLED_MODEL_IDS);
}

/**
 * 判断请求是否为已知 Adobe 图像模型族（允许 Firefly 前缀或历史裸族名）。
 *
 * @param value - 客户端请求的模型 ID。
 * @returns 模型属于已知 Adobe 图像族时返回 true。
 */
export function isAdobeImageFamilyModelId(value: unknown): boolean {
  if (typeof value !== "string") return false;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;

  return ADOBE_IMAGE_MODEL_IDS.some((modelId) => {
    const bareModelId = modelId.slice("firefly-".length);
    return (
      normalized === modelId ||
      normalized.startsWith(`${modelId}-`) ||
      normalized === bareModelId ||
      normalized.startsWith(`${bareModelId}-`)
    );
  });
}

/**
 * Adobe 后端保存输入 schema。
 *
 * WHY：未知模型不能落库后再由调度器静默处理，否则管理员会误以为模型已开放；同时接受
 * 历史的裸模型族（如 `nano-banana-pro`），写入时统一为 `firefly-*`。
 */
export const adobeEnabledModelIdsSchema = z
  .array(z.string().trim().min(1).max(120))
  .max(MAX_ADOBE_ENABLED_MODEL_IDS)
  .superRefine((value, ctx) => {
    for (const [index, modelId] of value.entries()) {
      if (normalizeAdobeEnabledModelId(modelId)) continue;
      ctx.addIssue({
        code: "custom",
        message: "Unsupported Adobe image model family",
        path: [index],
      });
    }
  })
  .transform((value) => normalizeAdobeEnabledModelIds(value));

/**
 * 解析请求实际会交给 Adobe 的图像模型族。
 *
 * 普通 `gpt-image-*` 请求及 force_firefly 路由在 Adobe 适配层都会落到
 * `firefly-gpt-image-2`，因此也必须以该模型检查白名单，不能因请求名不是 firefly 前缀
 * 而绕过限制。
 *
 * @param requestedModel - 客户端本次请求的模型 ID。
 * @returns 规范的 Adobe 图像模型族 ID。
 */
export function resolveAdobeImageModelId(
  requestedModel: string | null | undefined
): string {
  const normalized = String(requestedModel || "")
    .trim()
    .toLowerCase();
  // 调度层允许调用方使用历史裸 Nano Banana 模型族。仅对该自定义族补上
  // Firefly 前缀；普通裸 gpt-image 请求仍按 force_firefly 的历史语义落到
  // firefly-gpt-image-2，避免改变既有 Adobe 路由和白名单边界。
  const isBareNanoBanana = [
    "nano-banana-pro",
    "nano-banana2",
    "nano-banana",
  ].some(
    (family) => normalized === family || normalized.startsWith(`${family}-`)
  );
  const candidate =
    isBareNanoBanana && !normalized.startsWith("firefly-")
      ? `firefly-${normalized}`
      : normalized;
  const matchingModelIds = [...ADOBE_IMAGE_MODEL_IDS].sort(
    (left, right) => right.length - left.length
  );

  for (const modelId of matchingModelIds) {
    if (candidate === modelId || candidate.startsWith(`${modelId}-`)) {
      return modelId;
    }
  }
  return "firefly-gpt-image-2";
}

/** 将任意公开模型 ID 收敛为 Adobe 适配器实际使用的图片家族。 */
export function resolveAdobeImageFamily(
  requestedModel: string | null | undefined
): AdobeImageFamily {
  const family = resolveAdobeImageModelId(requestedModel).slice(
    "firefly-".length
  );
  return (
    ADOBE_IMAGE_FAMILIES.find((candidate) => candidate === family) ??
    "gpt-image-2"
  );
}

/**
 * 仅在调用方明确请求 Firefly 或裸 Nano Banana 能力时返回 Adobe 家族。
 * 普通裸 `gpt-image-*` 仍返回 null，由统一调度决定成员后再使用默认 Adobe 家族。
 */
export function pickExplicitAdobeImageFamily(
  requestedModel: string | null | undefined
): AdobeImageFamily | null {
  const normalized = String(requestedModel ?? "")
    .trim()
    .toLowerCase();
  const explicit =
    normalized.startsWith("firefly-") ||
    (normalized.startsWith("nano-banana") &&
      isAdobeImageFamilyModelId(normalized));
  return explicit ? resolveAdobeImageFamily(normalized) : null;
}

/**
 * 判断一条 Adobe 后端是否允许承接指定模型。
 *
 * 空数组和 null 都代表历史“不限图像模型”配置，保持旧后端升级后的可用性；显式非空
 * 白名单则必须精确匹配解析出的 Firefly 图像模型族。视频不复用图像白名单，而由既有
 * supportsVideo 开关控制，以免旧的图像白名单配置在升级后意外禁用视频能力。
 *
 * @param input.enabledModels - 后端已保存的图像模型白名单。
 * @param input.supportsVideo - 后端是否允许视频模型。
 * @param input.requestedModel - 客户端本次请求的模型 ID。
 * @returns 后端可以安全承接请求时返回 true。
 */
export function canAdobeBackendServeModel(input: {
  enabledModels: unknown;
  supportsVideo: boolean;
  requestedModel: string | null | undefined;
}): boolean {
  if (isFireflyVideoModelId(input.requestedModel)) {
    return input.supportsVideo;
  }

  if (!Array.isArray(input.enabledModels) || input.enabledModels.length === 0) {
    return true;
  }

  const enabledModels = normalizeAdobeEnabledModelIds(input.enabledModels);
  const requestedModel = resolveAdobeImageModelId(input.requestedModel);
  return enabledModels.includes(requestedModel);
}

/**
 * 汇总已启用 Adobe 后端可对外公布的图像模型族。
 *
 * 只要任一后端是空白名单（历史不限配置），所有图像模型族都可公布；否则仅公布各后端
 * 明确开放项的并集。调用方应先过滤停用与终态错误成员。
 *
 * @param backends - 已通过可用性过滤的 Adobe 后端模型字段。
 * @returns 去重后、按目录顺序排列的公开图像模型族 ID。
 */
export function collectAdvertisedAdobeImageModelIds(
  backends: Array<{ enabledModels?: unknown }>
): string[] {
  if (
    backends.some(({ enabledModels }) => {
      return !Array.isArray(enabledModels) || enabledModels.length === 0;
    })
  ) {
    return [...ADOBE_IMAGE_MODEL_IDS];
  }

  const enabledModelIds = new Set<string>();
  for (const backend of backends) {
    for (const modelId of normalizeAdobeEnabledModelIds(
      backend.enabledModels
    )) {
      enabledModelIds.add(modelId);
    }
  }
  return ADOBE_IMAGE_MODEL_IDS.filter((modelId) =>
    enabledModelIds.has(modelId)
  );
}
