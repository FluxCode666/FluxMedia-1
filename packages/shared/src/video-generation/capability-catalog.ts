/**
 * 真实视频模型静态能力目录。
 *
 * 使用方：动态能力覆盖、UOL 参数校验、账号池模型选择、模型广场与视频计费。目录只描述
 * 平台公开参数和输入能力；上游 model、version、engine 与像素尺寸属于供应商适配层。
 */
import {
  VIDEO_MODEL_IDS,
  type VideoCapabilityError,
  type VideoCapabilityResult,
  type VideoModelCapabilityDescriptor,
  type VideoModelId,
  videoModelCapabilityDescriptorSchema,
  videoModelIdSchema,
} from "./contracts";

const THREE_TO_FIFTEEN_SECONDS = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
] as const;
const FOUR_TO_FIFTEEN_SECONDS = [
  4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
] as const;
const ALL_PUBLIC_ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "21:9",
] as const;

/** 以真实模型 ID 为唯一键的静态能力事实源。 */
export const VIDEO_MODEL_CAPABILITY_CATALOG = {
  sora2: {
    modelId: "sora2",
    displayName: "Sora 2",
    billingFamily: "sora2",
    durations: [4, 8, 12],
    aspectRatios: ["9:16", "16:9"],
    resolutions: ["720p"],
    input: {
      frames: "first-only",
      referenceImages: { maxCount: 0, configurable: false },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: false, defaultEnabled: false },
  },
  "sora2-pro": {
    modelId: "sora2-pro",
    displayName: "Sora 2 Pro",
    billingFamily: "sora2-pro",
    durations: [4, 8, 12],
    aspectRatios: ["9:16", "16:9"],
    resolutions: ["720p"],
    input: {
      frames: "first-only",
      referenceImages: { maxCount: 0, configurable: false },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: false, defaultEnabled: false },
  },
  veo31: {
    modelId: "veo31",
    displayName: "Veo 3.1",
    billingFamily: "veo31",
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    input: {
      frames: "first-and-optional-last",
      referenceImages: { maxCount: 0, configurable: false },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: false, defaultEnabled: false },
  },
  "veo31-fast": {
    modelId: "veo31-fast",
    displayName: "Veo 3.1 Fast",
    billingFamily: "veo31-fast",
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    input: {
      frames: "first-and-optional-last",
      referenceImages: { maxCount: 0, configurable: false },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: false, defaultEnabled: false },
  },
  "veo31-ref": {
    modelId: "veo31-ref",
    displayName: "Veo 3.1 Reference",
    billingFamily: "veo31-ref",
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    input: {
      frames: "none",
      referenceImages: { maxCount: 3, configurable: false },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: false, defaultEnabled: false },
  },
  "kling-o3": {
    modelId: "kling-o3",
    displayName: "Kling O3",
    billingFamily: "kling-o3",
    durations: [5, 15],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p"],
    input: {
      frames: "first-and-optional-last",
      referenceImages: { maxCount: 0, configurable: false },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: false, defaultEnabled: false },
  },
  kling3: {
    modelId: "kling3",
    displayName: "Kling 3.0",
    billingFamily: "kling3",
    durations: THREE_TO_FIFTEEN_SECONDS,
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    input: {
      frames: "first-and-optional-last",
      referenceImages: { maxCount: 0, configurable: false },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: true, defaultEnabled: true },
  },
  "kling3-omni": {
    modelId: "kling3-omni",
    displayName: "Kling 3.0 Omni",
    billingFamily: "kling3-omni",
    durations: THREE_TO_FIFTEEN_SECONDS,
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    input: {
      frames: "first-and-optional-last",
      referenceImages: { maxCount: 3, configurable: false },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: true, defaultEnabled: false },
  },
  "runway-gen45": {
    modelId: "runway-gen45",
    displayName: "Runway Gen-4.5",
    billingFamily: "runway-gen45",
    durations: [5, 8, 10],
    aspectRatios: ["16:9"],
    resolutions: ["720p"],
    input: {
      frames: "none",
      referenceImages: { maxCount: 0, configurable: false },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: false, defaultEnabled: false },
  },
  ray314: {
    modelId: "ray314",
    displayName: "Ray 3.14",
    billingFamily: "ray314",
    durations: [5, 10],
    aspectRatios: ALL_PUBLIC_ASPECT_RATIOS,
    resolutions: ["4k", "1080p", "720p"],
    input: {
      frames: "none",
      referenceImages: { maxCount: 0, configurable: false },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: false, defaultEnabled: false },
  },
  "ray314-hdr": {
    modelId: "ray314-hdr",
    displayName: "Ray 3.14 HDR",
    billingFamily: "ray314-hdr",
    durations: [5],
    aspectRatios: ALL_PUBLIC_ASPECT_RATIOS,
    resolutions: ["4k", "1080p", "720p"],
    input: {
      frames: "none",
      referenceImages: { maxCount: 0, configurable: false },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: false, defaultEnabled: false },
  },
  seedance2: {
    modelId: "seedance2",
    displayName: "Seedance 2.0",
    billingFamily: "seedance2",
    durations: FOUR_TO_FIFTEEN_SECONDS,
    aspectRatios: ALL_PUBLIC_ASPECT_RATIOS,
    resolutions: ["1080p", "720p", "480p"],
    input: {
      frames: "first-and-optional-last",
      referenceImages: { maxCount: 10, configurable: true },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: true, defaultEnabled: false },
  },
  "seedance2-fast": {
    modelId: "seedance2-fast",
    displayName: "Seedance 2.0 Fast",
    billingFamily: "seedance2-fast",
    durations: FOUR_TO_FIFTEEN_SECONDS,
    aspectRatios: ALL_PUBLIC_ASPECT_RATIOS,
    resolutions: ["720p", "480p"],
    input: {
      frames: "first-and-optional-last",
      referenceImages: { maxCount: 10, configurable: true },
      framesAndReferencesMutuallyExclusive: true,
    },
    audio: { supported: true, defaultEnabled: false },
  },
} as const satisfies Readonly<
  Record<VideoModelId, VideoModelCapabilityDescriptor>
