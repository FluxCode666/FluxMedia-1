/**
 * 运营总览基础事实 UOL 注册测试。
 *
 * 使用方：Vitest；固定访问与自动 epoch operation 的权限、幂等和维护写边界。
 */
import { describe, expect, it } from "vitest";

import {
  ensureCurrentOperationsEpoch,
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

  it("自动 epoch 门禁只允许 system 并以数据库单例自然幂等", () => {
    expect(ensureCurrentOperationsEpoch).toMatchObject({
      name: "operations.ensureCurrentEpoch",
      domain: "operations",
      access: { kind: "system" },
      agentExposure: "human-only",
      readOnly: false,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: ["audit"],
      hasMaintenanceWrite: true,
    });
  });
});
