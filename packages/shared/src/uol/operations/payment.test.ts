/**
 * 管理端支付 UOL 注册契约测试。
 *
 * 证明三项财务读取只允许真实管理员人工会话、保持只读且拒绝伪造用户身份字段。
 */
import { describe, expect, it } from "vitest";

import { getOperation } from "../registry";
import "./payment";

describe("admin payment UOL contract", () => {
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
