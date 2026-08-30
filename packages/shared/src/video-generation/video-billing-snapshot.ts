/**
 * 视频任务不可变账单快照的 DB-free 契约。
 *
 * 使用方：任务首次创建、worker、恢复、退款、状态与历史投影。模块只接受严格报价，
 * 用规范字段顺序生成 SHA-256 摘要，并显式区分旧能力任务与必须携带快照的新任务。
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  getVideoBillingCreditCost,
  type VideoBillingQuote,
  videoCreditUnitPriceSchema,
} from "./video-pricing";

/** 当前账单快照持久格式版本。 */
export const VIDEO_BILLING_SNAPSHOT_VERSION = 1 as const;

/** 升级前已在途、允许没有账单快照的能力快照版本。 */
export const LEGACY_VIDEO_CAPABILITY_SNAPSHOT_VERSION = 1 as const;

/** 首个强制能力快照与账单快照同 insert 写入的能力版本。 */
export const VIDEO_BILLING_CAPABILITY_SNAPSHOT_VERSION = 2 as const;

const canonicalModelIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);
const canonicalResolutionSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const canonicalBillingGroupIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim());
const durationSecondsSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const quotedCreditsSchema = z
  .number()
  .finite()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const commonSnapshotPayloadShape = {
  version: z.literal(VIDEO_BILLING_SNAPSHOT_VERSION),
  modelId: canonicalModelIdSchema,
  resolution: canonicalResolutionSchema,
  unitPrice: videoCreditUnitPriceSchema,
  durationSeconds: durationSecondsSchema,
  quotedCredits: quotedCreditsSchema,
  billingGroupId: canonicalBillingGroupIdSchema,
};

const perSecondSnapshotPayloadSchema = z
  .object({
    ...commonSnapshotPayloadShape,
    mode: z.literal("per_second"),
    unit: z.literal("second"),
  })
  .strict();
const perItemSnapshotPayloadSchema = z
  .object({
    ...commonSnapshotPayloadShape,
    mode: z.literal("per_item"),
    unit: z.literal("item"),
  })
  .strict();
const videoBillingSnapshotPayloadSchema = z.discriminatedUnion("mode", [
  perSecondSnapshotPayloadSchema,
  perItemSnapshotPayloadSchema,
]);

/** 持久化账单快照 schema；未知字段和非规范摘要一律拒绝。 */
export const videoBillingSnapshotSchema = z.discriminatedUnion("mode", [
  perSecondSnapshotPayloadSchema.extend({ digest: digestSchema }).strict(),
  perItemSnapshotPayloadSchema.extend({ digest: digestSchema }).strict(),
]);

/** 创建时固定且在任务生命周期内不可变的视频账单事实。 */
export type VideoBillingSnapshot = z.infer<typeof videoBillingSnapshotSchema>;

type VideoBillingSnapshotPayload = z.infer<
  typeof videoBillingSnapshotPayloadSchema
>;

/** 视频任务账单解析结果；只有升级前能力版本可以进入 legacy。 */
export type VideoTaskBilling =
  | {
      readonly kind: "legacy";
      readonly mode: "per_second";
      readonly unit: "second";
    }
  | { readonly kind: "snapshot"; readonly snapshot: VideoBillingSnapshot };

/**
 * 按固定字段顺序序列化快照摘要载荷。
 *
 * @param payload - 已通过严格 schema 的不可变账单字段。
 * @returns 与对象插入顺序无关的规范 JSON 文本。
 * @sideEffects 无。
 * @failure 不抛错；schema 已排除非有限数值和未定义字段。
 */
function serializeCanonicalSnapshotPayload(
  payload: VideoBillingSnapshotPayload
): string {
  return JSON.stringify({
    version: payload.version,
    modelId: payload.modelId,
    resolution: payload.resolution,
    mode: payload.mode,
    unit: payload.unit,
    unitPrice: payload.unitPrice,
    durationSeconds: payload.durationSeconds,
    quotedCredits: payload.quotedCredits,
    billingGroupId: payload.billingGroupId,
  });
}

/**
 * 计算规范账单快照摘要。
 *
 * @param payload - 已验证的不可变账单字段。
 * @returns 64 位小写 SHA-256 十六进制摘要。
 * @sideEffects 无。
 * @failure 不抛错。
 */
function digestSnapshotPayload(payload: VideoBillingSnapshotPayload): string {
  return createHash("sha256")
    .update(serializeCanonicalSnapshotPayload(payload), "utf8")
    .digest("hex");
}

