/**
 * 运营总览基础事实 UOL 注册测试。
 *
 * 使用方：Vitest；固定访问与 epoch operation 的权限、幂等、维护写和人工暴露边界。
 */
import { describe, expect, it } from "vitest";

import {
  initializeOperationsEpoch,
  recordWebVisit,
} from "./operations-dashboard-facts";

describe("operations dashboard fact operations", () => {
  it("网页访问只允许真实 session user 且为自然幂等维护写", () => {
    expect(recordWebVisit).toMatchObject({
      name: "operations.recordWebVisit",
      domain: "operations",
      access: { kind: "user" },
      agentExposure: "human-only",
      readOnly: false,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
      hasMaintenanceWrite: true,
    });
  });

  it("epoch 初始化只允许 system 且要求全局幂等键和审计", () => {
    expect(initializeOperationsEpoch).toMatchObject({
      name: "operations.initializeEpoch",
      domain: "operations",
      access: { kind: "system" },
      agentExposure: "human-only",
      readOnly: false,
      destructive: false,
      idempotency: {
        kind: "required",
        keyField: "requestId",
        scope: "global",
      },
      sideEffects: ["audit"],
      hasMaintenanceWrite: true,
    });
  });
});
