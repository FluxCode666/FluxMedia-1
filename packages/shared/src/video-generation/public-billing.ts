/**
 * 视频计费的传输无关公共 DTO。
 *
 * 使用方：UOL、站内、v1、MCP、回调和历史。契约显式区分当前报价、持久快照与
 * legacy，且不包含内部计费分组、价格来源、成员、凭据、容量或配置 revision。
 */
import { z } from "zod";

import {
  type VideoBillingQuote,
  videoCreditUnitPriceSchema,
} from "../adobe/video-pricing";
import { videoPublicResolutionSchema } from "./contracts";

const actualCreditsSchema = z.number().finite().nonnegative();
const quotedCreditsSchema = z.number().finite().positive();
const quoteTokenSchema = z.string().trim().min(1).max(2_048);

const currentQuoteCommonShape = {
  kind: z.literal("current_quote"),
  resolution: videoPublicResolutionSchema,
  unitPrice: videoCreditUnitPriceSchema,
  quoteToken: quoteTokenSchema,
};

/** 价格发现中的单个分辨率当前报价；token 只能用于该模型与分辨率。 */
export const videoCurrentQuoteSchema = z.discriminatedUnion("mode", [
  z
    .object({
      ...currentQuoteCommonShape,
      mode: z.literal("per_second"),
      unit: z.literal("second"),
      /** @deprecated 按秒分支兼容字段；按条分支禁止出现。 */
      creditsPerSecond: videoCreditUnitPriceSchema,
    })
    .strict(),
  z
    .object({
      ...currentQuoteCommonShape,
      mode: z.literal("per_item"),
      unit: z.literal("item"),
    })
    .strict(),
]);

const snapshotCommonShape = {
  kind: z.literal("snapshot"),
  unitPrice: videoCreditUnitPriceSchema,
  durationSeconds: z.number().int().positive(),
  quotedCredits: quotedCreditsSchema,
  actualCredits: actualCreditsSchema,
};

/** 新任务、状态、回调与历史共用的不可变报价加实际结算投影。 */
export const videoSnapshotBillingSchema = z.discriminatedUnion("mode", [
  z
    .object({
      ...snapshotCommonShape,
      mode: z.literal("per_second"),
      unit: z.literal("second"),
      /** @deprecated 按秒分支兼容字段；按条分支禁止出现。 */
      creditsPerSecond: videoCreditUnitPriceSchema,
    })
    .strict(),
  z
    .object({
      ...snapshotCommonShape,
      mode: z.literal("per_item"),
      unit: z.literal("item"),
    })
    .strict(),
]);

/** 升级前任务没有可信创建价，只声明按秒身份和独立实际结算。 */
export const videoLegacyBillingSchema = z
  .object({
    kind: z.literal("legacy"),
    mode: z.literal("per_second"),
    unit: z.literal("second"),
    unitPrice: z.null(),
    creditsPerSecond: z.null(),
    quotedCredits: z.null(),
    actualCredits: actualCreditsSchema,
  })
  .strict();

/** 任务公共计费事实；current_quote 仅用于能力价格发现，不进入任务状态。 */
export const videoTaskBillingSchema = z.discriminatedUnion("kind", [
  videoSnapshotBillingSchema,
  videoLegacyBillingSchema,
]);

/** 能力中的分辨率报价。 */
export type VideoCurrentQuote = z.infer<typeof videoCurrentQuoteSchema>;

/**
 * 把权威内部报价收窄为能力和陈旧报价冲突共用的公共当前报价。
 *
 * @param quote - 已通过计费核心解析的单模型、单分辨率权威报价。
 * @param quoteToken - 与同一报价事实和 Principal 绑定的不透明 token。
 * @returns 不包含内部组、来源、摘要或 revision 的严格 current_quote。
 * @sideEffects 无。
 */
export function projectVideoCurrentQuote(
  quote: VideoBillingQuote,
  quoteToken: string
): VideoCurrentQuote {
  return quote.mode === "per_second"
    ? {
        kind: "current_quote",
        resolution: quote.resolution,
        mode: quote.mode,
        unit: quote.unit,
        unitPrice: quote.unitPrice,
        creditsPerSecond: quote.unitPrice,
        quoteToken,
      }
    : {
        kind: "current_quote",
        resolution: quote.resolution,
        mode: quote.mode,
        unit: quote.unit,
        unitPrice: quote.unitPrice,
        quoteToken,
      };
}

/** 新任务的公共账单快照投影。 */
export type VideoSnapshotBilling = z.infer<typeof videoSnapshotBillingSchema>;

/** 新任务或 legacy 任务的公共账单联合。 */
export type VideoTaskPublicBilling = z.infer<typeof videoTaskBillingSchema>;
