/**
 * 管理状态页只读 UOL 操作。
 *
 * 使用方：状态页 Server Component。真实数据库读取由 Web binding 注入，且操作仅向
 * 具备后端池查看权限的人工管理员开放，不扩大 MCP 或站内 Agent 能力面。
 */
import {
  adminStatusErrorListInputSchema,
  adminStatusErrorListOutputSchema,
} from "../../image-generation/admin-status-errors-contract";
import { defineOperation } from "../registry";

export const listAdminStatusErrors = defineOperation({
  name: "image.listAdminStatusErrors",
  domain: "image-generation",
  title: "查询管理状态历史错误",
  description: "按绝对时间范围分页读取全站失败生成记录及精确总数。",
  input: adminStatusErrorListInputSchema,
  output: adminStatusErrorListOutputSchema,
  access: { kind: "imageBackendPoolViewer" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    throw new Error("Not yet wired: image.listAdminStatusErrors");
  },
});
