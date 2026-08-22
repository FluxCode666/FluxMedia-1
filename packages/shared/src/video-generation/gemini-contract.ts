/**
 * Gemini Veo 长任务协议的 DB-free 合约。
 *
 * 使用方：Gemini 公共 API handler、Gemini 上游适配器与 Operation 投影；本文件不访问
 * 数据库、不读取凭据，也不包含供应商调度逻辑。只接受本期已冻结的官方 REST 字段。
 */
import { z } from "zod";

/** Gemini 路径模型 ID；真正的平台模型映射由调用方按配置解析。 */
export const geminiModelPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/** 仅允许内联图片，避免公共 Gemini 网关替客户端代取任意 URL。 */
export const geminiInlineImageSchema = z
  .object({
    inlineData: z
      .object({
        mimeType: z
          .string()
          .trim()
          .regex(/^image\/[A-Za-z0-9.+-]+$/)
          .max(128),
        data: z
          .string()
          .min(1)
          .max(16_777_216)
          .regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
            "inlineData.data must be valid base64"
          ),
      })
      .strict(),
  })
  .strict();

/** Gemini 兼容扩展使用的参考视频 HTTPS 直链。 */
export const geminiReferenceVideoUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((rawUrl) => {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      [".mp4", ".mov"].some((extension) =>
        url.pathname.toLowerCase().endsWith(extension)
      )
    );
  }, "reference_videos must contain HTTPS mp4 or mov URLs");

/** Gemini 兼容扩展使用的参考音频 HTTPS 直链。 */
export const geminiReferenceAudioUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((rawUrl) => {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      [".mp3", ".wav"].some((extension) =>
        url.pathname.toLowerCase().endsWith(extension)
      )
    );
  }, "reference_audios must contain HTTPS mp3 or wav URLs");

/** Gemini Veo 的单个实例；输入视频和非官方字段在此层直接拒绝。 */
export const geminiVideoInstanceSchema = z
  .object({
    prompt: z.string().trim().min(1).max(100_000),
    image: geminiInlineImageSchema.optional(),
    lastFrame: geminiInlineImageSchema.optional(),
    referenceImages: z
      .array(
        z
          .object({
            image: geminiInlineImageSchema,
            referenceType: z.enum(["asset", "style"]),
          })
          .strict()
      )
      .max(3)
      .optional(),
    reference_videos: z
      .array(geminiReferenceVideoUrlSchema)
      .min(1)
      .max(3)
      .optional(),
    reference_audios: z
      .array(geminiReferenceAudioUrlSchema)
      .length(1)
      .optional(),
  })
  .strict()
  .superRefine((instance, context) => {
    if (instance.lastFrame && !instance.image) {
      context.addIssue({
        code: "custom",
        path: ["lastFrame"],
        message: "lastFrame requires image",
      });
    }
    if (instance.image && instance.referenceImages?.length) {
      context.addIssue({
        code: "custom",
        path: ["referenceImages"],
        message: "image and referenceImages are mutually exclusive",
      });
    }
  });

/** 本期冻结的官方 Veo parameters 字段。 */
const geminiDurationSecondsSchema = z
  .union([
    z.literal(4),
    z.literal(6),
    z.literal(8),
    z.enum(["4", "6", "8"]).transform((value) => Number(value)),
  ])
  .optional();

export const geminiVideoParametersSchema = z
  .object({
    aspectRatio: z.string().trim().min(1).max(32).optional(),
    resolution: z.string().trim().min(1).max(32).optional(),
    // Gemini REST 的 int64 JSON 表示是字符串；输入仍兼容数字，供平台内部
    // 的统一视频契约使用，真正发往 Gemini 的请求必须再序列化为字符串。
    durationSeconds: geminiDurationSecondsSchema,
  })
  .strict();

/** Gemini predictLongRunning 请求。模型只来自 URL，不接受 body.model。 */
export const geminiVideoRequestSchema = z
  .object({
    instances: z.array(geminiVideoInstanceSchema).length(1),
    parameters: geminiVideoParametersSchema.optional(),
  })
  .strict();

/** 平台生成的不透明 Operation name。 */
export const geminiPublicOperationNameSchema = z
  .string()
  .regex(
    /^models\/[A-Za-z0-9][A-Za-z0-9._:-]*\/operations\/[A-Za-z0-9_-]{16,128}$/
  );

/** Gemini 视频结果地址；允许 HTTP/HTTPS，其他协议仍拒绝。 */
const geminiVideoUriSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Gemini video URI must use HTTP or HTTPS");

/** Google Status 的脱敏公共错误投影。 */
export const geminiOperationErrorSchema = z
  .object({
    code: z.number().int().min(1).max(99),
    message: z.string().trim().min(1).max(512),
    status: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/** Gemini 兼容 Operation 输出；response/error 由 done 状态互斥约束。 */
export const geminiOperationOutputSchema = z
  .object({
    name: geminiPublicOperationNameSchema,
    done: z.boolean(),
    response: z
      .object({
        generateVideoResponse: z
          .object({
            generatedSamples: z
              .array(
                z
                  .object({
                    video: z
                      .object({
                        uri: geminiVideoUriSchema,
                      })
                      .strict(),
                  })
                  .strict()
              )
              .min(1),
          })
          .strict(),
      })
      .strict()
      .optional(),
    error: geminiOperationErrorSchema.optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (!operation.done && (operation.response || operation.error)) {
      context.addIssue({
        code: "custom",
        message: "A pending Operation cannot contain response or error",
        path: ["done"],
      });
    }
    if (
      operation.done &&
      Boolean(operation.response) === Boolean(operation.error)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A completed Operation must contain exactly one response or error",
        path: ["done"],
      });
    }
  });

export type GeminiVideoRequest = z.infer<typeof geminiVideoRequestSchema>;
export type GeminiOperationOutput = z.infer<typeof geminiOperationOutputSchema>;
