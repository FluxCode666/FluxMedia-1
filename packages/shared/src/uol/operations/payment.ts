/**
 * 管理端支付查询 UOL 操作定义。
 *
 * 使用方：支付管理页面的 Server Action。数据库实现由 apps/web 延迟绑定；操作仅允许
 * 真实 admin / super_admin 人工会话读取，避免财务数据投影到 MCP 或内置 Agent。
 */
import {
  adminPaymentOrderListInputSchema,
  adminPaymentOrderListOutputSchema,
  adminPaymentOverviewInputSchema,
  adminPaymentOverviewOutputSchema,
  adminPaymentUserSearchInputSchema,
  adminPaymentUserSearchOutputSchema,
} from "../../payment/admin-contract";
import { defineOperation } from "../registry";

/** 读取指定自然月的已履约充值收入与全部充值订单数趋势。 */
export const getAdminPaymentOverview = defineOperation({
  name: "payment.getAdminOverview",
  domain: "payment",
  title: "获取支付概览",
  description:
    "按管理员时区读取指定自然月的充值订单，收入按完成时间和币种统计，订单数量按创建时间统计全部支付状态。",
  input: adminPaymentOverviewInputSchema,
  output: adminPaymentOverviewOutputSchema,
  access: { kind: "roles", roles: ["admin", "super_admin"] },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: payment.getAdminOverview");
  },
});

/** 读取全站充值订单的受筛选 keyset 列表。 */
export const listAdminPaymentOrders = defineOperation({
  name: "payment.listAdminOrders",
  domain: "payment",
  title: "查询充值订单",
  description:
    "按用户邮箱、本地订单号和持久支付状态查询全站充值订单，并返回签名 keyset 分页游标。",
  input: adminPaymentOrderListInputSchema,
  output: adminPaymentOrderListOutputSchema,
  access: { kind: "roles", roles: ["admin", "super_admin"] },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: payment.listAdminOrders");
  },
});

/** 为订单筛选器服务端搜索存在充值记录的用户邮箱。 */
export const searchAdminPaymentUsers = defineOperation({
  name: "payment.searchAdminOrderUsers",
  domain: "payment",
  title: "搜索充值用户",
  description:
    "按邮箱片段搜索存在充值订单的用户，返回有界下拉选项，不暴露无充值记录的账号。",
  input: adminPaymentUserSearchInputSchema,
  output: adminPaymentUserSearchOutputSchema,
  access: { kind: "roles", roles: ["admin", "super_admin"] },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: payment.searchAdminOrderUsers");
  },
});
