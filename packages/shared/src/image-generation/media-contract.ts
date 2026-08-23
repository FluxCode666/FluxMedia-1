/**
 * 跨传输 JSON-safe 媒体引用契约。
 *
 * 职责：把 multipart、MCP 与 JSON 请求统一为 data、storage 或 remote 引用，限制
 * MIME、数量、单项及总字节。引用中的大小仍是不可信声明；operation 读取实际内容时
 * 必须重新校验，并对 remote URL 执行 DNS pin 与逐跳重定向复验。
 */
import { z } from "zod";

import { isBlockedIP } from "../security/ip-validation";
import type { MediaLimitPolicy } from "./media-limit-policy";
import {
  AUDIO_REFERENCE_MIME_TYPES,
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_INPUT_COUNT,
  MAX_MEDIA_INPUT_FILE_BYTES,
  MAX_REFERENCE_AUDIO_BYTES,
  MAX_REFERENCE_VIDEO_BYTES,
  MEDIA_INPUT_MIME_TYPES,
  VIDEO_REFERENCE_MIME_TYPES,
} from "./media-limits";

export {
  AUDIO_REFERENCE_MIME_TYPES,
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_INPUT_COUNT,
  MAX_MEDIA_INPUT_FILE_BYTES,
  MAX_REFERENCE_AUDIO_BYTES,
  MAX_REFERENCE_VIDEO_BYTES,
  MEDIA_INPUT_MIME_TYPES,
  VIDEO_REFERENCE_MIME_TYPES,
} from "./media-limits";

const mediaMimeTypeSchema = z.enum(MEDIA_INPUT_MIME_TYPES);
const IMAGE_REFERENCE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
const mediaByteLengthSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_MEDIA_INPUT_FILE_BYTES);
const MAX_BASE64_LENGTH = Math.ceil(MAX_MEDIA_INPUT_FILE_BYTES / 3) * 4;

/**
 * 以线性扫描校验标准 base64，避免对数 MB 输入执行重复分组正则而耗尽 V8 调用栈。
 *
 * @param value - 不含 data URL 前缀的待校验文本。
 * @returns 字符集、四字符分组和末尾 padding 均合法时返回 true。
 * @sideEffects 无。
 * @failure 不抛错；非法输入返回 false，超限输入在字符扫描前快速拒绝。
 */
function isStandardBase64(value: string): boolean {
  if (
    value.length < 4 ||
    value.length > MAX_BASE64_LENGTH ||
    value.length % 4 !== 0
  ) {
    return false;
  }

  const paddingLength = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - paddingLength;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const isBase64Character =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!isBase64Character) return false;
  }
  return true;
}

const base64Schema = z
  .string()
  .min(4)
  .max(MAX_BASE64_LENGTH)
  .refine(isStandardBase64, "Invalid base64 data");

/** 计算标准 base64 文本实际表示的字节数。 */
function getBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

const dataMediaInputReferenceSchema = z
  .object({
    source: z.literal("data"),
    mimeType: mediaMimeTypeSchema,
    base64: base64Schema,
    byteLength: mediaByteLengthSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (getBase64ByteLength(value.base64) === value.byteLength) return;
    context.addIssue({
      code: "custom",
      path: ["byteLength"],
      message: "Declared byteLength does not match base64 data",
    });
  });

export const storageMediaInputReferenceSchema = z
  .object({
    source: z.literal("storage"),
    mimeType: mediaMimeTypeSchema,
    storageKey: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.split("/").some((segment) => segment === ".."),
        "Storage key must be a relative object key"
      ),
    storageBucket: z.string().trim().min(1).max(128).optional(),
    byteLength: mediaByteLengthSchema,
  })
  .strict();

const remoteMediaInputReferenceSchema = z
  .object({
    source: z.literal("remote"),
    mimeType: mediaMimeTypeSchema,
    url: z
      .string()
      .trim()
      .url()
      .refine((rawUrl) => {
        const url = new URL(rawUrl);
        if (url.protocol !== "https:" || url.username || url.password) {
          return false;
        }
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        return !isBlockedIP(hostname);
      }, "Remote media URL must be a public HTTPS URL"),
    /** 远程 URL 可能没有可靠 Content-Length，读取时按实际字节复验。 */
    byteLength: mediaByteLengthSchema.optional(),
  })
  .strict();

