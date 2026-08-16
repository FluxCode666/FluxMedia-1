/**
 * 视频创作面板能力投影。
 *
 * 职责：把共享静态目录或站内 UOL 能力响应转换为面板只读模型选项，并在客户端
 * 严格拒绝漂移响应。使用方：VideoCreatePanel 与 DB-free Vitest。
 */

import {
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_INPUT_COUNT,
} from "@repo/shared/image-generation/media-limits";
import {
  VIDEO_MODEL_CAPABILITIES,
  type VideoCurrentQuote,
  type VideoModelCapabilityDescriptor,
  videoListCapabilitiesOutputSchema,
} from "@repo/shared/video-generation";
import type { z } from "zod";

/** 面板选择器和输入控件消费的最小视频能力视图。 */
export type VideoCreateModel = {
  model: string;
  label: string;
  durations: readonly number[];
  aspectRatios: readonly string[];
  resolutions: readonly string[];
  defaultGenerateAudio: boolean;
  supportsAudio: boolean;
  maxFrameImages: number;
  maxReferenceImages: number;
  maxMediaInputCount: number;
  maxMediaInputBytes: number;
  billing: readonly VideoCurrentQuote[];
};

/** 视频面板允许的两种具名输入模式。 */
export type VideoCreateInputMode = "frames" | "references";

type VideoCapabilitiesOutput = z.output<
  typeof videoListCapabilitiesOutputSchema
>;
type PublicVideoCapability = VideoCapabilitiesOutput["items"][number];

/**
 * 把帧能力枚举转换为可选择的最大帧数。
 *
 * @param frames - 统一能力 DTO 的帧模式。
 * @returns 0、1 或 2；不执行 I/O，也不抛错。
 */
function resolveMaxFrameImages(
  frames: PublicVideoCapability["input"]["frames"]
): number {
  return frames === "none" ? 0 : frames === "first-only" ? 1 : 2;
}

/**
 * 把共享静态能力投影为能力请求完成前的面板占位目录。
 *
 * @param capability - 已由共享模块启动期自校验的静态能力。
 * @returns 不含供应商内部身份的面板模型视图。
 * @sideEffects 无。
 * @failure 不抛错。
 */
function fromStaticCapability(
  capability: VideoModelCapabilityDescriptor
): VideoCreateModel {
  return {
    model: capability.modelId,
    label: capability.displayName,
    durations: capability.durations,
    aspectRatios: capability.aspectRatios,
    resolutions: capability.resolutions,
    defaultGenerateAudio: capability.audio.defaultEnabled,
    supportsAudio: capability.audio.supported,
    maxFrameImages: resolveMaxFrameImages(capability.input.frames),
    maxReferenceImages: capability.input.referenceImages.maxCount,
    maxMediaInputCount: MAX_MEDIA_INPUT_COUNT,
    maxMediaInputBytes: MAX_MEDIA_INPUT_BYTES,
    billing: [],
  };
}

/**
 * 把已验证公共能力投影为面板模型视图。
 *
 * @param capability - UOL 输出 schema 验证后的单模型能力。
 * @returns 包含动态参考图上限的面板模型视图。
 * @sideEffects 无。
 * @failure 不抛错。
 */
function fromPublicCapability(
  capability: PublicVideoCapability,
  limits: VideoCapabilitiesOutput["limits"]
): VideoCreateModel {
  return {
    model: capability.model,
    label: capability.displayName,
    durations: capability.durations,
    aspectRatios: capability.aspectRatios,
    resolutions: capability.resolutions,
    defaultGenerateAudio: capability.audio.defaultEnabled,
    supportsAudio: capability.audio.supported,
    maxFrameImages: resolveMaxFrameImages(capability.input.frames),
    maxReferenceImages: capability.input.referenceImages.maxCount,
    maxMediaInputCount: limits.maxMediaInputCount,
    maxMediaInputBytes: limits.maxMediaInputBytes,
    billing: capability.billing,
  };
}

/**
 * 创建能力请求完成前的静态占位模型目录。
 *
 * @returns 全部全局合法模型；仅用于首屏稳定渲染，不表示当前分组可达。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function createStaticVideoCreateModels(): VideoCreateModel[] {
  return VIDEO_MODEL_CAPABILITIES.map(fromStaticCapability);
}

/**
 * 为模型选择可用的默认输入模式。
 *
 * @param model - 静态目录或能力接口投影出的模型；无模型时按帧模式占位。
 * @returns 支持参考图的模型返回 references，其余模型返回 frames。
 * @sideEffects 无。
 * @failure 不抛错；无输入能力的模型仍返回 frames，但面板不会渲染输入控件。
 */
export function resolveDefaultVideoCreateInputMode(
  model: VideoCreateModel | undefined
): VideoCreateInputMode {
  return model && model.maxReferenceImages > 0 ? "references" : "frames";
}

/**
 * 分别保留模型能力上限与单次请求可选择上限。
 *
 * @param model - 已验证的视频模型和独立基础设施限制。
 * @param mode - 当前首尾帧或参考图模式。
 * @returns modelMax 是管理员/模型能力值，selectableMax 另受基础设施数量限制。
 * @sideEffects 无。
 * @failure 不抛错；所有输入值已由共享 DTO schema 校验为非负整数。
 */
export function resolveVideoCreateInputLimits(
  model: VideoCreateModel,
  mode: VideoCreateInputMode
): { modelMax: number; selectableMax: number } {
  const modelMax =
    mode === "references" ? model.maxReferenceImages : model.maxFrameImages;
  return {
    modelMax,
    selectableMax: Math.min(modelMax, model.maxMediaInputCount),
  };
}

/**
 * 严格解析站内能力响应并只保留当前分组可达模型。
 *
 * @param value - fetch JSON 的不可信响应体。
 * @returns 稳定顺序的可达面板模型，动态上限不做客户端硬编码或截断。
 * @sideEffects 无。
 * @throws Error 响应形状漂移、未知字段或非法能力值时拒绝。
 */
export function parseReachableVideoCreateModels(
  value: unknown
): VideoCreateModel[] {
  const parsed = videoListCapabilitiesOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("视频模型能力响应格式无效");
  }
  return parsed.data.items
    .filter((capability) => capability.configuredReachable)
    .map((capability) => fromPublicCapability(capability, parsed.data.limits));
}
