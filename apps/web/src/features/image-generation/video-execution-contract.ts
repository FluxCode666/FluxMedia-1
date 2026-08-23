/**
 * 视频任务创建快照与 worker 恢复事实的 DB-free 契约。
 *
 * 使用方：UOL binding 在创建时形成快照，video-operations 在创建和恢复时用同一解析器
 * 校验真实模型、独立参数、有效声音和创建时参考图上限，不查询当前动态配置。
 */
import {
  getVideoOutputSize,
  type VideoAspectRatio,
  type VideoBillingFamily,
  type VideoFrameInputCapability,
  type VideoModelId,
  type VideoResolution,
  validateVideoModelParameters,
  videoAspectRatioSchema,
  videoResolutionSchema,
} from "@repo/shared/video-generation";
import {
  LEGACY_VIDEO_CAPABILITY_SNAPSHOT_VERSION as SHARED_LEGACY_VIDEO_CAPABILITY_SNAPSHOT_VERSION,
  VIDEO_BILLING_CAPABILITY_SNAPSHOT_VERSION,
} from "@repo/shared/video-generation/video-billing-snapshot";
import { z } from "zod";

/** 升级前允许没有账单快照的历史能力版本。 */
export const LEGACY_VIDEO_CAPABILITY_SNAPSHOT_VERSION =
  SHARED_LEGACY_VIDEO_CAPABILITY_SNAPSHOT_VERSION;

/** 新任务能力快照版本；该版本必须与账单快照在同一次 insert 中创建。 */
export const VIDEO_CAPABILITY_SNAPSHOT_VERSION =
  VIDEO_BILLING_CAPABILITY_SNAPSHOT_VERSION;

/** worker 可读取的全部能力快照版本。 */
export type VideoCapabilitySnapshotVersion =
  | typeof LEGACY_VIDEO_CAPABILITY_SNAPSHOT_VERSION
  | typeof VIDEO_CAPABILITY_SNAPSHOT_VERSION;

/** 创建时固定的动态能力事实。 */
export type VideoCapabilitySnapshot = {
  version: VideoCapabilitySnapshotVersion;
  modelConfigurationRevision: number;
  maxReferenceImages: number;
  customModel?: {
    modelId: string;
    supportedResolutions: string[];
  };
};

/**
 * 判断未知 JSON 版本是否属于当前可恢复范围。
 *
 * @param value - 能力快照中的未知版本值。
 * @returns v1 历史版本或 v2 当前版本时完成类型收窄。
 * @sideEffects 无。
 * @failure 不抛错。
 */
function isVideoCapabilitySnapshotVersion(
  value: unknown
): value is VideoCapabilitySnapshotVersion {
  return (
    value === LEGACY_VIDEO_CAPABILITY_SNAPSHOT_VERSION ||
    value === VIDEO_CAPABILITY_SNAPSHOT_VERSION
  );
}

/** worker 可直接消费的规范任务事实。 */
export type VideoExecutionContract = {
  model: VideoModelId | string;
  duration: number;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution | string;
  billingFamily: VideoBillingFamily | string;
  effectiveAudio: boolean;
  frameCapability: VideoFrameInputCapability;
  maxReferenceImages: number;
  modelConfigurationRevision: number;
  /** 自定义视频模型只能由 API 成员执行；内置模型保留 API/Adobe Direct 共存。 */
  requiredMemberType?: "api";
};

/**
 * 校验非负安全整数，避免 JSON 数值失真破坏能力快照。
 *
 * @param value - 未受信任 JSON 数值。
 * @param field - 错误消息中的字段名。
 * @returns 已验证的非负安全整数。
 * @sideEffects 无。
 * @throws Error - 非整数、负数或超过安全整数范围时抛出。
 */
function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`视频任务的 ${field} 快照无效`);
  }
  return value as number;
}

/**
 * 创建版本化视频能力快照。
 *
 * @param input - 已解析设置版本与当前模型有效参考图上限。
 * @returns 可直接写入任务 metadata 的新快照对象。
 * @sideEffects 无。
 * @throws Error - revision、上限或自定义模型能力非法时 fail closed。
 */
export function createVideoCapabilitySnapshot(input: {
  modelConfigurationRevision: number;
  maxReferenceImages: number;
  customModel?: {
    modelId: string;
    supportedResolutions: readonly string[];
  };
}): VideoCapabilitySnapshot {
  const modelConfigurationRevision = requireNonNegativeSafeInteger(
    input.modelConfigurationRevision,
    "模型配置 revision"
  );
  const maxReferenceImages = requireNonNegativeSafeInteger(
    input.maxReferenceImages,
    "参考图上限"
  );
  const customModel = input.customModel
    ? z
        .object({
          modelId: z.string().trim().min(1).max(120),
          supportedResolutions: z
            .array(z.string().trim().min(1).max(32))
            .min(1)
            .max(20),
        })
        .strict()
        .parse(input.customModel)
    : undefined;
  return {
    version: VIDEO_CAPABILITY_SNAPSHOT_VERSION,
    modelConfigurationRevision,
    maxReferenceImages,
    ...(customModel ? { customModel } : {}),
  };
}

