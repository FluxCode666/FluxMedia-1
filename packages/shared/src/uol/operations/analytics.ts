/**
 * UOL Analytics 操作定义。
 *
 * 注册本人摘要、趋势、数据看板与管理员用户搜索只读能力；数据库实现由 apps/web 延迟绑定，确保
 * Web、Server Action、MCP 和内置 Agent 共享同一输入输出 schema、权限与 readiness
 * 语义。
 */
import {
  adminDataDashboardInputSchema,
  adminDataDashboardUserSearchInputSchema,
  adminDataDashboardUserSearchOutputSchema,
  dataDashboardInputSchema,
  dataDashboardOutputSchema,
  usageSummaryInputSchema,
  usageSummaryOutputSchema,
  usageTrendsInputSchema,
  usageTrendsOutputSchema,
} from "../../analytics/contracts";
import { defineOperation } from "../registry";

/** 获取当前用户同一自然日范围下的完整数据看板快照。 */
export const getMyDataDashboard = defineOperation({
  name: "analytics.getMyDataDashboard",
  domain: "analytics",
  title: "Get My Data Dashboard",
  description:
    "获取当前用户最多 30 个账号时区自然日内的六项指标、逐日趋势与成功任务构成。" +
    "用户身份只由 user Principal 派生，输入不接受 userId 或其它身份字段。",
  input: dataDashboardInputSchema,
  output: dataDashboardOutputSchema,
  access: { kind: "user" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: analytics.getMyDataDashboard");
  },
});

/** 获取全站生图、生视频与积分用量的管理员数据看板。 */
export const getAdminDataDashboard = defineOperation({
  name: "analytics.getAdminDataDashboard",
  domain: "analytics",
  title: "Get Admin Data Dashboard",
  description: "获取全站或指定用户最多 30 个应用时区自然日内的生成数据看板。",
  input: adminDataDashboardInputSchema,
  output: dataDashboardOutputSchema,
  access: { kind: "roles", roles: ["admin", "super_admin"] },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: analytics.getAdminDataDashboard");
  },
});

/** 为管理员数据看板下拉搜索用户名称或邮箱。 */
export const searchAdminDataDashboardUsers = defineOperation({
  name: "analytics.searchAdminDataDashboardUsers",
  domain: "analytics",
  title: "Search Admin Data Dashboard Users",
  description:
    "按用户名称或邮箱片段搜索管理员数据看板筛选项，返回有界的用户 ID、名称和邮箱。",
  input: adminDataDashboardUserSearchInputSchema,
  output: adminDataDashboardUserSearchOutputSchema,
  access: { kind: "roles", roles: ["admin", "super_admin"] },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: analytics.searchAdminDataDashboardUsers");
  },
});

/** 获取当前用户近 24 小时、模型分布与累计用量摘要。 */
export const getMyUsageSummary = defineOperation({
  name: "analytics.getMyUsageSummary",
  domain: "analytics",
  title: "Get My Usage Summary",
  description:
    "获取当前用户近 24 小时与累计的图片、视频秒数、积分净消耗，" +
    "并返回近 24 小时成功任务的模型使用分布。" +
    "用户身份由 Principal 派生，不接受 userId 参数。",
  input: usageSummaryInputSchema,
  output: usageSummaryOutputSchema,
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: analytics.getMyUsageSummary");
  },
});

/** 获取当前用户按小时/天的单指标趋势与任务类型分布。 */
export const getMyUsageTrends = defineOperation({
  name: "analytics.getMyUsageTrends",
  domain: "analytics",
  title: "Get My Usage Trends",
  description:
    "查询当前用户按小时或按天的生图/生视频趋势与同范围任务类型分布。" +
    "积分不进入时间范围图表，范围和用户身份由统一契约与 Principal 控制。",
  input: usageTrendsInputSchema,
  output: usageTrendsOutputSchema,
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: analytics.getMyUsageTrends");
  },
});
