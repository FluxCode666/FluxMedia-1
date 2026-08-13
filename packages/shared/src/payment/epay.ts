/**
 * Epay client helpers.
 *
 * Compatible with common 易支付 submit.php integrations. The signing rules
 * mirror new-api's go-epay usage: filter empty values plus sign/sign_type,
 * sort keys, join as query string, append merchant key, then MD5.
 */

import crypto from "node:crypto";
import { db } from "@repo/database";
import { epayOrder } from "@repo/database/schema";
import { eq } from "drizzle-orm";
import { getBaseUrl } from "../config/payment";
import {
  getRuntimeSettingSelect,
  getRuntimeSettingString,
} from "../system-settings";
import type { RuntimePaymentProvider } from "./provider-policy";

export const EPAY_TRADE_SUCCESS = "TRADE_SUCCESS";

export type PaymentProvider = RuntimePaymentProvider;
export type EpayBusinessType = "credit_purchase" | "subscription";

interface EpayMetadataBase {
  userId: string;
  outTradeNo: string;
  /** 积分订单统一支付结果页使用的本地 payment_order ID。 */
  paymentOrderId?: string;
  /** 用户发起支付时的语言，用于签名回跳后恢复到正确的结果页。 */
  locale?: "en" | "zh";
}

/** 当前唯一允许新建的易支付 metadata。 */
export interface EpayCreditPurchaseMetadata extends EpayMetadataBase {
  type: "credit_purchase";
  packageId?: string;
  quantity?: number;
}

/** 仅用于解码历史订单的订阅 metadata，不得用于新建订单或编码。 */
export interface EpayHistoricalSubscriptionMetadata extends EpayMetadataBase {
  type: "subscription";
  priceId?: string;
  planId?: string;
  checkoutMode?: "new_subscription" | "upgrade";
  expectedAmount?: number;
  originalAmount?: number;
  prorationCredit?: number;
  remainingDays?: number;
  periodDays?: number;
  upgradeFromPriceId?: string;
}

export type EpayMetadata =
  | EpayCreditPurchaseMetadata
  | EpayHistoricalSubscriptionMetadata;

export interface EpayPurchaseInput {
  outTradeNo: string;
  name: string;
  money: number | string;
  type?: string;
  notifyUrl?: string;
  returnUrl?: string;
  param?: string;
}

export interface EpayPurchaseResult {
  url: string;
  params: Record<string, string>;
}

export interface EpayVerifyResult {
  verifyStatus: boolean;
  type: string;
  tradeNo: string;
  outTradeNo: string;
  name: string;
  money: string;
  tradeStatus: string;
  param?: string;
  raw: Record<string, string>;
}

export type EpayOrderStatus = "pending" | "fulfilling" | "success" | "failed";

export function getPaymentProvider(): PaymentProvider {
  const providerValues = [
    process.env.PAYMENT_PROVIDER,
    process.env.NEXT_PUBLIC_PAYMENT_PROVIDER,
  ]
    .map((provider) => provider?.trim().toLowerCase())
    .filter((provider): provider is string => Boolean(provider));

  if (providerValues.includes("none")) {
    return "none";
  }

  if (providerValues.includes("alipay_f2f")) {
    return "alipay_f2f";
  }
  if (providerValues.includes("epay")) {
    return "epay";
  }
  if (providerValues.includes("creem") || providerValues.length === 0) {
    return "creem";
  }

  // 未知通道绝不能静默回退至 Creem，否则错误的后台配置会在无 API Key 时
  // 触发远程请求。关闭支付比误路由资金操作更安全。
  return "none";
}

export function isEpayPaymentProvider(): boolean {
  return getPaymentProvider() === "epay";
}

export async function getRuntimePaymentProvider(): Promise<PaymentProvider> {
  return getRuntimeSettingSelect(
    "PAYMENT_PROVIDER",
    ["creem", "epay", "alipay_f2f", "none"] as const,
    getPaymentProvider()
  );
}

export async function isRuntimeEpayPaymentProvider(): Promise<boolean> {
  return (await getRuntimePaymentProvider()) === "epay";
}

export function getEpayDefaultPaymentType(): string {
  return (
    process.env.EPAY_DEFAULT_PAYMENT_TYPE ??
    process.env.NEXT_PUBLIC_EPAY_DEFAULT_PAYMENT_TYPE ??
    "alipay"
  ).trim();
}

function getEpayNotifyUrl(): string | undefined {
  const notifyUrl = process.env.EPAY_NOTIFY_URL?.trim();
  return notifyUrl || undefined;
}

function getEpayReturnUrl(baseUrl: string): string {
  return `${baseUrl}/api/payments/epay/return`;
}