/**
 * 从任务 metadata 严格读取创建时能力快照。
 *
 * @param metadata - 数据库 JSON metadata。
 * @returns 已验证且与输入隔离的能力快照。
 * @sideEffects 无。
 * @throws Error - 缺失、未知版本、额外字段或数值损坏时 fail closed。
 */
function parseVideoCapabilitySnapshot(
  metadata: Record<string, unknown> | null
): VideoCapabilitySnapshot {
  const value = metadata?.videoCapabilitySnapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("视频任务缺少能力快照");
  }
  const record = value as Record<string, unknown>;
  const version = record.version;
  if (
    !isVideoCapabilitySnapshotVersion(version) ||
    Object.keys(record).some(
      (key) =>
        key !== "version" &&
        key !== "modelConfigurationRevision" &&
        key !== "maxReferenceImages" &&
        key !== "customModel"
    )
  ) {
    throw new Error("视频任务的能力快照版本无效");
  }
  return {
    ...createVideoCapabilitySnapshot({
      modelConfigurationRevision: requireNonNegativeSafeInteger(
        record.modelConfigurationRevision,
        "模型配置 revision"
      ),
      maxReferenceImages: requireNonNegativeSafeInteger(
        record.maxReferenceImages,
        "参考图上限"
      ),
      ...(record.customModel !== undefined
        ? {
            customModel: z
              .object({
                modelId: z.string().trim().min(1).max(120),
                supportedResolutions: z
                  .array(z.string().trim().min(1).max(32))
                  .min(1)
                  .max(20),
              })
              .strict()
              .parse(record.customModel),
          }
        : {}),
    }),
    // WHY：解析历史任务时保留原始 v1 身份，账单层才能明确进入 legacy 按秒分支；
    // 只有新创建函数使用 v2，不能在恢复边界把旧任务伪装成新任务。
    version,
  };
}

/**
 * 从持久任务列和 metadata 恢复规范执行事实。
 *
 * @param input - 数据库读出的模型、独立参数与 metadata。
 * @returns worker 计费和供应商提交共用的真实模型执行契约。
 * @sideEffects 无；不会读取当前系统设置或数据库。
 * @throws Error - 复合模型、非法参数、缺失快照、能力漂移或非法声音时 fail closed。
 */
export function resolveVideoExecutionContract(input: {
  model: unknown;
  durationSeconds: unknown;
  aspectRatio: unknown;
  resolution: unknown;
  outputWidth?: unknown;
  outputHeight?: unknown;
  metadata: Record<string, unknown> | null;
}): VideoExecutionContract {
  const snapshot = parseVideoCapabilitySnapshot(input.metadata);
  if (snapshot.customModel) {
    const model = z.string().trim().min(1).max(120).parse(input.model);
    const duration = z.number().int().positive().parse(input.durationSeconds);
    const aspectRatio = videoAspectRatioSchema.parse(input.aspectRatio);
    const resolution = z.string().trim().min(1).max(32).parse(input.resolution);
    if (
      model !== snapshot.customModel.modelId ||
      !snapshot.customModel.supportedResolutions.includes(resolution) ||
      snapshot.maxReferenceImages !== 0 ||
      input.metadata?.generateAudio !== false
    ) {
      throw new Error("视频任务的自定义模型能力快照无效");
    }
    return {
      model,
      duration,
      aspectRatio,
      resolution,
      billingFamily: model,
      effectiveAudio: false,
      frameCapability: "none",
      maxReferenceImages: 0,
      modelConfigurationRevision: snapshot.modelConfigurationRevision,
      requiredMemberType: "api",
    };
  }
  const validated = validateVideoModelParameters({
    model: input.model,
    duration: input.durationSeconds,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
  });
  if (!validated.ok) {
    throw new Error(`视频任务参数无效: ${validated.error.field}`);
  }
  const outputSize = getVideoOutputSize(input.resolution, input.aspectRatio);
  if (
    !outputSize ||
    (input.outputWidth !== undefined &&
      input.outputWidth !== outputSize.width) ||
    (input.outputHeight !== undefined &&
      input.outputHeight !== outputSize.height)
  ) {
    throw new Error("视频任务输出像素与模型能力冲突");
  }
  const effectiveAudio = input.metadata?.generateAudio;
  if (typeof effectiveAudio !== "boolean") {
    throw new Error("视频任务缺少有效声音快照");
  }
  if (effectiveAudio && !validated.capability.audio.supported) {
    throw new Error("视频任务声音快照与模型能力冲突");
  }
  const referenceCapability = validated.capability.input.referenceImages;
  if (
    (!referenceCapability.configurable &&
      snapshot.maxReferenceImages !== referenceCapability.maxCount) ||
    (referenceCapability.configurable && snapshot.maxReferenceImages <= 0)
  ) {
    throw new Error("视频任务参考图上限与模型能力冲突");
  }

  return {
    model: validated.capability.modelId,
    duration: input.durationSeconds as number,
    aspectRatio: videoAspectRatioSchema.parse(input.aspectRatio),
    resolution: videoResolutionSchema.parse(input.resolution),
    billingFamily: validated.capability.billingFamily,
    effectiveAudio,
    frameCapability: validated.capability.input.frames,
    maxReferenceImages: snapshot.maxReferenceImages,
    modelConfigurationRevision: snapshot.modelConfigurationRevision,
  };
}
