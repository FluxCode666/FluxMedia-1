/**
 * 支付查询 UOL 操作定义。
 *
 * 使用方：用户钱包与支付管理页面的 Server Action。数据库实现由 apps/web 延迟绑定；
 * 用户查询只读取本人订单，管理端查询只允许真实 admin / super_admin 人工会话。
 */
import {
  adminPaymentOrderListInputSchema,
  adminPaymentOrderListOutputSchema,
  adminPaymentOverviewInputSchema,
  adminPaymentOverviewOutputSchema,
  adminPaymentUserSearchInputSchema,
  adminPaymentUserSearchOutputSchema,
} from "../../payment/admin-contract";
import {
  userPaymentOrderListInputSchema,
  userPaymentOrderListOutputSchema,
} from "../../payment/user-order-contract";
import { defineOperation } from "../registry";

/** 读取当前用户最近创建的积分充值订单。 */
export const listMyRecentPaymentOrders = defineOperation({
  name: "payment.listMyRecentOrders",
  domain: "payment",
  title: "查询我的最近充值订单",
  description:
    "按创建时间倒序读取当前登录用户的最近积分充值订单。用户身份仅从 Principal 派生，返回值不包含渠道交易号或其他用户信息。",
  input: userPaymentOrderListInputSchema,
  output: userPaymentOrderListOutputSchema,
  access: { kind: "user" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: payment.listMyRecentOrders");
  },
});

/** 读取指定日期范围的已履约充值收入与全部充值订单数趋势。 */
export const getAdminPaymentOverview = defineOperation({
  name: "payment.getAdminOverview",
  domain: "payment",
  title: "获取支付概览",
  description:
    "按部署时区读取指定日期范围的充值订单，收入按完成时间和币种统计，订单数量按创建时间统计全部支付状态；缺省范围为当前自然月。",
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
    "按创建日期范围、用户邮箱、本地订单号和持久支付状态查询全站充值订单；默认读取部署时区中的最近 7 个自然日，并返回签名 keyset 分页游标。",
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