function getEpayConfig() {
  const pid = process.env.EPAY_PID?.trim() ?? "";
  const key = process.env.EPAY_KEY?.trim() ?? "";
  const apiUrl = process.env.EPAY_API_URL?.trim() ?? "";

  if (!pid || !key || !apiUrl) {
    throw new Error("EPAY_PID, EPAY_KEY and EPAY_API_URL must be configured");
  }

  return { pid, key, apiUrl };
}

function getEpaySubmitUrl(apiUrl: string): URL {
  const submitUrl = new URL(apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
  submitUrl.pathname = `${submitUrl.pathname.replace(/\/+$/, "")}/submit.php`;
  return submitUrl;
}

async function getRuntimeEpayConfig() {
  const pid = (await getRuntimeSettingString("EPAY_PID")) ?? "";
  const key = (await getRuntimeSettingString("EPAY_KEY")) ?? "";
  const apiUrl = (await getRuntimeSettingString("EPAY_API_URL")) ?? "";

  if (!pid || !key || !apiUrl) {
    throw new Error("EPAY_PID, EPAY_KEY and EPAY_API_URL must be configured");
  }

  return { pid, key, apiUrl };
}

export function isEpayConfigured(): boolean {
  return Boolean(
    process.env.EPAY_PID?.trim() &&
      process.env.EPAY_KEY?.trim() &&
      process.env.EPAY_API_URL?.trim()
  );
}

export async function isRuntimeEpayConfigured(): Promise<boolean> {
  return Boolean(
    (await getRuntimeSettingString("EPAY_PID")) &&
      (await getRuntimeSettingString("EPAY_KEY")) &&
      (await getRuntimeSettingString("EPAY_API_URL"))
  );
}

function formatMoney(money: number | string): string {
  if (typeof money === "number") {
    return money.toFixed(2);
  }
  return money;
}

function filterParams(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([key, value]) => key !== "sign" && key !== "sign_type" && value !== ""
    )
  );
}

function buildSignPayload(params: Record<string, string>): string {
  const filtered = filterParams(params);
  return Object.keys(filtered)
    .sort()
    .map((key) => `${key}=${filtered[key]}`)
    .join("&");
}

export function signEpayParams(
  params: Record<string, string>,
  key?: string
): string {
  const merchantKey = key ?? getEpayConfig().key;
  return crypto
    .createHash("md5")
    .update(buildSignPayload(params) + merchantKey)
    .digest("hex");
}

export async function signRuntimeEpayParams(
  params: Record<string, string>
): Promise<string> {
  const { key } = await getRuntimeEpayConfig();
  return crypto
    .createHash("md5")
    .update(buildSignPayload(params) + key)
    .digest("hex");
}

export function withEpaySignature(
  params: Record<string, string>
): Record<string, string> {
  return {
    ...params,
    sign: signEpayParams(params),
    sign_type: "MD5",
  };
}

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createEpayPurchase(
  input: EpayPurchaseInput
): EpayPurchaseResult {
  const { pid, apiUrl } = getEpayConfig();
  const baseUrl = getBaseUrl();
  const notifyUrl = input.notifyUrl ?? getEpayNotifyUrl();
  const params: Record<string, string> = {
    pid,
    type: input.type || getEpayDefaultPaymentType(),
    out_trade_no: input.outTradeNo,
    notify_url: notifyUrl ?? `${baseUrl}/api/webhooks/epay`,
    return_url: input.returnUrl ?? getEpayReturnUrl(baseUrl),
    name: input.name,
    money: formatMoney(input.money),
    device: "pc",
    sign_type: "MD5",
  };

  const signedParams = withEpaySignature(params);
  const submitUrl = getEpaySubmitUrl(apiUrl);

  return {
    url: submitUrl.toString(),
    params: signedParams,
  };
}

export async function createRuntimeEpayPurchase(
  input: EpayPurchaseInput
): Promise<EpayPurchaseResult> {
  const { pid, apiUrl } = await getRuntimeEpayConfig();
  const baseUrl = getBaseUrl();
  const notifyUrl =
    input.notifyUrl ??
    (await getRuntimeSettingString("EPAY_NOTIFY_URL")) ??
    `${baseUrl}/api/webhooks/epay`;
  const paymentType =
    input.type ??
    (await getRuntimeSettingString("EPAY_DEFAULT_PAYMENT_TYPE")) ??
    "alipay";
  const params: Record<string, string> = {
    pid,
    type: paymentType,
    out_trade_no: input.outTradeNo,
    notify_url: notifyUrl,
    return_url: input.returnUrl ?? getEpayReturnUrl(baseUrl),
    name: input.name,
    money: formatMoney(input.money),
    device: "pc",
    sign_type: "MD5",
  };

  const signedParams = {
    ...params,
    sign: await signRuntimeEpayParams(params),
    sign_type: "MD5",
  };
  const submitUrl = getEpaySubmitUrl(apiUrl);

  return {
    url: submitUrl.toString(),
    params: signedParams,
  };
}