/** 参考视频与音频使用的远程引用；只放宽协议，仍保留公网和凭据校验。 */
const remoteVideoReferenceInputReferenceSchema = z
  .object({
    source: z.literal("remote"),
    mimeType: mediaMimeTypeSchema,
    url: z
      .string()
      .trim()
      .url()
      .refine((rawUrl) => {
        const url = new URL(rawUrl);
        if (
          (url.protocol !== "http:" && url.protocol !== "https:") ||
          url.username ||
          url.password
        ) {
          return false;
        }
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        return !isBlockedIP(hostname);
      }, "Remote reference media URL must be a public HTTP or HTTPS URL"),
    /** 远程 URL 可能没有可靠 Content-Length，读取时按实际字节复验。 */
    byteLength: mediaByteLengthSchema.optional(),
  })
  .strict();

/** 参考视频与音频允许 HTTP/HTTPS 远程 URL，其他媒体仍保持 HTTPS 约束。 */
export const videoReferenceInputReferenceSchema = z.discriminatedUnion(
  "source",
  [
    dataMediaInputReferenceSchema,
    storageMediaInputReferenceSchema,
    remoteVideoReferenceInputReferenceSchema,
  ]
);

/** 单个 JSON-safe 媒体输入引用。 */
export const mediaInputReferenceSchema = z.discriminatedUnion("source", [
  dataMediaInputReferenceSchema,
  storageMediaInputReferenceSchema,
  remoteMediaInputReferenceSchema,
]);

/**
 * 一组 JSON-safe 媒体输入引用。
 *
 * 总量根据不可信声明做第一层快速拒绝；读取 data、storage 或 remote 内容后仍须按实际
 * 字节再验，避免客户端通过伪造 byteLength 绕过系统策略和内存边界。
 */
export const mediaInputReferencesSchema = z
  .array(mediaInputReferenceSchema)
  .min(1)
  .max(MAX_MEDIA_INPUT_COUNT)
  .superRefine((references, context) => {
    const totalBytes = references.reduce(
      (total, reference) => total + (reference.byteLength ?? 0),
      0
    );
    if (totalBytes <= MAX_MEDIA_INPUT_BYTES) return;
    context.addIssue({
      code: "custom",
      message: "Total media input bytes exceed the allowed maximum",
    });
  });

/** 单个 JSON-safe 媒体输入引用类型。 */
export type MediaInputReference = z.infer<typeof mediaInputReferenceSchema>;

/** 运行时媒体策略中与单次输入校验相关的稳定字段。 */
export type MediaInputPolicy = Pick<
  MediaLimitPolicy,
  | "maxFileSizeMb"
  | "maxUploadSizeMb"
  | "maxFileSizeBytes"
  | "maxUploadSizeBytes"
  | "maxEditReferenceImages"
>;

/** 媒体引用违反服务端当前生效的文件、总量或数量策略。 */
export class MediaInputPolicyValidationError extends Error {
  readonly maxFileSizeMb: number;
  readonly maxUploadSizeMb: number;
  readonly maxInputCount: number;

  /**
   * 创建不携带客户端引用、URL 或声明字节值的安全策略错误。
   *
   * @param policy - 服务端当前生效的媒体大小策略。
   * @param maxInputCount - 当前操作允许的最大媒体输入数量。
   * @param cause - 原始 Zod 校验错误，仅保留在服务端异常链。
   */
  constructor(policy: MediaInputPolicy, maxInputCount: number, cause: unknown) {
    super(
      `媒体输入超过当前限制：单文件最多 ${policy.maxFileSizeMb} MB，` +
        `单次合计最多 ${policy.maxUploadSizeMb} MB，最多 ${maxInputCount} 项`,
      { cause }
    );
    this.name = "MediaInputPolicyValidationError";
    this.maxFileSizeMb = policy.maxFileSizeMb;
    this.maxUploadSizeMb = policy.maxUploadSizeMb;
    this.maxInputCount = maxInputCount;
  }
}

