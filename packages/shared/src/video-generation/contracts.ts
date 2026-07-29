/**
 * 视频生成模型与静态能力的基础契约。
 *
 * 使用方：视频能力目录、动态覆盖、UOL、模型配置和模型广场。该模块只依赖 Zod，
 * 不读取数据库或供应商配置；公开模型身份始终是精确真实 ID，不做前缀或复合 ID 兼容。
 */
import { z } from "zod";

/** 平台允许进入视频运行时的 13 个真实模型 ID。 */
export const VIDEO_MODEL_IDS = [
  "sora2",
  "sora2-pro",
  "veo31",
  "veo31-fast",
  "veo31-ref",
  "kling-o3",
  "kling3",
  "kling3-omni",
  "runway-gen45",
  "ray314",
  "ray314-hdr",
  "seedance2",
  "seedance2-fast",
] as const;

/** 视频模型真实身份；不包含时长、比例、分辨率或供应商前缀。 */
export type VideoModelId = (typeof VIDEO_MODEL_IDS)[number];

/** 精确真实模型 ID schema；不会 trim、改大小写、去前缀或解析历史别名。 */
export const videoModelIdSchema = z.enum(VIDEO_MODEL_IDS);

/** 所有内置视频描述符可使用的规范宽高比字面量。 */
export const VIDEO_ASPECT_RATIOS = [
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "21:9",
] as const;

/** 视频请求公开宽高比。 */
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];

/** 严格宽高比 schema；公开参数名由调用方固定为 aspectRatio。 */
export const videoAspectRatioSchema = z.enum(VIDEO_ASPECT_RATIOS);

/** 所有内置视频描述符可使用的小写分辨率字面量。 */
export const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;

/** 视频请求公开分辨率。 */
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

/** 严格小写分辨率 schema；不接受供应商内部尺寸或大小写别名。 */
export const videoResolutionSchema = z.enum(VIDEO_RESOLUTIONS);

/** 首尾帧输入能力；尾帧能力只通过 first-and-optional-last 暴露。 */
export const videoFrameInputCapabilitySchema = z.enum([
  "none",
  "first-only",
  "first-and-optional-last",
]);

/** 首尾帧输入能力。 */
export type VideoFrameInputCapability = z.infer<
  typeof videoFrameInputCapabilitySchema
>;

/** 当前计费 family 与真实模型一一对应，但由描述符声明而非价格模块复制清单。 */
export type VideoBillingFamily = VideoModelId;

/** 单个真实视频模型的静态参数、输入、声音和计费能力。 */
export type VideoModelCapabilityDescriptor = {
  readonly modelId: VideoModelId;
  readonly displayName: string;
  readonly billingFamily: VideoBillingFamily;
  readonly durations: readonly number[];
  readonly aspectRatios: readonly VideoAspectRatio[];
  readonly resolutions: readonly VideoResolution[];
  readonly input: {
    readonly frames: VideoFrameInputCapability;
    readonly referenceImages: {
      readonly maxCount: number;
      readonly configurable: boolean;
    };
    readonly framesAndReferencesMutuallyExclusive: boolean;
  };
  readonly audio: {
    readonly supported: boolean;
    readonly defaultEnabled: boolean;
  };
};

const positiveSafeDurationSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/**
 * 校验描述符内部跨字段不变量。
 *
 * @param descriptor - 已通过基础字段校验的静态描述符。
 * @param context - Zod 精细校验上下文。
 * @returns 无返回值；发现默认声音或输入模式矛盾时追加结构化 issue。
 * @sideEffects 不修改描述符。
 * @failure 不抛错，由外层 Zod parse 汇总错误。
 */
function addVideoCapabilityDescriptorIssues(
  descriptor: {
    audio: { supported: boolean; defaultEnabled: boolean };
    input: {
      frames: VideoFrameInputCapability;
      referenceImages: { maxCount: number; configurable: boolean };
      framesAndReferencesMutuallyExclusive: boolean;
    };
  },
  context: z.RefinementCtx
): void {
  if (descriptor.audio.defaultEnabled && !descriptor.audio.supported) {
    context.addIssue({
      code: "custom",
      path: ["audio", "defaultEnabled"],
      message: "默认开启声音的模型必须声明声音能力",
    });
  }

  const supportsFrames = descriptor.input.frames !== "none";
  const supportsReferences = descriptor.input.referenceImages.maxCount > 0;
  if (descriptor.input.referenceImages.configurable && !supportsReferences) {
    context.addIssue({
      code: "custom",
      path: ["input", "referenceImages", "configurable"],
      message: "可配置参考图上限必须具有正数默认值",
    });
  }
  if (
    descriptor.input.framesAndReferencesMutuallyExclusive !==
    (supportsFrames && supportsReferences)
  ) {
    context.addIssue({
      code: "custom",
      path: ["input", "framesAndReferencesMutuallyExclusive"],
      message: "同时支持帧和参考图的模型必须声明两种模式互斥",
    });
  }
}

/** 静态视频模型描述符 schema；用于启动期自校验和测试夹具收窄。 */
export const videoModelCapabilityDescriptorSchema = z
  .object({
    modelId: videoModelIdSchema,
    displayName: z.string().trim().min(1).max(160),
    billingFamily: videoModelIdSchema,
    durations: z.array(positiveSafeDurationSchema).min(1),
    aspectRatios: z.array(videoAspectRatioSchema).min(1),
    resolutions: z.array(videoResolutionSchema).min(1),
    input: z
      .object({
        frames: videoFrameInputCapabilitySchema,
        referenceImages: z
          .object({
            maxCount: nonNegativeSafeCountSchema,
            configurable: z.boolean(),
          })
          .strict(),
        framesAndReferencesMutuallyExclusive: z.boolean(),
      })
      .strict(),
    audio: z
      .object({
        supported: z.boolean(),
        defaultEnabled: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine(addVideoCapabilityDescriptorIssues);

/** 可定位到具体公开参数的能力错误码。 */
export type VideoCapabilityErrorCode =
  | "unsupported_model"
  | "unsupported_duration"
  | "unsupported_aspect_ratio"
  | "unsupported_resolution";

/** 参数能力失败结果；allowed 始终来自目标描述符或真实模型目录。 */
export type VideoCapabilityError = {
  readonly code: VideoCapabilityErrorCode;
  readonly field: "model" | "duration" | "aspectRatio" | "resolution";
  readonly message: string;
  readonly received: unknown;
  readonly allowed: readonly (string | number)[];
};

/** 静态能力解析和参数校验共享的判别联合。 */
export type VideoCapabilityResult =
  | { readonly ok: true; readonly capability: VideoModelCapabilityDescriptor }
  | { readonly ok: false; readonly error: VideoCapabilityError };
