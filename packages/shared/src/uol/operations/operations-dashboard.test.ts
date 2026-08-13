/**
 * 运营总览 UOL operation 注册测试。
 *
 * 使用方：Vitest。锁定管理员权限、人工暴露、导出幂等键和后台 job 身份，防止
 * 页面或未来 MCP 适配误把运营敏感能力暴露给普通用户或 Agent。
 */
import { describe, expect, it } from "vitest";

import {
  createOperationsExport,
  expireOperationsExports,
  getOperationsDetail,
  getOperationsOverview,
  listOperationsExports,
  prepareOperationsExportDownload,
  processOperationsExports,
  retryOperationsExport,
} from "./operations-dashboard";

const adminNames = [
  getOperationsOverview,
  getOperationsDetail,
  createOperationsExport,
  listOperationsExports,
  retryOperationsExport,
  prepareOperationsExportDownload,
];

describe("operations dashboard operations", () => {
  it("读取与导出人工能力只允许 admin/super_admin", () => {
    for (const operation of adminNames) {
      expect(operation).toMatchObject({
        domain: "operations",
        access: { kind: "roles", roles: ["admin", "super_admin"] },
        agentExposure: "human-only",
      });
    }
  });

  it("overview/detail 是天然幂等只读 operation", () => {
    for (const operation of [getOperationsOverview, getOperationsDetail]) {
      expect(operation).toMatchObject({
        readOnly: true,
        destructive: false,
        idempotency: { kind: "natural" },
        sideEffects: [],
      });
    }
  });

  it("创建和重试必须携带 per-principal clientRequestId", () => {
    for (const operation of [createOperationsExport, retryOperationsExport]) {
      expect(operation).toMatchObject({
        readOnly: false,
        idempotency: {
          kind: "required",
          keyField: "clientRequestId",
          scope: "per-principal",
        },
        sideEffects: ["queue", "audit"],
      });
    }
  });

  it("worker operation 只能通过固定 cron job 声明鉴权", () => {
    expect(processOperationsExports).toMatchObject({
      access: { kind: "cronJob", job: "operations-export" },
      hasMaintenanceWrite: true,
    });
    expect(expireOperationsExports).toMatchObject({
      access: { kind: "cronJob", job: "operations-export-retention" },
      destructive: true,
      hasMaintenanceWrite: true,
    });
  });

  it("严格拒绝伪造身份字段和不支持的导出模块", () => {
    expect(
      getOperationsOverview.input.safeParse({ userId: "other-user" }).success
    ).toBe(false);
    expect(
      createOperationsExport.input.safeParse({
        exportType: "system_health",
        query: {},
        clientRequestId: "request-1",
      }).success
    ).toBe(false);
  });
});
