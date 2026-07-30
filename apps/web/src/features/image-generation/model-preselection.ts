/**
 * 模型广场“立即使用”查询参数的 DB-free 收窄与授权选择器。
 *
 * 使用方是图片与视频创作页客户端接入层。本模块只解析一次性意图、从服务端已授权图片
 * 目录选择模型、解析静态视频目录并清理 URL；不读取数据库、localStorage 或旧创作状态。
 */
import {
  resolveVideoModelCapability,
  type VideoResolution,
} from "@repo/shared/video-generation";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";

export const MAX_MODEL_PRESELECTION_ID_LENGTH = 160;

export type ModelPreselectionCategory = "image" | "video";

/** 已通过查询参数边界校验的一次性模型意图。 */
export interface ModelPreselectionIntent {
  readonly category: ModelPreselectionCategory;
  readonly modelId: string;
}

/** URLSearchParams 与 Next.js ReadonlyURLSearchParams 共用的最小只读接口。 */
export interface ModelPreselectionSearchParams {
  get(name: string): string | null;
  getAll(name: string): string[];
}

/** 当前用户授权目录中的图片模型选择。 */
export interface AuthorizedImageSelection {
  readonly groupId: string;
  readonly modelId: string;
}

/** 图片授权选择器的全部显式输入。 */
export interface ResolveAuthorizedImageSelectionInput {
  readonly catalog: ImageGenerationModelCatalog;
  readonly currentGroupId: string | null;
  readonly modelId: string;
}

/** VideoCreatePanel 可直接用于初始化四个受控选择器的静态状态。 */
export interface VideoInitialSelection {
  readonly familyId: string;
  readonly duration: number;
  readonly ratio: string;
  readonly resolution: VideoResolution;
}

/**
 * 收窄模型 ID 的公共文本边界。
 *
 * @param value - 查询参数或调用方交付的未知模型文本。
 * @returns 修剪后的 1 至 160 字符模型 ID；其他输入返回 null。
 * @sideEffects 无。
 * @failure 不抛错，非法文本统一返回 null。
 */
function normalizeModelPreselectionId(value: string | null): string | null {
  const modelId = value?.trim() ?? "";
  if (
    modelId.length === 0 ||
    modelId.length > MAX_MODEL_PRESELECTION_ID_LENGTH
  ) {
    return null;
  }
  return modelId;
}

/**
 * 解析模型广场传入的一次性图片或视频意图。
 *
 * @param searchParams - 浏览器或 Next.js 提供的只读查询参数。
 * @returns category/model 各唯一且合法时返回规范化意图，否则返回 null。
 * @sideEffects 无；不修改查询参数，也不读取当前用户或目录。
 * @failure 缺失、重复、未知 category、空模型或超长模型统一返回 null。
 */
export function parseModelPreselectionIntent(
  searchParams: ModelPreselectionSearchParams
): ModelPreselectionIntent | null {
  if (
    searchParams.getAll("category").length !== 1 ||
    searchParams.getAll("model").length !== 1
  ) {
    return null;
  }
  const category = searchParams.get("category");
  if (category !== "image" && category !== "video") return null;
  const modelId = normalizeModelPreselectionId(searchParams.get("model"));
  return modelId ? { category, modelId } : null;
}

/**
 * 从当前用户已授权的图片目录中解析预选模型和后端分组。
 *
 * 优先级固定为当前组、首个 isDefault 组、目录中的其余组；每个候选都必须同时存在目标
 * 模型且声明 generate 能力。返回目录中的规范模型 ID，不信任查询参数自行构造选择。
 *
 * @param input - 服务端授权目录、当前组和请求模型 ID。
 * @returns 首个授权选择；模型不存在或所有命中项均不可生成时返回 null。
 * @sideEffects 无；不修改目录或持久化选择。
 * @failure 非法模型 ID 或空目录安全返回 null。
 */
export function resolveAuthorizedImageSelection(
  input: ResolveAuthorizedImageSelectionInput
): AuthorizedImageSelection | null {
  const requestedModelId = normalizeModelPreselectionId(input.modelId);
  if (!requestedModelId) return null;

  const currentGroup = input.currentGroupId
    ? (input.catalog.groups.find(
        (group) => group.id === input.currentGroupId
      ) ?? null)
    : null;
  const defaultGroup =
    input.catalog.groups.find((group) => group.isDefault) ?? null;
  const orderedGroups = [
    ...(currentGroup ? [currentGroup] : []),
    ...(defaultGroup ? [defaultGroup] : []),
    ...input.catalog.groups,
  ];
  const visitedGroupIds = new Set<string>();

  for (const group of orderedGroups) {
    if (visitedGroupIds.has(group.id)) continue;
    visitedGroupIds.add(group.id);
    const model = group.models.find(
      (candidate) =>
        candidate.id === requestedModelId && candidate.capabilities.generate
    );
    if (model) return { groupId: group.id, modelId: model.id };
  }
  return null;
}

/**
 * 将静态合法的视频模型 ID 收窄为 VideoCreatePanel 初始选择。
 *
 * @param modelId - 模型广场传入且已通过基本长度校验的视频模型 ID。
 * @returns 真实能力目录命中时返回模型与默认参数选择，否则返回 null。
 * @sideEffects 无；不执行用户、套餐、后端可达性或最终服务端授权。
 * @failure 空值、超长、图片模型或已移除视频模型统一返回 null。
 */
export function resolveVideoInitialSelection(
  modelId: string
): VideoInitialSelection | null {
  const normalizedModelId = normalizeModelPreselectionId(modelId);
  if (!normalizedModelId) return null;
  const resolved = resolveVideoModelCapability(normalizedModelId);
  if (!resolved.ok) return null;
  const model = resolved.capability;
  const duration = model.durations[0];
  const ratio = model.aspectRatios[0];
  const resolution = model.resolutions[0];
  if (
    duration === undefined ||
    ratio === undefined ||
    resolution === undefined
  ) {
    return null;
  }
  return {
    familyId: model.modelId,
    duration,
    ratio,
    resolution,
  };
}

/**
 * 从当前 URL 移除已消费的一次性模型预选参数。
 *
 * @param currentUrl - 浏览器当前完整 URL。
 * @returns 保留 pathname、其他查询参数及 hash 的同源相对 URL。
 * @sideEffects 无；函数克隆输入 URL，不修改调用方对象，也不执行导航。
 * @failure URL 已由调用方构造并保证合法；参数缺失时返回等价相对 URL。
 */
export function removePreselectionParams(currentUrl: URL): string {
  const nextUrl = new URL(currentUrl.toString());
  nextUrl.searchParams.delete("category");
  nextUrl.searchParams.delete("model");
  return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
}
