/**
 * 钱包与使用日志 UOL 注册契约测试。
 *
 * 仅校验 U1 固定的 schema、本人权限和操作元数据；数据查询与购买服务绑定由
 * 后续实现单元测试负责。
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
});

import { invokeOperation } from "../invoke";
import type { Principal } from "../principal";
import { getOperation } from "../registry";
import "./index";

const sessionOnlyOperations = [
  "credits.getMyBalance",
  "credits.listMyUsageEvents",
  "credits.getMyUsageEventDetail",
  "subscription.listMyPurchasablePlans",
  "subscription.createCheckout",
] as const;

describe("wallet and usage log UOL contracts", () => {
  it.each(sessionOnlyOperations)("keeps %s session-only", (name) => {
    const operation = getOperation(name);
    expect(operation?.access).toEqual({ kind: "user" });
    expect(operation?.input.safeParse({ userId: "another-user" }).success).toBe(
      false
    );
  });

  it("keeps balance maintenance metadata and validates its narrow output", () => {
    const operation = getOperation("credits.getMyBalance");
    expect(operation).toMatchObject({
      readOnly: false,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: ["billing"],
      hasMaintenanceWrite: true,
    });
    expect(
      operation?.output.parse({
        balance: 500,
        totalSpent: 100,
        totalRefunded: 130,
        totalNetSpent: 0,
        status: "active",
        asOf: "2026-07-22T01:02:03.000Z",
        metadata: { secret: true },
      })
    ).toEqual({
      balance: 500,
      totalSpent: 100,
      totalRefunded: 130,
      totalNetSpent: 0,
      status: "active",
      asOf: "2026-07-22T01:02:03.000Z",
    });
  });

  it.each([
    "credits.listMyUsageEvents",
    "credits.getMyUsageEventDetail",
    "subscription.listMyPurchasablePlans",
  ])("registers %s as natural read with no side effects", (name) => {
    expect(getOperation(name)).toMatchObject({
      access: { kind: "user" },
      readOnly: true,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
    });
  });

  it("expresses checkout as redirect or POST form without accepting userId", () => {
    const operation = getOperation("subscription.createCheckout");
    expect(
      operation?.output.safeParse({
        kind: "redirect",
        url: "https://pay.example.test/checkout",
      }).success
    ).toBe(true);
    expect(
      operation?.output.safeParse({
        kind: "form_post",
        url: "https://pay.example.test/submit",
        fields: { order: "order-1" },
      }).success
    ).toBe(true);
  });

  it.each(
    sessionOnlyOperations
  )("rejects apiKey Principal before executing %s", async (name) => {
    const apiKeyPrincipal = {
      type: "apiKey",
      credentialKind: "external",
      userId: "user-1",
      apiKeyId: "key-1",
      plan: "pro",
    } satisfies Principal;
    await expect(
      invokeOperation(name, {}, apiKeyPrincipal)
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
