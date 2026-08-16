/**
 * 视频当前报价 token 与规范报价摘要。
 *
 * 使用方：能力价格发现签发 token，video.generate 首次准入在权威报价后校验。token
 * 只携带 Principal scope 和固定长度摘要，不编码内部组、价格、revision 或业务输入。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { videoCreditUnitPriceSchema } from "../adobe/video-pricing";
import { videoBillingModeSchema } from "./contracts";

const VIDEO_QUOTE_TOKEN_VERSION = 1 as const;
const VIDEO_QUOTE_TOKEN_DOMAIN = "fluxmedia:video-quote:v1";
const MAX_VIDEO_QUOTE_TOKEN_LENGTH = 2_048;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

const videoQuoteDigestInputSchema = z
  .object({
    modelId: z.string().trim().min(1).max(120),
    resolution: z.string().trim().min(1).max(32),
    mode: videoBillingModeSchema,
    unitPrice: videoCreditUnitPriceSchema,
    billingGroupId: z.string().trim().min(1).max(128),
    modelConfigurationRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const videoQuoteTokenPayloadSchema = z
  .object({
    v: z.literal(VIDEO_QUOTE_TOKEN_VERSION),
    sub: z.string().trim().min(1).max(512),
    quote: sha256HexSchema,
  })
  .strict();

/** 报价摘要绑定的最小权威事实；内部组只进入单向摘要。 */
export type VideoQuoteDigestInput = z.infer<typeof videoQuoteDigestInputSchema>;

/** 报价 token 的统一安全错误；不暴露 token 或具体失败阶段。 */
export class VideoQuoteTokenError extends Error {
  readonly code = "validation_error" as const;

  /** 创建固定消息的安全错误。 */
  constructor() {
    super("Invalid or stale video quote token");
    this.name = "VideoQuoteTokenError";
  }
}

/** 读取显式 secret 或平台认证 secret；空值属于服务端配置错误。 */
function resolveVideoQuoteSecret(secret: string | undefined): string {
  const resolved = secret ?? process.env.BETTER_AUTH_SECRET;
  if (!resolved?.trim()) {
    throw new Error("BETTER_AUTH_SECRET is required for video quote tokens");
  }
  return resolved;
}

/** 使用独立域标签签名编码后的载荷，防止与其他 HMAC token 互换。 */
function signVideoQuotePayload(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(VIDEO_QUOTE_TOKEN_DOMAIN)
    .update("\0")
    .update(payload)
    .digest();
}

/** 以恒定时间比较两个固定长度十六进制摘要。 */
function equalVideoQuoteDigests(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

/**
 * 对选中模型与分辨率的当前权威报价生成规范摘要。
 *
 * @param input - 公开模型/分辨率/模式/单价，以及只进入摘要的组和 revision。
 * @returns 64 位小写 SHA-256 摘要；无关模型改价不会改变结果。
 * @sideEffects 无。
 * @throws ZodError - 任一权威字段非法时 fail closed。
 */
export function createVideoQuoteDigest(input: VideoQuoteDigestInput): string {
  const value = videoQuoteDigestInputSchema.parse(input);
  return createHash("sha256")
    .update(
      JSON.stringify({
        modelId: value.modelId,
        resolution: value.resolution,
        mode: value.mode,
        unitPrice: value.unitPrice,
        billingGroupId: value.billingGroupId,
        modelConfigurationRevision: value.modelConfigurationRevision,
      }),
      "utf8"
    )
    .digest("hex");
}

/**
 * 签发 Principal scope 与当前报价摘要绑定的不透明 token。
 *
 * @param input - 服务端构造的 Principal scope 和规范摘要。
 * @param secret - 测试可显式注入；生产默认复用 BETTER_AUTH_SECRET。
 * @returns 版本化 base64url HMAC token。
 * @sideEffects 生产可能读取环境变量。
 * @throws 服务端 secret 缺失或输入非法时上抛。
 */
export function encodeVideoQuoteToken(
  input: { principalScope: string; quoteDigest: string },
  secret?: string
): string {
  const resolvedSecret = resolveVideoQuoteSecret(secret);
  const payload = videoQuoteTokenPayloadSchema.parse({
    v: VIDEO_QUOTE_TOKEN_VERSION,
    sub: input.principalScope,
    quote: input.quoteDigest,
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url"
  );
  const signature = signVideoQuotePayload(
    encodedPayload,
    resolvedSecret
  ).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

/**
 * 验证 token 格式、签名、Principal scope 与当前报价摘要。
 *
 * @param token - 不可信调用方 token。
 * @param expected - 当前 Principal scope 与事务内重算摘要。
 * @param secret - 测试可显式注入；生产默认复用 BETTER_AUTH_SECRET。
 * @returns 无返回；完全匹配时允许首次任务创建。
 * @sideEffects 生产可能读取环境变量。
 * @throws VideoQuoteTokenError - 任一格式、签名、主体或报价不匹配。
 */
export function assertVideoQuoteToken(
  token: string,
  expected: { principalScope: string; quoteDigest: string },
  secret?: string
): void {
  try {
    if (!token || token.length > MAX_VIDEO_QUOTE_TOKEN_LENGTH) {
      throw new VideoQuoteTokenError();
    }
    const parts = token.split(".");
    if (parts.length !== 2) throw new VideoQuoteTokenError();
    const [encodedPayload, encodedSignature] = parts;
    if (
      !encodedPayload ||
      !encodedSignature ||
      !BASE64URL_PATTERN.test(encodedPayload) ||
      !BASE64URL_PATTERN.test(encodedSignature)
    ) {
      throw new VideoQuoteTokenError();
    }
    const payloadBytes = Buffer.from(encodedPayload, "base64url");
    const signatureBytes = Buffer.from(encodedSignature, "base64url");
    if (
      payloadBytes.toString("base64url") !== encodedPayload ||
      signatureBytes.toString("base64url") !== encodedSignature
    ) {
      throw new VideoQuoteTokenError();
    }
    const resolvedSecret = resolveVideoQuoteSecret(secret);
    const expectedSignature = signVideoQuotePayload(
      encodedPayload,
      resolvedSecret
    );
    if (
      signatureBytes.length !== expectedSignature.length ||
      !timingSafeEqual(signatureBytes, expectedSignature)
    ) {
      throw new VideoQuoteTokenError();
    }
    const payload = videoQuoteTokenPayloadSchema.parse(
      JSON.parse(payloadBytes.toString("utf8")) as unknown
    );
    if (
      payload.sub !== expected.principalScope ||
      !equalVideoQuoteDigests(payload.quote, expected.quoteDigest)
    ) {
      throw new VideoQuoteTokenError();
    }
  } catch (error) {
    if (error instanceof VideoQuoteTokenError) throw error;
    throw new VideoQuoteTokenError();
  }
}
