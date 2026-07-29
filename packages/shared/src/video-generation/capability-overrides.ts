/**
 * 视频模型动态能力覆盖契约与有效能力解析。
 *
 * 使用方：系统设置、模型配置 operation、能力发现与生成校验。仅描述符明确声明可配置的
 * 模型能覆盖参考图上限；缺失设置使用默认工厂，存在脏设置则由 Zod 显式失败。
 */
import { z } from "zod";

import {
  getVideoModelCapability,
  VIDEO_MODEL_CAPABILITIES,
} from "./capability-catalog";
import {
  VIDEO_MODEL_IDS,
  type VideoModelCapabilityDescriptor,
  type VideoModelId,
  videoModelIdSchema,
} from "./contracts";

/** 视频模型能力覆盖持久化格式版本。 */
export const VIDEO_MODEL_CAPABILITY_OVERRIDES_VERSION = 1 as const;

const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

/** 单个真实模型当前允许覆盖的动态能力字段。 */
export const videoModelCapabilityOverrideSchema = z
  .object({
    maxReferenceImages: positiveSafeIntegerSchema,
  })
  .strict();

const videoModelCapabilityOverrideRecordSchema = z.partialRecord(
  videoModelIdSchema,
  videoModelCapabilityOverrideSchema
);

/**
 * 拒绝描述符未声明可配置的模型覆盖。
 *
 * @param value - 已完成基础键和值校验的覆盖设置。
 * @param context - Zod 精细校验上下文。
 * @returns 无返回值；不可配置模型存在覆盖时追加 issue。
 * @sideEffects 无。
 * @failure 不抛错，由外层 Zod parse 汇总错误。
 */
function addConfigurableModelIssues(
  value: {
    byModel: Partial<
      Record<VideoModelId, { maxReferenceImages: number } | undefined>
    >;
  },
  context: z.RefinementCtx
): void {
  for (const modelId of VIDEO_MODEL_IDS) {
    if (value.byModel[modelId] === undefined) continue;
    const capability = getVideoModelCapability(modelId);
    if (capability.input.referenceImages.configurable) continue;
    context.addIssue({
      code: "custom",
      path: ["byModel", modelId],
      message: "This video model does not allow capability overrides",
    });
  }
}

/** 版本化全局视频模型能力覆盖设置。 */
export const videoModelCapabilityOverridesSchema = z
  .object({
    version: z.literal(VIDEO_MODEL_CAPABILITY_OVERRIDES_VERSION),
    byModel: videoModelCapabilityOverrideRecordSchema,
  })
  .strict()
  .superRefine(addConfigurableModelIssues);

/** 视频模型动态能力覆盖设置。 */
export type VideoModelCapabilityOverrides = z.infer<
  typeof videoModelCapabilityOverridesSchema
>;

/**
 * 创建相互隔离的空覆盖设置。
 *
 * @returns 新的 v1 设置对象；Seedance 缺项由静态描述符解释为默认 10。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function createDefaultVideoModelCapabilityOverrides(): VideoModelCapabilityOverrides {
  return {
    version: VIDEO_MODEL_CAPABILITY_OVERRIDES_VERSION,
    byModel: {},
  };
}

/**
 * 收窄系统设置中的动态能力覆盖。
 *
 * @param value - 数据库或缓存读取出的未知 JSON；null/undefined 代表设置尚未初始化。
 * @returns 缺行时返回新的默认设置；合法行返回严格解析结果。
 * @sideEffects 无。
 * @throws ZodError - 设置行存在但版本、键或数值损坏时显式失败，不回退默认值。
 */
export function parseVideoModelCapabilityOverrides(
  value: unknown
): VideoModelCapabilityOverrides {
  if (value === null || value === undefined) {
    return createDefaultVideoModelCapabilityOverrides();
  }
  return videoModelCapabilityOverridesSchema.parse(value);
}

/**
 * 把已解析覆盖投影到单个静态描述符。
 *
 * @param capability - 真实模型静态描述符。
 * @param overrides - 已通过严格 schema 校验的全局覆盖。
 * @returns 未配置时复用静态描述符；配置时返回只替换参考图上限的新对象。
 * @sideEffects 不修改静态目录或覆盖对象。
 * @failure 不抛错；不可配置模型无法通过覆盖 schema，因此不会进入替换分支。
 */
export function applyVideoModelCapabilityOverrides(
  capability: VideoModelCapabilityDescriptor,
  overrides: VideoModelCapabilityOverrides
): VideoModelCapabilityDescriptor {
  const override = overrides.byModel[capability.modelId];
  if (!override) return capability;
  return {
    ...capability,
    input: {
      ...capability.input,
      referenceImages: {
        ...capability.input.referenceImages,
        maxCount: override.maxReferenceImages,
      },
    },
  };
}

/**
 * 解析单个真实模型的当前有效能力。
 *
 * @param modelId - 必须是精确真实 ID；旧前缀、复合 ID 与别名均失败。
 * @param value - 未受信任的能力覆盖设置或缺行值。
 * @returns 应用动态参考图上限后的能力描述符。
 * @sideEffects 无。
 * @throws ZodError - 模型 ID 或已存在设置不合法时显式失败。
 */
export function resolveEffectiveVideoModelCapability(
  modelId: unknown,
  value: unknown
): VideoModelCapabilityDescriptor {
  const parsedModelId = videoModelIdSchema.parse(modelId);
  const overrides = parseVideoModelCapabilityOverrides(value);
  return applyVideoModelCapabilityOverrides(
    getVideoModelCapability(parsedModelId),
    overrides
  );
}

/**
 * 解析全部真实模型的当前有效能力。
 *
 * @param value - 未受信任的能力覆盖设置或缺行值。
 * @returns 按公开模型顺序排列的新数组；未覆盖描述符保持只读共享引用。
 * @sideEffects 无。
 * @throws ZodError - 已存在设置不合法时整体失败，避免部分模型静默回退。
 */
export function resolveEffectiveVideoModelCapabilities(
  value: unknown
): VideoModelCapabilityDescriptor[] {
  const overrides = parseVideoModelCapabilityOverrides(value);
  return VIDEO_MODEL_CAPABILITIES.map((capability) =>
    applyVideoModelCapabilityOverrides(capability, overrides)
  );
}
