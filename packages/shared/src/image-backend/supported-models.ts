/**
 * API 后端支持模型列表的共享约束与匹配规则。
 *
 * 使用方：图像后端池保存/调度逻辑、UOL 输入 schema 与外接 `/v1/models` 列表。
 * 关键依赖：Zod；本模块不依赖数据库或网络，确保管理端与运行时采用同一语义。
 */
import { z } from "zod";

import {
  normalizeVideoModelId,
  VIDEO_MODEL_IDS,
} from "../video-generation/contracts";

/** 单个媒体后端最多声明的真实模型 ID 数量；限制异常 JSON 体积。 */
export const MAX_SUPPORTED_MODEL_IDS = 1_000;

/** 后端模型能力数组的共享边界。 */
export const supportedModelIdsSchema = z
  .array(z.string().trim().min(1).max(120))
  .max(MAX_SUPPORTED_MODEL_IDS);

/**
 * 将一个模型能力键规范为平台公开格式。
 *
 * @param value 来自配置、数据库或请求的未知模型值。
 * @returns 去空白后的真实 ID；不转换图像别名或供应商前缀，旧视频身份保持原样以便拒绝。
 * @sideEffects 无。
 * @failure 不抛错；过长、空白或非字符串输入返回 null。
 */
export function normalizeSupportedModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120) return null;
  const videoModelId = normalizeVideoModelId(trimmed);
  if (videoModelId) return videoModelId;
  if (isLegacyVideoModelId(trimmed)) return trimmed;
  return trimmed;
}

/**
 * 将持久化历史中的模型身份规范为只读展示格式。
 *
 * @param value - 历史任务、用量记录或异步任务中的模型值。
 * @returns 去空白并移除历史 Firefly 前缀的展示 ID；非法值返回 null。
 * @sideEffects 无。
 * @failure 不抛错；本函数不得用于新请求、成员保存或调度资格校验。
 */
export function normalizeHistoricalModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120) return null;
  return trimmed.replace(/^firefly-/i, "");
}

const VIDEO_MODEL_IDS_BY_LENGTH = [...VIDEO_MODEL_IDS].sort(
  (left, right) => right.length - left.length
);

/**
 * 判断模型值是否是必须拒绝的旧视频身份。
 *
 * @param value - 成员保存、数据库或目录读取出的未知模型值。
 * @returns `firefly-` 视频前缀、参数复合 ID、历史别名或真实 ID 派生的目录外变体返回 true；真实 ID 与图像 ID 返回 false。
 * @sideEffects 无。
 * @failure 不抛错；只识别由现有真实模型族派生的冻结旧形状。
 */
export function isLegacyVideoModelId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalizeVideoModelId(normalized)) return false;
  const hasFireflyPrefix = normalized.startsWith("firefly-");
  const candidate = hasFireflyPrefix
    ? normalized.slice("firefly-".length)
    : normalized;
  if (hasFireflyPrefix && normalizeVideoModelId(candidate)) return true;

  for (const modelId of VIDEO_MODEL_IDS_BY_LENGTH) {
    const prefix = `${modelId}-`;
    if (!candidate.startsWith(prefix)) continue;
    return true;
  }
  return false;
}

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
    const modelId = normalizeSupportedModelId(valueItem);
    if (!modelId) continue;
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
 * 成员能力必须显式声明；空列表不再充当通配符。匹配只做 trim 与大小写规范后的精确
 * 比较，不解析视频参数、前缀或供应商家族。
 *
 * @param supportedModelIds - 后端已保存的支持模型列表。
 * @param requestedModelId - 客户端本次请求的模型 ID。
 * @returns 后端可承接该请求时返回 true。
 */
export function supportsRequestedModel(
  supportedModelIds: unknown,
  requestedModelId: string | null | undefined
): boolean {
  const requested = normalizeSupportedModelId(requestedModelId)?.toLowerCase();
  const supported = normalizeSupportedModelIds(supportedModelIds);
  if (!requested || supported.length === 0) return false;
  return supported.some((modelId) => modelId.toLowerCase() === requested);
}

/**
 * 汇总启用 API 后端可向外公布的模型 ID。
 *
 * 明确配置的列表优先；旧后端没有列表时仅以其默认模型作为目录兼容回退。运行时调度
 * 不再把空能力列表视为通配符，目录回退也不会放行旧视频身份。
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
    const modelId = normalizeSupportedModelId(value);
    if (!modelId || isLegacyVideoModelId(modelId)) return;
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