>;

// WHY：描述符是运行时参数合法性的唯一来源，启动期必须验证跨字段不变量，不能把静态
// 数据错误推迟到具体请求或供应商调用时才暴露。
for (const modelId of VIDEO_MODEL_IDS) {
  const capability = VIDEO_MODEL_CAPABILITY_CATALOG[modelId];
  videoModelCapabilityDescriptorSchema.parse(capability);
  if (capability.modelId !== modelId) {
    throw new Error(`视频能力目录键与模型 ID 不一致: ${modelId}`);
  }
}

/** 按公开顺序排列的全部真实视频模型能力。 */
export const VIDEO_MODEL_CAPABILITIES = Object.freeze(
  VIDEO_MODEL_IDS.map((modelId) => VIDEO_MODEL_CAPABILITY_CATALOG[modelId])
);

/**
 * 读取已通过类型收窄的静态模型能力。
 *
 * @param modelId - 精确真实视频模型 ID。
 * @returns 对应的只读静态描述符。
 * @sideEffects 无。
 * @failure 不抛错；调用方必须先在外部边界使用 videoModelIdSchema 收窄。
 */
export function getVideoModelCapability(
  modelId: VideoModelId
): VideoModelCapabilityDescriptor {
  return VIDEO_MODEL_CAPABILITY_CATALOG[modelId];
}

/**
 * 将未受信任模型身份解析为静态能力。
 *
 * @param modelId - 请求、配置或数据库读取出的未知模型值。
 * @returns 精确真实 ID 返回能力；旧前缀、复合 ID、别名和未知值返回结构化错误。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function resolveVideoModelCapability(
  modelId: unknown
): VideoCapabilityResult {
  const parsed = videoModelIdSchema.safeParse(modelId);
  if (parsed.success) {
    return { ok: true, capability: getVideoModelCapability(parsed.data) };
  }
  return {
    ok: false,
    error: {
      code: "unsupported_model",
      field: "model",
      message: "Unsupported video model",
      received: modelId,
      allowed: VIDEO_MODEL_IDS,
    },
  };
}

/**
 * 创建指向单个模型参数的结构化能力错误。
 *
 * @param code - 稳定错误码。
 * @param field - 公开参数名。
 * @param received - 调用方提供的原始值。
 * @param allowed - 描述符声明的合法集合。
 * @returns 可由 UOL 或传输层映射的能力错误。
 * @sideEffects 无。
 * @failure 不抛错。
 */
function createParameterCapabilityError(
  code: VideoCapabilityError["code"],
  field: VideoCapabilityError["field"],
  received: unknown,
  allowed: readonly (string | number)[]
): VideoCapabilityError {
  return {
    code,
    field,
    message: `Unsupported video ${field}`,
    received,
    allowed,
  };
}

/**
 * 按目标真实模型的描述符校验核心生成参数。
 *
 * @param input - 未受信任模型身份及显式 duration、aspectRatio、resolution。
 * @returns 全部参数合法时返回描述符，否则返回第一个可定位的结构化能力错误。
 * @sideEffects 无。
 * @failure 不抛错；类型错误与不在合法集合内使用同一稳定参数错误码。
 */
export function validateVideoModelParameters(input: {
  model: unknown;
  duration: unknown;
  aspectRatio: unknown;
  resolution: unknown;
}): VideoCapabilityResult {
  const resolved = resolveVideoModelCapability(input.model);
  if (!resolved.ok) return resolved;

  const capability = resolved.capability;
  if (
    typeof input.duration !== "number" ||
    !capability.durations.includes(input.duration)
  ) {
    return {
      ok: false,
      error: createParameterCapabilityError(
        "unsupported_duration",
        "duration",
        input.duration,
        capability.durations
      ),
    };
  }
  if (
    typeof input.aspectRatio !== "string" ||
    !capability.aspectRatios.some((value) => value === input.aspectRatio)
  ) {
    return {
      ok: false,
      error: createParameterCapabilityError(
        "unsupported_aspect_ratio",
        "aspectRatio",
        input.aspectRatio,
        capability.aspectRatios
      ),
    };
  }
  if (
    typeof input.resolution !== "string" ||
    !capability.resolutions.some((value) => value === input.resolution)
  ) {
    return {
      ok: false,
      error: createParameterCapabilityError(
        "unsupported_resolution",
        "resolution",
        input.resolution,
        capability.resolutions
      ),
    };
  }
  return resolved;
}
