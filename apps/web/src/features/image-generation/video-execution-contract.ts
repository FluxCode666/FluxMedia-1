/**
 * 视频任务创建快照与 worker 恢复事实的 DB-free 契约。
 *
 * 使用方：UOL binding 在创建时形成快照，video-operations 在创建和恢复时用同一解析器
 * 校验真实模型、独立参数、有效声音和创建时参考图上限，不查询当前动态配置。
 */
import {
  type VideoAspectRatio,
  type VideoBillingFamily,
  type VideoFrameInputCapability,
  type VideoModelId,
  type VideoResolution,
  validateVideoModelParameters,
  videoAspectRatioSchema,
  videoResolutionSchema,
} from "@repo/shared/video-generation";

/** 视频能力任务快照的持久格式版本。 */
export const VIDEO_CAPABILITY_SNAPSHOT_VERSION = 1 as const;

/** 创建时固定的动态能力事实。 */
export type VideoCapabilitySnapshot = {
  version: typeof VIDEO_CAPABILITY_SNAPSHOT_VERSION;
  modelConfigurationRevision: number;
  maxReferenceImages: number;
};

/** worker 可直接消费的规范任务事实。 */
export type VideoExecutionContract = {
  model: VideoModelId;
  duration: number;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  billingFamily: VideoBillingFamily;
  effectiveAudio: boolean;
  frameCapability: VideoFrameInputCapability;
  maxReferenceImages: number;
  modelConfigurationRevision: number;
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
 * @throws Error - 版本或上限不是安全整数时 fail closed。
 */
export function createVideoCapabilitySnapshot(input: {
  modelConfigurationRevision: number;
  maxReferenceImages: number;
}): VideoCapabilitySnapshot {
  const modelConfigurationRevision = requireNonNegativeSafeInteger(
    input.modelConfigurationRevision,
    "模型配置 revision"
  );
  const maxReferenceImages = requireNonNegativeSafeInteger(
    input.maxReferenceImages,
    "参考图上限"
  );
  return {
    version: VIDEO_CAPABILITY_SNAPSHOT_VERSION,
    modelConfigurationRevision,
    maxReferenceImages,
  };
}

/**
 * 从任务 metadata 严格读取创建时能力快照。
 *
 * @param metadata - 数据库 JSON metadata。
 * @returns 已验证且与输入隔离的能力快照。
 * @sideEffects 无。
 * @throws Error - 缺失、版本漂移、额外字段或数值损坏时 fail closed。
 */
function parseVideoCapabilitySnapshot(
  metadata: Record<string, unknown> | null
): VideoCapabilitySnapshot {
  const value = metadata?.videoCapabilitySnapshot;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("视频任务缺少能力快照");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== VIDEO_CAPABILITY_SNAPSHOT_VERSION ||
    Object.keys(record).some(
      (key) =>
        key !== "version" &&
        key !== "modelConfigurationRevision" &&
        key !== "maxReferenceImages"
    )
  ) {
    throw new Error("视频任务的能力快照版本无效");
  }
  return createVideoCapabilitySnapshot({
    modelConfigurationRevision: requireNonNegativeSafeInteger(
      record.modelConfigurationRevision,
      "模型配置 revision"
    ),
    maxReferenceImages: requireNonNegativeSafeInteger(
      record.maxReferenceImages,
      "参考图上限"
    ),
  });
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
  metadata: Record<string, unknown> | null;
}): VideoExecutionContract {
  const validated = validateVideoModelParameters({
    model: input.model,
    duration: input.durationSeconds,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
  });
  if (!validated.ok) {
    throw new Error(`视频任务参数无效: ${validated.error.field}`);
  }
  const snapshot = parseVideoCapabilitySnapshot(input.metadata);
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
