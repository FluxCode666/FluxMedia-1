/**
 * 跨传输 JSON-safe 媒体引用契约。
 *
 * 职责：把 multipart、MCP 与 JSON 请求统一为 data、storage 或 remote 引用，限制
 * MIME、数量、单项及总字节。引用中的大小仍是不可信声明；operation 读取实际内容时
 * 必须重新校验，并对 remote URL 执行 DNS pin 与逐跳重定向复验。
 */
import { z } from "zod";

import { isBlockedIP } from "../security/ip-validation";

const BYTES_PER_MB = 1024 * 1024;

/** 单项和单次媒体输入的安全硬上限；套餐限制可进一步收紧。 */
export const MAX_MEDIA_INPUT_BYTES = 200 * BYTES_PER_MB;

/** 单次媒体引用数量硬上限；套餐 maxEditImages 可进一步收紧。 */
export const MAX_MEDIA_INPUT_COUNT = 256;

/** 保留媒体链路允许的输入图片 MIME。 */
export const MEDIA_INPUT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

const mediaMimeTypeSchema = z.enum(MEDIA_INPUT_MIME_TYPES);
const mediaByteLengthSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_MEDIA_INPUT_BYTES);
const base64Schema = z
  .string()
  .min(4)
  .max(Math.ceil((MAX_MEDIA_INPUT_BYTES * 4) / 3) + 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

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
    byteLength: mediaByteLengthSchema,
  })
  .strict();

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
 * 字节再验，避免客户端通过伪造 byteLength 绕过套餐和内存边界。
 */
export const mediaInputReferencesSchema = z
  .array(mediaInputReferenceSchema)
  .min(1)
  .max(MAX_MEDIA_INPUT_COUNT)
  .superRefine((references, context) => {
    const totalBytes = references.reduce(
      (total, reference) => total + reference.byteLength,
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
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.lastFrame && !manifest.firstFrame) {
      context.addIssue({
        code: "custom",
        path: ["lastFrame"],
        message: "lastFrame requires firstFrame",
      });
    }
    if (
      (manifest.firstFrame || manifest.lastFrame) &&
      manifest.referenceImages?.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["referenceImages"],
        message: "Frame inputs and reference images are mutually exclusive",
      });
    }
    const references = listVideoInputManifestReferences(manifest);
    if (references.length > MAX_MEDIA_INPUT_COUNT) {
      context.addIssue({
        code: "custom",
        message: "Video input count exceeds the allowed maximum",
      });
    }
    const totalBytes = references.reduce(
      (total, reference) => total + reference.byteLength,
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
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.lastFrame && !manifest.firstFrame) {
      context.addIssue({
        code: "custom",
        path: ["lastFrame"],
        message: "lastFrame requires firstFrame",
      });
    }
    if (
      (manifest.firstFrame || manifest.lastFrame) &&
      manifest.referenceImages?.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["referenceImages"],
        message: "Frame inputs and reference images are mutually exclusive",
      });
    }
    const references = listVideoInputManifestReferences(manifest);
    if (references.length > MAX_MEDIA_INPUT_COUNT) {
      context.addIssue({
        code: "custom",
        message: "Video input count exceeds the allowed maximum",
      });
    }
    const totalBytes = references.reduce(
      (total, reference) => total + reference.byteLength,
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
}): T[] {
  return [
    ...(manifest.firstFrame ? [manifest.firstFrame] : []),
    ...(manifest.lastFrame ? [manifest.lastFrame] : []),
    ...(manifest.referenceImages ?? []),
  ];
}