/**
 * 验证快照报价总额能由模式、单价和时长唯一重建。
 *
 * @param payload - 已完成基础字段校验的快照载荷。
 * @sideEffects 无。
 * @throws Error - 总额与统一计费算法不一致时视为篡改并 fail closed。
 */
function assertSnapshotQuote(payload: VideoBillingSnapshotPayload): void {
  const expected = getVideoBillingCreditCost({
    mode: payload.mode,
    unitPrice: payload.unitPrice,
    durationSeconds: payload.durationSeconds,
  });
  if (payload.quotedCredits !== expected) {
    throw new Error("视频账单快照报价总额与单价不一致");
  }
}

/**
 * 从严格报价构造可持久化的不可变账单快照。
 *
 * @param input.quote - DB-free 严格解析器产生的权威报价。
 * @param input.billingGroupId - 创建时由服务端选定的可信计费分组 ID。
 * @returns 带规范 SHA-256 摘要的新快照对象。
 * @sideEffects 无。
 * @throws Error - 报价字段或分组 ID 非法时 fail closed。
 */
export function createVideoBillingSnapshot(input: {
  quote: VideoBillingQuote;
  billingGroupId: string;
}): VideoBillingSnapshot {
  const payload = videoBillingSnapshotPayloadSchema.parse({
    version: VIDEO_BILLING_SNAPSHOT_VERSION,
    modelId: input.quote.modelId,
    resolution: input.quote.resolution,
    mode: input.quote.mode,
    unit: input.quote.unit,
    unitPrice: input.quote.unitPrice,
    durationSeconds: input.quote.durationSeconds,
    quotedCredits: input.quote.quotedCredits,
    billingGroupId: input.billingGroupId,
  });
  assertSnapshotQuote(payload);
  return videoBillingSnapshotSchema.parse({
    ...payload,
    digest: digestSnapshotPayload(payload),
  });
}

/**
 * 严格解析数据库 metadata 中的账单快照并验证规范摘要。
 *
 * @param value - 未受信任 JSON 值。
 * @returns 与输入隔离、字段完整且摘要有效的账单快照。
 * @sideEffects 无。
 * @throws Error - 版本、字段、模式/单位、总额或摘要非法时 fail closed。
 */
export function parseVideoBillingSnapshot(
  value: unknown
): VideoBillingSnapshot {
  const snapshot = videoBillingSnapshotSchema.parse(value);
  const { digest, ...payloadValue } = snapshot;
  const payload = videoBillingSnapshotPayloadSchema.parse(payloadValue);
  assertSnapshotQuote(payload);
  if (digest !== digestSnapshotPayload(payload)) {
    throw new Error("视频账单快照摘要无效");
  }
  return { ...snapshot };
}

/**
 * 按能力快照版本解析任务账单，封闭 legacy 降级边界。
 *
 * @param metadata - 任务数据库行中的完整 metadata JSON。
 * @returns 新能力版本的严格快照，或旧能力版本的显式 legacy 按秒标记。
 * @sideEffects 无；不会读取当前价格或分组配置。
 * @throws Error - 缺少能力快照、版本未知、版本与账单不匹配或账单非法时 fail closed。
 */
export function resolveVideoTaskBilling(metadata: unknown): VideoTaskBilling {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("视频任务缺少有效 metadata");
  }
  const record = metadata as Record<string, unknown>;
  const capabilityValue = record.videoCapabilitySnapshot;
  if (
    !capabilityValue ||
    typeof capabilityValue !== "object" ||
    Array.isArray(capabilityValue)
  ) {
    throw new Error("视频任务缺少能力快照");
  }
  const capabilityVersion = (capabilityValue as Record<string, unknown>)
    .version;
  const billingValue = record.videoBillingSnapshot;

  if (capabilityVersion === LEGACY_VIDEO_CAPABILITY_SNAPSHOT_VERSION) {
    if (billingValue !== undefined) {
      throw new Error("旧能力快照不能混入新账单快照");
    }
    return { kind: "legacy", mode: "per_second", unit: "second" };
  }
  if (capabilityVersion !== VIDEO_BILLING_CAPABILITY_SNAPSHOT_VERSION) {
    throw new Error("视频任务的能力快照版本无效");
  }
  if (billingValue === undefined) {
    throw new Error("新视频任务缺少账单快照");
  }
  return {
    kind: "snapshot",
    snapshot: parseVideoBillingSnapshot(billingValue),
  };
}