/**
 * 以同一份运行时策略校验媒体引用声明。
 *
 * @param references - 已通过硬上限 schema 的 JSON-safe 媒体引用。
 * @param policy - 媒体限制 service 返回的系统策略快照。
 * @param maxCount - 当前操作允许的引用数；图片编辑通常传 maxEditReferenceImages。
 * @returns 原引用数组，供后续 storage/remote 实际字节复验继续使用。
 * @throws ZodError 单文件、总量或数量超过当前策略时拒绝。
 */
export function parseMediaInputReferencesWithPolicy(
  references: unknown,
  policy: MediaInputPolicy,
  maxCount = policy.maxEditReferenceImages
): MediaInputReference[] {
  return mediaInputReferencesSchema
    .superRefine((items, context) => {
      if (items.length > maxCount) {
        context.addIssue({
          code: "custom",
          message: `Media input count exceeds the allowed maximum of ${maxCount}`,
        });
      }
      for (const [index, item] of items.entries()) {
        if (item.byteLength === undefined) continue;
        if (item.byteLength <= policy.maxFileSizeBytes) continue;
        context.addIssue({
          code: "custom",
          path: [index, "byteLength"],
          message: "Media input exceeds the per-file size limit",
        });
      }
      const totalBytes = items.reduce(
        (total, item) => total + (item.byteLength ?? 0),
        0
      );
      if (totalBytes > policy.maxUploadSizeBytes) {
        context.addIssue({
          code: "custom",
          message: "Total media input bytes exceed the request limit",
        });
      }
    })
    .parse(references);
}

/**
 * 应用当前运行时策略，并把 Zod 细节收敛为不含输入内容的领域错误。
 *
 * @param references - 已通过传输硬上限或仍待解析的媒体引用。
 * @param policy - 服务端当前生效策略。
 * @param maxCount - 当前操作允许的最大输入数量。
 * @returns 校验后的媒体引用。
 * @throws MediaInputPolicyValidationError 文件、总量或数量超过当前策略时失败。
 */
export function assertMediaInputReferencesWithinPolicy(
  references: unknown,
  policy: MediaInputPolicy,
  maxCount = policy.maxEditReferenceImages
): MediaInputReference[] {
  try {
    return parseMediaInputReferencesWithPolicy(references, policy, maxCount);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new MediaInputPolicyValidationError(policy, maxCount, error);
    }
    throw error;
  }
}

/** 图片生成联合输入中与媒体策略有关的最小形态。 */
export type PolicyControlledImageInput =
  | { operation: "generate" }
  | { operation: "edit"; images: MediaInputReference[] }
  | {
      operation: "mask";
      images: MediaInputReference[];
      mask: MediaInputReference;
    };

/**
 * 对图片编辑/蒙版输入应用同一份动态单文件、总量和参考图数量策略。
 *
 * @param input - 已通过 image.generate 硬上限联合 schema 的输入。
 * @param policy - 服务端当前生效策略。
 * @returns 无返回；纯文生图无需媒体校验。
 * @throws MediaInputPolicyValidationError 任一动态限制不满足时失败。
 */
export function assertImageMediaInputWithinPolicy(
  input: PolicyControlledImageInput,
  policy: MediaInputPolicy
): void {
  if (input.operation === "generate") return;
  assertMediaInputReferencesWithinPolicy(
    input.images,
    policy,
    policy.maxEditReferenceImages
  );
  if (input.operation === "mask") {
    assertMediaInputReferencesWithinPolicy(
      [...input.images, input.mask],
      policy,
      Math.min(MAX_MEDIA_INPUT_COUNT, policy.maxEditReferenceImages + 1)
    );
  }
}

/** 平台持久视频输入对象必须显式保存当前 bucket，不能依赖运行时默认值漂移。 */
export const persistedVideoInputReferenceSchema =
  storageMediaInputReferenceSchema.extend({
    storageBucket: z.string().trim().min(1).max(128),
  });

