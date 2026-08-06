/**
 * Creem API 客户端
 *
 * 提供与 Creem 支付平台的 API 交互
 * 文档: https://docs.creem.io/api-reference
 */

import crypto from "node:crypto";
import { z } from "zod";
import { getRuntimeSettingString } from "../system-settings";

async function getRuntimeCreemApiKey() {
  return (await getRuntimeSettingString("CREEM_API_KEY")) ?? "";
}

async function requireRuntimeCreemApiKey(): Promise<string> {
  const apiKey = (await getRuntimeCreemApiKey()).trim();
  if (!apiKey) {
    throw new Error("Creem API Key 未配置，请在系统设置中填写后再发起支付");
  }
  return apiKey;
}

function getCreemApiBase(apiKey: string): string {
  return apiKey.startsWith("creem_test_")
    ? "https://test-api.creem.io/v1"
    : "https://api.creem.io/v1";
}

/**
 * 校验 Creem 结账和 webhook 履约所需的完整服务端配置。
 *
 * 支付按钮若只校验 API Key，会产生用户可以付款、服务端却不能验签发放权益的
 * 半配置状态。因此在创建结账前同时要求 API Key 与 Webhook Secret。
 */
export async function assertRuntimeCreemCheckoutConfigured(): Promise<void> {
  const [apiKey, webhookSecret] = await Promise.all([
    getRuntimeCreemApiKey(),
    getRuntimeSettingString("CREEM_WEBHOOK_SECRET"),
  ]);
  if (!apiKey.trim() || !webhookSecret?.trim()) {
    throw new Error(
      "Creem 支付通道未完整配置，请在系统设置中填写 API Key 和 Webhook Secret"
    );
  }
}

// ============================================
// 类型定义
// ============================================

export interface CreemCheckoutParams {
  /** Creem 产品 ID */
  product_id: string;
  /** 支付成功后的重定向 URL */
  success_url: string;
  /** 请求 ID（用于幂等性） */
  request_id?: string;
  /** 自定义元数据 */
  metadata?: Record<string, string>;
}

export interface CreemCheckoutResponse {
  /** Checkout ID */
  id: string;
  /** Checkout URL（重定向用户到此 URL 完成支付） */
  checkout_url: string;
  /** 状态 */
  status: string;
}

export interface CreemSubscription {
  /** 订阅 ID */
  id: string;
  /** 订阅状态 */
  status: "active" | "canceled" | "past_due" | "trialing" | "paused";
  /** 产品（可能是 ID 字符串或完整对象） */
  product:
    | string
    | {
        id: string;
        name?: string;
        price?: number;
        currency?: string;
        billing_type?: string;
        billing_period?: string;
      };
  /** 客户（可能是 ID 字符串或完整对象） */
  customer: string | { id: string; email?: string; name?: string };
  /** 当前周期开始时间 (ISO 8601) */
  current_period_start_date: string;
  /** 当前周期结束时间 (ISO 8601) */
  current_period_end_date: string;
  /** 是否在周期结束时取消 */
  cancel_at_period_end: boolean;
  /** 元数据 */
  metadata?: Record<string, string>;
}

export interface CreemCustomer {
  /** 客户 ID */
  id: string;
  /** 邮箱 */
  email: string;
  /** 名称 */
  name?: string;
  /** 元数据 */
  metadata?: Record<string, string>;
}

export interface CreemWebhookEvent {
  /** 事件 ID */
  id: string;
  /** 事件类型 (Creem 使用 eventType 驼峰命名) */
  eventType:
    | "checkout.completed"
    | "subscription.active"
    | "subscription.canceled"
    | "subscription.renewed"
    | "subscription.paused"
    | "subscription.past_due"
    | "subscription.paid"
    | "subscription.expired";
  /** 事件数据 (Creem 直接在顶层使用 object，不嵌套在 data 里) */
  object: CreemCheckoutCompletedData | CreemSubscription;
  /** 创建时间 (Unix 毫秒时间戳) */
  created_at: number;
}

export interface CreemCheckoutCompletedData {
  /** Checkout ID */
  id: string;
  /** Checkout 对象类型 */
  object: "checkout";
  /** 请求 ID（幂等性） */
  request_id?: string;
  /** 订单信息 */
  order?: {
    object: "order";
    id: string;
    customer: string;
    product: string;
    amount: number;
    currency: string;
    status: string;
    type: "onetime" | "subscription";
    transaction?: string;
  };
  /** 产品信息 */
  product?: {
    id: string;
    name: string;
    price: number;
    currency: string;
    billing_type: "onetime" | "recurring";
    billing_period: string;
  };
  /** 订阅信息（如果是订阅支付） */
  subscription?: CreemSubscription;
  /** 客户信息 */
  customer: CreemCustomer;
  /** Checkout 状态 */
  status: string;
  /** 元数据 */
  metadata?: Record<string, string>;
  /** 模式 */
  mode?: "test" | "live";
}

// ============================================
// Webhook 事件运行时校验（Zod）
// ============================================