export async function saveEpayOrder(
  metadata: EpayCreditPurchaseMetadata,
  amount: number | string
): Promise<void> {
  await db
    .insert(epayOrder)
    .values({
      outTradeNo: metadata.outTradeNo,
      userId: metadata.userId,
      businessType: metadata.type,
      amount: Number(formatMoney(amount)),
      status: "pending",
      metadata: metadata as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: epayOrder.outTradeNo,
      set: {
        userId: metadata.userId,
        businessType: metadata.type,
        amount: Number(formatMoney(amount)),
        status: "pending",
        metadata: metadata as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      },
    });
}

export async function getEpayOrderMetadata(
  outTradeNo: string
): Promise<EpayMetadata | null> {
  if (!outTradeNo) return null;

  const [order] = await db
    .select({
      metadata: epayOrder.metadata,
    })
    .from(epayOrder)
    .where(eq(epayOrder.outTradeNo, outTradeNo))
    .limit(1);

  if (!order?.metadata) return null;
  return normalizeEpayMetadata(order.metadata);
}

export async function getEpayOrderStatus(
  outTradeNo: string
): Promise<EpayOrderStatus | null> {
  if (!outTradeNo) return null;

  const [order] = await db
    .select({ status: epayOrder.status })
    .from(epayOrder)
    .where(eq(epayOrder.outTradeNo, outTradeNo))
    .limit(1);

  return (order?.status as EpayOrderStatus | undefined) ?? null;
}

export function verifyEpayParams(
  params: Record<string, string>
): EpayVerifyResult {
  const receivedSign = params.sign ?? "";
  const expectedSign = signEpayParams(params);
  const verifyStatus = timingSafeEqualString(
    receivedSign.toLowerCase(),
    expectedSign.toLowerCase()
  );

  const result: EpayVerifyResult = {
    verifyStatus,
    type: params.type ?? "",
    tradeNo: params.trade_no ?? "",
    outTradeNo: params.out_trade_no ?? "",
    name: params.name ?? "",
    money: params.money ?? "",
    tradeStatus: params.trade_status ?? "",
    raw: params,
  };

  if (params.param !== undefined) {
    result.param = params.param;
  }

  return result;
}

export async function verifyRuntimeEpayParams(
  params: Record<string, string>
): Promise<EpayVerifyResult> {
  const receivedSign = params.sign ?? "";
  const expectedSign = await signRuntimeEpayParams(params);
  const verifyStatus = timingSafeEqualString(
    receivedSign.toLowerCase(),
    expectedSign.toLowerCase()
  );

  const result: EpayVerifyResult = {
    verifyStatus,
    type: params.type ?? "",
    tradeNo: params.trade_no ?? "",
    outTradeNo: params.out_trade_no ?? "",
    name: params.name ?? "",
    money: params.money ?? "",
    tradeStatus: params.trade_status ?? "",
    raw: params,
  };

  if (params.param !== undefined) {
    result.param = params.param;
  }

  return result;
}

export async function parseEpayRequestParams(
  req: Request
): Promise<Record<string, string>> {
  const params: Record<string, string> = {};

  if (req.method === "GET") {
    const url = new URL(req.url);
    url.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return params;
  }

  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = (await req.json()) as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") {
        params[key] = value;
      } else if (value !== null && value !== undefined) {
        params[key] = String(value);
      }
    }
    return params;
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await req.formData();
    formData.forEach((value, key) => {
      if (typeof value === "string") {
        params[key] = value;
      }
    });
    return params;
  }

  const body = await req.text();
  new URLSearchParams(body).forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

export function encodeEpayMetadata(
  metadata: EpayCreditPurchaseMetadata
): string {
  const compact: Record<string, unknown> = {
    t: "c",
    u: metadata.userId,
    o: metadata.outTradeNo,
  };

  if (metadata.packageId) compact.g = metadata.packageId;
  if (metadata.quantity && metadata.quantity > 1) compact.q = metadata.quantity;
  if (metadata.paymentOrderId) compact.i = metadata.paymentOrderId;
  if (metadata.locale) compact.z = metadata.locale;

  return Buffer.from(JSON.stringify(compact), "utf8").toString("base64url");
}