/** 任务创建前仍可包含 data、storage 或 remote 来源的具名视频输入。 */
export const videoInputReferenceManifestSchema = z
  .object({
    firstFrame: mediaInputReferenceSchema.optional(),
    lastFrame: mediaInputReferenceSchema.optional(),
    referenceImages: mediaInputReferencesSchema.optional(),
    referenceVideos: z
      .array(videoReferenceInputReferenceSchema)
      .min(1)
      .max(3)
      .optional(),
    referenceAudios: z
      .array(videoReferenceInputReferenceSchema)
      .length(1)
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const [field, reference] of [
      ["firstFrame", manifest.firstFrame],
      ["lastFrame", manifest.lastFrame],
    ] as const) {
      if (
        reference &&
        !(IMAGE_REFERENCE_MIME_TYPES as readonly string[]).includes(
          reference.mimeType
        )
      ) {
        context.addIssue({
          code: "custom",
          path: [field, "mimeType"],
          message: "首尾帧必须是图片",
        });
      }
    }
    for (const [index, reference] of (
      manifest.referenceImages ?? []
    ).entries()) {
      if (
        !(IMAGE_REFERENCE_MIME_TYPES as readonly string[]).includes(
          reference.mimeType
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["referenceImages", index, "mimeType"],
          message: "参考图必须是图片",
        });
      }
    }
    if (manifest.lastFrame && !manifest.firstFrame) {
      context.addIssue({
        code: "custom",
        path: ["lastFrame"],
        message: "lastFrame requires firstFrame",
      });
    }
    if (
      (manifest.firstFrame || manifest.lastFrame) &&
      (manifest.referenceImages?.length ||
        manifest.referenceVideos?.length ||
        manifest.referenceAudios?.length)
    ) {
      context.addIssue({
        code: "custom",
        path: [
          manifest.referenceImages?.length
            ? "referenceImages"
            : manifest.referenceVideos?.length
              ? "referenceVideos"
              : "referenceAudios",
        ],
        message: "Frame inputs and reference media are mutually exclusive",
      });
    }
    for (const [index, reference] of (
      manifest.referenceVideos ?? []
    ).entries()) {
      if (
        !(VIDEO_REFERENCE_MIME_TYPES as readonly string[]).includes(
          reference.mimeType
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["referenceVideos", index, "mimeType"],
          message: "参考视频必须是 MP4 或 MOV",
        });
      }
      if (
        reference.byteLength !== undefined &&
        reference.byteLength > MAX_REFERENCE_VIDEO_BYTES
      ) {
        context.addIssue({
          code: "custom",
          path: ["referenceVideos", index, "byteLength"],
          message: "单个参考视频不能超过 200 MB",
        });
      }
    }
    for (const [index, reference] of (
      manifest.referenceAudios ?? []
    ).entries()) {
      if (
        !(AUDIO_REFERENCE_MIME_TYPES as readonly string[]).includes(
          reference.mimeType
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["referenceAudios", index, "mimeType"],
          message: "参考音频必须是 MP3 或 WAV",
        });
      }
      if (
        reference.byteLength !== undefined &&
        reference.byteLength > MAX_REFERENCE_AUDIO_BYTES
      ) {
        context.addIssue({
          code: "custom",
          path: ["referenceAudios", index, "byteLength"],
          message: "参考音频不能超过 15 MB",
        });
      }
    }
    const references = listVideoInputManifestReferences(manifest);
    if (references.length > MAX_MEDIA_INPUT_COUNT) {
      context.addIssue({
        code: "custom",
        message: "Video input count exceeds the allowed maximum",
      });
    }
    const totalBytes = references.reduce(
      (total, reference) => total + (reference.byteLength ?? 0),
      0
    );
    if (totalBytes > MAX_MEDIA_INPUT_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Total media input bytes exceed the allowed maximum",
      });
    }
  });