/**
 * Creem 已知的 Webhook 事件类型。
 *
 * 与 CreemWebhookEvent.eventType 保持一致；Creem 新增类型时需同步此处，
 * 未知类型会在 parseCreemWebhookEvent 处被拒绝并记录，避免静默走错分支。
 */
const CREEM_WEBHOOK_EVENT_TYPES = [
  "checkout.completed",
  "subscription.active",
  "subscription.canceled",
  "subscription.renewed",
  "subscription.paused",
  "subscription.past_due",
  "subscription.paid",
  "subscription.expired",
] as const;

/**
 * Webhook 事件体的运行时 schema。
 *
 * WHY：Creem 直接在顶层使用 eventType + object，过去仅以 `as CreemWebhookEvent`
 * 盲转，Creem 改字段或发未预期事件时类型系统无保护（运行时 undefined 解引用
 * 或静默走错分支）。此处用 Zod 在验签后做结构校验，违反 CLAUDE.md
 * “校验一切外部输入优先 Zod”。object 用 passthrough 保留未知字段，仅保证它是对象，
 * 具体变体字段由各 handler 自行判空读取，避免对 Creem 字段演进过度脆弱。
 */
const creemWebhookEventSchema = z
  .object({
    id: z.string(),
    eventType: z.enum(CREEM_WEBHOOK_EVENT_TYPES),
    object: z.object({}).passthrough(),
    created_at: z.number(),
  })
  .passthrough();

/**
 * 解析并运行时校验 Webhook 事件体。
 *
 * @param payload - 已验签的原始请求体（JSON 字符串）
 * @returns 结构校验通过的事件对象
 * @throws 当 JSON 非法或结构不符（含未知 eventType）时抛错，由调用方记日志并返回 4xx
 */
export function parseCreemWebhookEvent(payload: string): CreemWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid webhook payload: not valid JSON");
  }

  const result = creemWebhookEventSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid webhook event shape: ${result.error.issues
        .map((issue) => issue.path.join(".") || "<root>")
        .join(", ")}`
    );
  }

  // schema 已校验 eventType/object/created_at 的运行时形状；object 仅保证是对象，
  // 其 CreemSubscription / CreemCheckoutCompletedData 变体字段由各 handler 判空读取，
  // 故经 unknown 收窄回声明类型（运行时已验签 + 结构校验，非裸 as 盲转）。
  return result.data as unknown as CreemWebhookEvent;
}

// ============================================
// API 客户端
// ============================================

/**
 * Creem API 客户端
 */
export const creem = {
  /**
   * 创建 Checkout Session
   *
   * @param params - Checkout 参数
   * @returns Checkout 响应（包含重定向 URL）
   */
  async createCheckout(
    params: CreemCheckoutParams
  ): Promise<CreemCheckoutResponse> {
    const apiKey = await requireRuntimeCreemApiKey();
    const res = await fetch(`${getCreemApiBase(apiKey)}/checkouts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Creem API error: ${res.status} - ${error}`);
    }

    return res.json();
  },

  /**
   * 获取客户信息
   *
   * @param customerId - 客户 ID
   * @returns 客户信息
   */
  async getCustomer(customerId: string): Promise<CreemCustomer> {
    const apiKey = await requireRuntimeCreemApiKey();
    const res = await fetch(
      `${getCreemApiBase(apiKey)}/customers/${customerId}`,
      {
        headers: {
          "x-api-key": apiKey,
        },
      }
    );

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Creem API error: ${res.status} - ${error}`);
    }

    return res.json();
  },
};

// ============================================
// Webhook 签名验证
// ============================================

/**
 * 验证 Creem Webhook 签名
 *
 * @param payload - 原始请求体
 * @param signature - creem-signature 头
 * @param secret - Webhook 密钥
 * @returns 是否验证通过
 */
export function verifyCreemWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  const computedBuf = Buffer.from(expectedSignature);
  const receivedBuf = Buffer.from(signature);
  if (computedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(computedBuf, receivedBuf);
}

/**
 * 解析并验证 Creem Webhook 事件
 *
 * @param payload - 原始请求体
 * @param signature - creem-signature 头
 * @returns 解析后的事件对象
 * @throws 如果签名验证失败
 */
export function constructCreemEvent(
  payload: string,
  signature: string
): CreemWebhookEvent {
  const secret = process.env.CREEM_WEBHOOK_SECRET;
  if (!secret) throw new Error("CREEM_WEBHOOK_SECRET is not configured");

  if (!verifyCreemWebhookSignature(payload, signature, secret)) {
    throw new Error("Invalid webhook signature");
  }

  return parseCreemWebhookEvent(payload);
}

export async function constructRuntimeCreemEvent(
  payload: string,
  signature: string
): Promise<CreemWebhookEvent> {
  const secret = await getRuntimeSettingString("CREEM_WEBHOOK_SECRET");
  if (!secret) throw new Error("CREEM_WEBHOOK_SECRET is not configured");

  if (!verifyCreemWebhookSignature(payload, signature, secret)) {
    throw new Error("Invalid webhook signature");
  }

  return parseCreemWebhookEvent(payload);
}