export function decodeEpayMetadata(param?: string): EpayMetadata | null {
  if (!param) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(param, "base64url").toString("utf8")
    ) as EpayMetadataPayload;
    return normalizeEpayMetadata(parsed);
  } catch {
    return null;
  }
}

type EpayMetadataPayload = {
  type?: unknown;
  t?: unknown;
  userId?: unknown;
  u?: unknown;
  outTradeNo?: unknown;
  o?: unknown;
  paymentOrderId?: unknown;
  i?: unknown;
  locale?: unknown;
  z?: unknown;
  priceId?: unknown;
  p?: unknown;
  planId?: unknown;
  l?: unknown;
  packageId?: unknown;
  g?: unknown;
  quantity?: unknown;
  q?: unknown;
  checkoutMode?: unknown;
  m?: unknown;
  expectedAmount?: unknown;
  e?: unknown;
  originalAmount?: unknown;
  a?: unknown;
  prorationCredit?: unknown;
  c?: unknown;
  remainingDays?: unknown;
  r?: unknown;
  periodDays?: unknown;
  d?: unknown;
  upgradeFromPriceId?: unknown;
  f?: unknown;
} & Record<string, unknown>;

function normalizeEpayMetadata(
  metadata: EpayMetadataPayload
): EpayMetadata | null {
  const type =
    metadata.type ??
    (metadata.t === "s"
      ? "subscription"
      : metadata.t === "c"
        ? "credit_purchase"
        : undefined);
  const userId = metadata.userId ?? metadata.u;
  const outTradeNo = metadata.outTradeNo ?? metadata.o;
  const priceId = metadata.priceId ?? metadata.p;
  const planId = metadata.planId ?? metadata.l;
  const packageId = metadata.packageId ?? metadata.g;
  const paymentOrderId = metadata.paymentOrderId ?? metadata.i;
  const locale = metadata.locale ?? metadata.z;
  const numberValue = (value: unknown) =>
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : undefined;
  const quantity = numberValue(metadata.quantity ?? metadata.q);
  const checkoutMode =
    metadata.checkoutMode ??
    (metadata.m === "u"
      ? "upgrade"
      : metadata.m === "n"
        ? "new_subscription"
        : undefined);
  const expectedAmount = numberValue(metadata.expectedAmount ?? metadata.e);
  const originalAmount = numberValue(metadata.originalAmount ?? metadata.a);
  const prorationCredit = numberValue(metadata.prorationCredit ?? metadata.c);
  const remainingDays = numberValue(metadata.remainingDays ?? metadata.r);
  const periodDays = numberValue(metadata.periodDays ?? metadata.d);
  const upgradeFromPriceId = metadata.upgradeFromPriceId ?? metadata.f;

  if (
    (type !== "subscription" && type !== "credit_purchase") ||
    typeof userId !== "string" ||
    typeof outTradeNo !== "string"
  ) {
    return null;
  }

  const base: EpayMetadataBase = {
    userId,
    outTradeNo,
  };
  if (typeof paymentOrderId === "string") base.paymentOrderId = paymentOrderId;
  if (locale === "en" || locale === "zh") base.locale = locale;

  if (type === "credit_purchase") {
    return {
      type,
      ...base,
      ...(typeof packageId === "string" && { packageId }),
      ...(typeof quantity === "number" &&
        Number.isFinite(quantity) &&
        quantity > 0 && {
          quantity: Math.floor(quantity),
        }),
    };
  }

  return {
    type,
    ...base,
    ...(typeof priceId === "string" && { priceId }),
    ...(typeof planId === "string" && { planId }),
    ...((checkoutMode === "new_subscription" || checkoutMode === "upgrade") && {
      checkoutMode,
    }),
    ...(typeof expectedAmount === "number" &&
      Number.isFinite(expectedAmount) && {
        expectedAmount,
      }),
    ...(typeof originalAmount === "number" &&
      Number.isFinite(originalAmount) && {
        originalAmount,
      }),
    ...(typeof prorationCredit === "number" &&
      Number.isFinite(prorationCredit) && {
        prorationCredit,
      }),
    ...(typeof remainingDays === "number" &&
      Number.isFinite(remainingDays) && {
        remainingDays,
      }),
    ...(typeof periodDays === "number" &&
      Number.isFinite(periodDays) && {
        periodDays,
      }),
    ...(typeof upgradeFromPriceId === "string" && {
      upgradeFromPriceId,
    }),
  };
}

export function moneyToCents(value: number | string): number {
  const str = typeof value === "number" ? value.toFixed(2) : value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(str)) {
    return Number.NaN;
  }

  const [yuan = "0", cents = ""] = str.split(".");
  return Number(yuan) * 100 + Number(cents.padEnd(2, "0"));
}
