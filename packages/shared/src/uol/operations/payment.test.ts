/**
 * 支付 UOL 注册契约测试。
 *
 * 证明用户查询只允许本人会话，管理端查询只允许真实管理员人工会话；所有读取均拒绝
 * 客户端伪造用户身份字段。
 */
import { describe, expect, it } from "vitest";

import { getOperation } from "../registry";
import "./payment";

describe("payment UOL contract", () => {
  it("registers recent orders as a bounded current-user read", () => {
    const operation = getOperation("payment.listMyRecentOrders");
    expect(operation).toMatchObject({
      domain: "payment",
      access: { kind: "user" },
      readOnly: true,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
    });
    expect(operation?.input.parse({})).toEqual({ limit: 8 });
    expect(operation?.input.safeParse({ limit: 20 }).success).toBe(true);
    expect(operation?.input.safeParse({ limit: 21 }).success).toBe(false);
    expect(operation?.input.safeParse({ userId: "forged-user" }).success).toBe(
      false
    );
  });

  it("validates complete overview date ranges with a 366-day limit", () => {
    const operation = getOperation("payment.getAdminOverview");
    expect(
      operation?.input.safeParse({
        startDate: "2024-01-01",
        endDate: "2024-12-31",
      }).success
    ).toBe(true);
    expect(
      operation?.input.safeParse({
        startDate: "2024-01-01",
        endDate: "2025-01-01",
      }).success
    ).toBe(false);
    expect(
      operation?.input.safeParse({ startDate: "2026-07-01" }).success
    ).toBe(false);
  });

  it.each([
    "payment.getAdminOverview",
    "payment.listAdminOrders",
    "payment.searchAdminOrderUsers",
  ])("registers %s as a human-only admin read", (name) => {
    const operation = getOperation(name);
    expect(operation).toMatchObject({
      domain: "payment",
      access: { kind: "roles", roles: ["admin", "super_admin"] },
      agentExposure: "human-only",
      readOnly: true,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
    });
    expect(operation?.input.safeParse({ userId: "forged-user" }).success).toBe(
      false
    );
  });
});
