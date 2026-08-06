import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  bindExecute,
  clearRegistry,
  defineOperation,
  getOperation,
  getRegistrySize,
  isOperationBound,
  listOperations,
} from "../registry";
import type { OperationDefinition } from "../types";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
});

/** 已删除且不得重新注册的订阅 operation 名称。 */
const REMOVED_SUBSCRIPTION_OPERATIONS = [
  "subscription.listMyPurchasablePlans",
  "subscription.createCheckout",
  "subscription.getUpgradeQuote",
  "subscription.cancel",
  "subscription.getPortal",
  "subscription.getUserSubscription",
  "subscription.hasActive",
  "subscription.getMyPlan",
  "subscription.getUserPlan",
  "subscription.checkFileSize",
  "subscription.getCapabilitySnapshot",
  "subscription.canUseCapability",
  "subscription.getPlanLimits",
  "subscription.webhookCreem",
  "subscription.webhookEpay",
  "subscription.fulfillEpay",
] as const;

await import("../operations");
const REGISTERED_OPERATION_NAMES = new Set(
  listOperations().map((operation) => operation.name)
);

/** 测试用最小操作定义工厂 */
function makeTestOp(
  overrides: Partial<OperationDefinition> = {}
): OperationDefinition {
  return {
    name: overrides.name ?? "test.op",
    domain: overrides.domain ?? "credits",
    title: "Test Operation",
    description: "A test operation",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    access: { kind: "public" },
    readOnly: overrides.readOnly ?? false,
    destructive: overrides.destructive ?? false,
    idempotency: { kind: "natural" },
    sideEffects: [],
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("UOL Registry", () => {
  beforeEach(() => {
    clearRegistry();
  });

  describe("defineOperation", () => {
    it("registers and retrieves an operation", () => {
      const op = makeTestOp({ name: "credits.balance" });
      const result = defineOperation(op);

      expect(result).toBe(op);
      expect(getOperation("credits.balance")).toBe(op);
    });

    it("throws on duplicate name registration", () => {
      defineOperation(makeTestOp({ name: "dup.op" }));

      expect(() => defineOperation(makeTestOp({ name: "dup.op" }))).toThrow(
        "[UOL] Duplicate operation registration: dup.op"
      );
    });
  });

  describe("getOperation", () => {
    it("returns undefined for unknown operation name", () => {
      expect(getOperation("nonexistent.op")).toBeUndefined();
    });

    it("returns the registered operation", () => {
      const op = makeTestOp({ name: "found.op" });
      defineOperation(op);
      expect(getOperation("found.op")).toBe(op);
    });
  });

  describe("listOperations", () => {
    it("returns all operations when no filter", () => {
      defineOperation(makeTestOp({ name: "op1" }));
      defineOperation(makeTestOp({ name: "op2" }));
      defineOperation(makeTestOp({ name: "op3" }));

      expect(listOperations()).toHaveLength(3);
    });

    it("filters by domain", () => {
      defineOperation(makeTestOp({ name: "op.a", domain: "credits" }));
      defineOperation(makeTestOp({ name: "op.b", domain: "image-generation" }));
      defineOperation(makeTestOp({ name: "op.c", domain: "credits" }));

      const filtered = listOperations({ domain: "credits" });
      expect(filtered).toHaveLength(2);
      expect(filtered.every((op) => op.domain === "credits")).toBe(true);
    });

    it("filters by readOnly", () => {
      defineOperation(makeTestOp({ name: "ro", readOnly: true }));
      defineOperation(makeTestOp({ name: "rw", readOnly: false }));

      expect(listOperations({ readOnly: true })).toHaveLength(1);
      expect(listOperations({ readOnly: true })[0]?.name).toBe("ro");
      expect(listOperations({ readOnly: false })).toHaveLength(1);
      expect(listOperations({ readOnly: false })[0]?.name).toBe("rw");
    });

    it("filters by destructive", () => {
      defineOperation(makeTestOp({ name: "safe", destructive: false }));
      defineOperation(makeTestOp({ name: "danger", destructive: true }));

      expect(listOperations({ destructive: true })).toHaveLength(1);
      expect(listOperations({ destructive: true })[0]?.name).toBe("danger");
    });

    it("combines multiple filter criteria", () => {
      defineOperation(
        makeTestOp({
          name: "match",
          domain: "credits",
          readOnly: true,
          destructive: false,
        })
      );
      defineOperation(
        makeTestOp({
          name: "no-match-domain",
          domain: "storage",
          readOnly: true,
          destructive: false,
        })
      );
      defineOperation(
        makeTestOp({
          name: "no-match-rw",
          domain: "credits",
          readOnly: false,
          destructive: false,
        })
      );

      const filtered = listOperations({
        domain: "credits",
        readOnly: true,
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.name).toBe("match");
    });
  });

  describe("getRegistrySize", () => {
    it("returns 0 for empty registry", () => {
      expect(getRegistrySize()).toBe(0);
    });

    it("returns correct count after registrations", () => {
      defineOperation(makeTestOp({ name: "a" }));
      defineOperation(makeTestOp({ name: "b" }));
      expect(getRegistrySize()).toBe(2);
    });
  });

  describe("clearRegistry", () => {
    it("empties all registered operations", () => {
      defineOperation(makeTestOp({ name: "x" }));
      defineOperation(makeTestOp({ name: "y" }));
      expect(getRegistrySize()).toBe(2);

      clearRegistry();
      expect(getRegistrySize()).toBe(0);
      expect(getOperation("x")).toBeUndefined();
      expect(getOperation("y")).toBeUndefined();
    });
  });

  describe("bindExecute", () => {
    it("replaces stub execute with real implementation", async () => {
      defineOperation(
        makeTestOp({
          name: "bind.test",
          execute: async () => {
            throw new Error("Not yet wired: bind.test");
          },
        })
      );

      // 绑定前：execute 是 stub
      const before = getOperation("bind.test");
      await expect(
        before!.execute({}, {} as never, {} as never)
      ).rejects.toThrow("Not yet wired");

      // 绑定真实实现
      bindExecute("bind.test", async () => ({ ok: true }));

      // 绑定后：execute 返回真实结果
      const after = getOperation("bind.test");
      const result = await after!.execute({}, {} as never, {} as never);
      expect(result).toEqual({ ok: true });
    });

    it("throws on unknown operation name", () => {
      expect(() => bindExecute("nonexistent.op", async () => ({}))).toThrow(
        "[UOL] Cannot bind unknown operation: nonexistent.op"
      );
    });

    it("passes input, principal, and ctx to bound function", async () => {
      defineOperation(
        makeTestOp({
          name: "bind.args",
          execute: async () => {
            throw new Error("Not yet wired: bind.args");
          },
        })
      );

      const captured: unknown[] = [];
      bindExecute("bind.args", async (input, principal, ctx) => {
        captured.push(input, principal, ctx);
        return { ok: true };
      });

      const fakeInput = { foo: "bar" };
      const fakePrincipal = { type: "system" as const, reason: "test" };
      const fakeCtx = { requestId: "r1" };

      await getOperation("bind.args")!.execute(
        fakeInput,
        fakePrincipal as never,
        fakeCtx as never
      );

      expect(captured[0]).toEqual(fakeInput);
      expect(captured[1]).toEqual(fakePrincipal);
      expect(captured[2]).toEqual(fakeCtx);
    });
  });

  describe("isOperationBound", () => {
    it("returns false for unknown operation", () => {
      expect(isOperationBound("ghost.op")).toBe(false);
    });

    it("returns false for stub (Not yet wired)", () => {
      defineOperation(
        makeTestOp({
          name: "stub.op",
          execute: async () => {
            throw new Error("Not yet wired: stub.op");
          },
        })
      );
      expect(isOperationBound("stub.op")).toBe(false);
    });

    it("returns true for real implementation", () => {
      defineOperation(
        makeTestOp({
          name: "real.op",
          execute: async () => ({ ok: true }),
        })
      );
      expect(isOperationBound("real.op")).toBe(true);
    });

    it("returns true after bindExecute replaces stub", () => {
      defineOperation(
        makeTestOp({
          name: "was-stub.op",
          execute: async () => {
            throw new Error("Not yet wired: was-stub.op");
          },
        })
      );
      expect(isOperationBound("was-stub.op")).toBe(false);

      bindExecute("was-stub.op", async () => ({ ok: true }));
      expect(isOperationBound("was-stub.op")).toBe(true);
    });
  });

  describe("removed operation tombstones", () => {
    it("does not register any deleted subscription operation", () => {
      for (const name of REMOVED_SUBSCRIPTION_OPERATIONS) {
        expect(REGISTERED_OPERATION_NAMES.has(name)).toBe(false);
      }
      expect(
        [...REGISTERED_OPERATION_NAMES].some((name) =>
          name.startsWith("subscription.")
        )
      ).toBe(false);
    });
  });
});
