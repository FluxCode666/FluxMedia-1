/**
 * 媒体资源限制的纯函数策略。
 *
 * 职责：集中定义系统默认值、硬上限、用户并发覆盖的范围和来源语义。
 * 使用方：媒体限制 service、UOL operation、媒体输入契约和管理员配置。
 * 本文件不访问数据库或运行时环境，便于在 DB-free 测试中覆盖边界与失败模式。
 */

import { z } from "zod";

const BYTES_PER_MB = 1024 * 1024;

export const MEDIA_LIMIT_DEFAULTS = {
  defaultUserConcurrency: 20,
  maxFileSizeMb: 5,
  maxUploadSizeMb: 75,
  maxEditReferenceImages: 16,
} as const;

export const MEDIA_LIMIT_HARD_MAX = {
  userConcurrency: 10_000,
  fileSizeMb: 200,
  uploadSizeMb: 512,
  editReferenceImages: 256,
} as const;

export const MEDIA_LIMIT_SETTING_KEYS = {
  defaultUserConcurrency: "IMAGE_GENERATION_DEFAULT_USER_CONCURRENCY",
  maxFileSizeMb: "MEDIA_MAX_FILE_SIZE_MB",
  maxUploadSizeMb: "MEDIA_MAX_UPLOAD_SIZE_MB",
  maxEditReferenceImages: "IMAGE_EDIT_MAX_REFERENCE_IMAGES",
} as const;

export type MediaLimitSettingKey =
  (typeof MEDIA_LIMIT_SETTING_KEYS)[keyof typeof MEDIA_LIMIT_SETTING_KEYS];

export type MediaLimitPolicy = {
  defaultUserConcurrency: number;
  maxFileSizeMb: number;
  maxUploadSizeMb: number;
  maxEditReferenceImages: number;
  maxFileSizeBytes: number;
  maxUploadSizeBytes: number;
};

export type UserConcurrencySource = "system_default" | "user_override";

export type EffectiveUserConcurrency = {
  limit: number;
  override: number | null;
  effectiveSource: UserConcurrencySource;
  scope: "user";
};

export const userConcurrencyOverrideSchema = z
  .number()
  .int()
  .min(1)
  .max(MEDIA_LIMIT_HARD_MAX.userConcurrency)
  .nullable();

/** 创建带中文错误信息的闭区间整数 schema。 */
const integerInRange = (label: string, min: number, max: number) =>
  z
    .number({ message: `${label} 必须是数字` })
    .int(`${label} 必须是整数`)
    .min(min, `${label} 不能小于 ${min}`)
    .max(max, `${label} 不能大于 ${max}`);

export const mediaLimitPolicySchema = z
  .object({
    defaultUserConcurrency: integerInRange(
      "默认用户生图并发",
      1,
      MEDIA_LIMIT_HARD_MAX.userConcurrency
    ),
    maxFileSizeMb: integerInRange(
      "单文件大小 MB",
      1,
      MEDIA_LIMIT_HARD_MAX.fileSizeMb
    ),
    maxUploadSizeMb: integerInRange(
      "单次上传总量 MB",
      1,
      MEDIA_LIMIT_HARD_MAX.uploadSizeMb
    ),
    maxEditReferenceImages: integerInRange(
      "编辑参考图数",
      1,
      MEDIA_LIMIT_HARD_MAX.editReferenceImages
    ),
  })
  .strict();

export class MediaLimitPolicyError extends Error {
  readonly code = "validation_error" as const;

  /** 保存可映射为 UOL validation_error 的安全策略错误。 */
  constructor(message: string) {
    super(message);
    this.name = "MediaLimitPolicyError";
  }
}

/** 严格解析单个媒体限制，统一拒绝小数、零、负数和超过硬上限的值。 */
export function parseMediaLimitValue(
  value: unknown,
  input: {
    label: string;
    min?: number;
    max: number;
  }
): number {
  const numeric =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (
    typeof numeric !== "number" ||
    !Number.isSafeInteger(numeric) ||
    numeric < (input.min ?? 1) ||
    numeric > input.max
  ) {
    throw new MediaLimitPolicyError(
      `${input.label} 必须是 ${input.min ?? 1} 至 ${input.max} 的整数`
    );
  }
  return numeric;
}

/** 严格解析四项系统媒体限制。 */
export function parseMediaLimitPolicy(
  value: unknown
): Omit<MediaLimitPolicy, "maxFileSizeBytes" | "maxUploadSizeBytes"> {
  const parsed = mediaLimitPolicySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new MediaLimitPolicyError("媒体限制配置不合法");
}

/**
 * 将数据库、环境变量或缺失值解析为安全策略。
 *
 * 单个脏值只回退对应默认值，避免一个配置错误把其他已经合法的运营配置一起覆盖。
 */
export function resolveMediaLimitPolicy(input: {
  defaultUserConcurrency?: unknown;
  maxFileSizeMb?: unknown;
  maxUploadSizeMb?: unknown;
  maxEditReferenceImages?: unknown;
}): MediaLimitPolicy {
  /** 尝试解析单项配置；脏值只回退该项默认值。 */
  const parseOrDefault = (
    value: unknown,
    label: string,
    fallback: number,
    max: number
  ) => {
    try {
      return parseMediaLimitValue(value ?? fallback, { label, max });
    } catch {
      return fallback;
    }
  };

  const maxFileSizeMb = parseOrDefault(
    input.maxFileSizeMb,
    "单文件大小 MB",
    MEDIA_LIMIT_DEFAULTS.maxFileSizeMb,
    MEDIA_LIMIT_HARD_MAX.fileSizeMb
  );
  const maxUploadSizeMb = parseOrDefault(
    input.maxUploadSizeMb,
    "单次上传总量 MB",
    MEDIA_LIMIT_DEFAULTS.maxUploadSizeMb,
    MEDIA_LIMIT_HARD_MAX.uploadSizeMb
  );
  return {
    defaultUserConcurrency: parseOrDefault(
      input.defaultUserConcurrency,
      "默认用户生图并发",
      MEDIA_LIMIT_DEFAULTS.defaultUserConcurrency,
      MEDIA_LIMIT_HARD_MAX.userConcurrency
    ),
    maxFileSizeMb,
    maxUploadSizeMb,
    maxEditReferenceImages: parseOrDefault(
      input.maxEditReferenceImages,
      "编辑参考图数",
      MEDIA_LIMIT_DEFAULTS.maxEditReferenceImages,
      MEDIA_LIMIT_HARD_MAX.editReferenceImages
    ),
    maxFileSizeBytes: maxFileSizeMb * BYTES_PER_MB,
    maxUploadSizeBytes: maxUploadSizeMb * BYTES_PER_MB,
  };
}

/** 解析用户覆盖并计算生效并发及来源；null 表示继承系统默认。 */
export function resolveEffectiveUserConcurrency(input: {
  systemDefault: unknown;
  userOverride: unknown;
}): EffectiveUserConcurrency {
  const systemDefault = parseMediaLimitValue(input.systemDefault, {
    label: "默认用户生图并发",
    max: MEDIA_LIMIT_HARD_MAX.userConcurrency,
  });
  const rawOverride = input.userOverride;
  if (rawOverride === null || rawOverride === undefined || rawOverride === "") {
    return {
      limit: systemDefault,
      override: null,
      effectiveSource: "system_default",
      scope: "user",
    };
  }
  const override = parseMediaLimitValue(rawOverride, {
    label: "用户生图并发覆盖",
    max: MEDIA_LIMIT_HARD_MAX.userConcurrency,
  });
  return {
    limit: override,
    override,
    effectiveSource: "user_override",
    scope: "user",
  };
}
