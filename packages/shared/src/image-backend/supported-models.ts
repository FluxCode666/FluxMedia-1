/**
 * API 后端支持模型列表的共享约束与匹配规则。
 *
 * 使用方：图像后端池保存/调度逻辑、UOL 输入 schema 与外接 `/v1/models` 列表。
 * 关键依赖：Zod；本模块不依赖数据库或网络，确保管理端与运行时采用同一语义。
 */
import { z } from "zod";

/** 单个媒体后端最多声明的完整模型 ID 数量；容纳组合式视频目录并限制 JSON 体积。 */
export const MAX_SUPPORTED_MODEL_IDS = 1_000;

/** 后端模型能力数组的共享边界。 */
export const supportedModelIdsSchema = z
  .array(z.string().trim().min(1).max(120))
  .max(MAX_SUPPORTED_MODEL_IDS);

/**
 * 标准化模型 ID 列表，去除空白和大小写重复项，同时保留首次配置的原始展示形式。
 *
 * @param value - 来自管理端输入或数据库 JSON 列的未知值。
 * @returns 可安全用于持久化、展示和匹配的模型 ID 列表。
 */
export function normalizeSupportedModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const valueItem of value) {
    if (typeof valueItem !== "string") continue;
    const modelId = valueItem.trim();
    if (!modelId || modelId.length > 120) continue;
    const key = modelId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(modelId);
  }
  return ids.slice(0, MAX_SUPPORTED_MODEL_IDS);
}

/**
 * 判断 API 后端是否声明支持本次请求的模型。
 *
 * 空列表代表历史配置尚未声明能力，为兼容既有后端而不限制调度；一旦配置至少一个模型，
 * 则只允许大小写无关的精确匹配，避免把请求发给未声明支持的上游。
 *
 * @param supportedModelIds - 后端已保存的支持模型列表。
 * @param requestedModelId - 客户端本次请求的模型 ID。
 * @returns 后端可承接该请求时返回 true。
 */
export function supportsRequestedModel(
  supportedModelIds: unknown,
  requestedModelId: string | null | undefined
): boolean {
  const requested = requestedModelId?.trim().toLowerCase();
  const supported = normalizeSupportedModelIds(supportedModelIds);
  if (!requested || supported.length === 0) return true;
  return supported.some((modelId) => modelId.toLowerCase() === requested);
}

/**
 * 汇总启用 API 后端可向外公布的模型 ID。
 *
 * 明确配置的列表优先；旧后端没有列表时才以其默认模型作为兼容回退。空列表且无默认
 * 模型的后端可继续承接未限制的请求，但不会把不可枚举的能力伪装成公共模型。
 *
 * @param backends - 已通过启用/健康条件过滤的 API 后端模型字段。
 * @returns 去重后、保留首次配置顺序的公开模型 ID 列表。
 */
export function collectAdvertisedModelIds(
  backends: Array<{ model?: unknown; supportedModelIds?: unknown }>
): string[] {
  const modelIds: string[] = [];
  const seen = new Set<string>();
  const addModelId = (value: unknown) => {
    if (typeof value !== "string") return;
    const modelId = value.trim();
    if (!modelId || modelId.length > 120) return;
    const key = modelId.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    modelIds.push(modelId);
  };

  for (const backend of backends) {
    const supported = normalizeSupportedModelIds(backend.supportedModelIds);
    if (supported.length) {
      for (const modelId of supported) addModelId(modelId);
      continue;
    }
    addModelId(backend.model);
  }

  return modelIds;
}
