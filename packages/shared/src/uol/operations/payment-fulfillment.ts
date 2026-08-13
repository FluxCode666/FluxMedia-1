/**
 * 支付履约恢复 UOL 操作。
 *
 * 使用方：全局 internal scheduler。operation 仅接受明确的 payment-fulfillment cron
 * Principal，真实数据库和积分账本实现由 apps/web late binding 注入。
 */
import { z } from "zod";

import { defineOperation } from "../registry";

/** 领取并恢复一批到期支付履约工作项。 */
export const recoverPaymentFulfillments = defineOperation({
  name: "payment.recoverFulfillments",
  domain: "payment",
  title: "Recover Payment Fulfillments",
  description:
    "使用持久工作项、SKIP LOCKED 和 fencing token 恢复已确认支付的积分履约。",
  input: z.object({}).strict(),
  output: z.object({
    expiredEventCount: z.number().int().nonnegative(),
    claimedCount: z.number().int().nonnegative(),
    succeededCount: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    supersededCount: z.number().int().nonnegative(),
  }),
  access: { kind: "cronJob", job: "payment-fulfillment" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["billing", "audit"],
  hasMaintenanceWrite: true,
  /** 未绑定时显式失败，防止 scheduler 静默跳过财务恢复。 */
  async execute() {
    throw new Error("Not yet wired: payment.recoverFulfillments");
  },
});