/** 视频任务保存的 storage-only 具名输入清单。 */
export const videoInputManifestSchema = z
  .object({
    firstFrame: persistedVideoInputReferenceSchema.optional(),
    lastFrame: persistedVideoInputReferenceSchema.optional(),
    referenceImages: z
      .array(persistedVideoInputReferenceSchema)
      .min(1)
      .max(MAX_MEDIA_INPUT_COUNT)
      .optional(),
    referenceVideos: z
      .array(persistedVideoInputReferenceSchema)
      .min(1)
      .max(3)
      .optional(),
    referenceAudios: z
      .array(persistedVideoInputReferenceSchema)
      .length(1)
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const [field, reference] of [
      ["firstFrame", manifest.firstFrame],
      ["lastFrame", manifest.lastFrame],
    ] as const) {
      if (
        reference &&
        !(IMAGE_REFERENCE_MIME_TYPES as readonly string[]).includes(
          reference.mimeType
        )
      ) {
        context.addIssue({
          code: "custom",
          path: [field, "mimeType"],
          message: "首尾帧必须是图片",
        });
      }
    }
    for (const [index, reference] of (
      manifest.referenceImages ?? []
    ).entries()) {
      if (
        !(IMAGE_REFERENCE_MIME_TYPES as readonly string[]).includes(
          reference.mimeType
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["referenceImages", index, "mimeType"],
          message: "参考图必须是图片",
        });
      }
    }
    if (manifest.lastFrame && !manifest.firstFrame) {
      context.addIssue({
        code: "custom",
        path: ["lastFrame"],
        message: "lastFrame requires firstFrame",
      });
    }
    if (
      (manifest.firstFrame || manifest.lastFrame) &&
      (manifest.referenceImages?.length ||
        manifest.referenceVideos?.length ||
        manifest.referenceAudios?.length)
    ) {
      context.addIssue({
        code: "custom",
        path: [
          manifest.referenceImages?.length
            ? "referenceImages"
            : manifest.referenceVideos?.length
              ? "referenceVideos"
              : "referenceAudios",
        ],
        message: "Frame inputs and reference media are mutually exclusive",
      });
    }
    for (const [index, reference] of (
      manifest.referenceVideos ?? []
    ).entries()) {
      if (
        !(VIDEO_REFERENCE_MIME_TYPES as readonly string[]).includes(
          reference.mimeType
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["referenceVideos", index, "mimeType"],
          message: "参考视频必须是 MP4 或 MOV",
        });
      }
      if (reference.byteLength > MAX_REFERENCE_VIDEO_BYTES) {
        context.addIssue({
          code: "custom",
          path: ["referenceVideos", index, "byteLength"],
          message: "单个参考视频不能超过 200 MB",
        });
      }
    }
    for (const [index, reference] of (
      manifest.referenceAudios ?? []
    ).entries()) {
      if (
        !(AUDIO_REFERENCE_MIME_TYPES as readonly string[]).includes(
          reference.mimeType
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["referenceAudios", index, "mimeType"],
          message: "参考音频必须是 MP3 或 WAV",
        });
      }
      if (reference.byteLength > MAX_REFERENCE_AUDIO_BYTES) {
        context.addIssue({
          code: "custom",
          path: ["referenceAudios", index, "byteLength"],
          message: "参考音频不能超过 15 MB",
        });
      }
    }
    const references = listVideoInputManifestReferences(manifest);
    if (references.length > MAX_MEDIA_INPUT_COUNT) {
      context.addIssue({
        code: "custom",
        message: "Video input count exceeds the allowed maximum",
      });
    }
    const totalBytes = references.reduce(
      (total, reference) => total + (reference.byteLength ?? 0),
      0
    );
    if (totalBytes > MAX_MEDIA_INPUT_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Total media input bytes exceed the allowed maximum",
      });
    }
  });

/** 任务创建前的具名视频输入清单类型。 */
export type VideoInputReferenceManifest = z.infer<
  typeof videoInputReferenceManifestSchema
>;

/** 已归一为平台持久对象的具名视频输入清单类型。 */
export type VideoInputManifest = z.infer<typeof videoInputManifestSchema>;

/** 按 firstFrame、lastFrame、referenceImages 的稳定语义顺序展开清单。 */
export function listVideoInputManifestReferences<
  T extends MediaInputReference,
>(manifest: {
  firstFrame?: T | undefined;
  lastFrame?: T | undefined;
  referenceImages?: T[] | undefined;
  referenceVideos?: T[] | undefined;
  referenceAudios?: T[] | undefined;
}): T[] {
  return [
    ...(manifest.firstFrame ? [manifest.firstFrame] : []),
    ...(manifest.lastFrame ? [manifest.lastFrame] : []),
    ...(manifest.referenceImages ?? []),
    ...(manifest.referenceVideos ?? []),
    ...(manifest.referenceAudios ?? []),
  ];
}
