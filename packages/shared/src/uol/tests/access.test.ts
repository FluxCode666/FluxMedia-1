/**
 * UOL 访问控制测试。
 *
 * 职责：覆盖每种 AccessRequirement 与 Principal 的允许/拒绝矩阵，
 * 尤其验证角色集合只接受真实用户会话，不能被 system 或 API Key 绕过。
 */
import { describe, expect, it } from "vitest";

import { assertAccess } from "../access";
import { OperationError } from "../errors";
import type { Principal } from "../principal";
import type { AccessRequirement } from "../types";

/** 各类型 Principal 的测试固定值 */
const principals = {
  user: {
    type: "user",
    userId: "u1",
    role: "user",
  } as Principal,
  admin: {
    type: "user",
    userId: "u2",
    role: "admin",
  } as Principal,
  superAdmin: {
    type: "user",
    userId: "u3",
    role: "super_admin",
  } as Principal,
  observerAdmin: {
    type: "user",
    userId: "u4",
    role: "observer_admin",
  } as Principal,
  apiKey: {
    type: "apiKey",
    credentialKind: "external",
    userId: "u5",
    apiKeyId: "k1",
    plan: "pro",
  } as Principal,
  system: {
    type: "system",
    reason: "test",
  } as Principal,
  cron: {
    type: "cron",
    job: "daily-cleanup",
  } as Principal,
  webhookCreem: {
    type: "webhook",
    provider: "creem",
  } as Principal,
  webhookEpay: {
    type: "webhook",
    provider: "epay",
  } as Principal,
  webhookAlipay: {
    type: "webhook",
    provider: "alipay",
  } as Principal,
  proxy: {
    type: "proxy",
    secretKind: "proxy",
  } as Principal,
};

describe("UOL Access Control (assertAccess)", () => {
  describe("public", () => {
    const access: AccessRequirement = { kind: "public" };

    it("allows any principal", () => {
      for (const p of Object.values(principals)) {
        expect(() => assertAccess(access, p)).not.toThrow();
      }
    });
  });

  describe("protected", () => {
    const access: AccessRequirement = { kind: "protected" };

    it("allows user principals", () => {
      expect(() => assertAccess(access, principals.user)).not.toThrow();
      expect(() => assertAccess(access, principals.admin)).not.toThrow();
    });

    it("allows apiKey principals", () => {
      expect(() => assertAccess(access, principals.apiKey)).not.toThrow();
    });

    it("allows system principals", () => {
      expect(() => assertAccess(access, principals.system)).not.toThrow();
    });

    it("rejects cron / webhook / proxy principals", () => {
      expect(() => assertAccess(access, principals.cron)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.webhookCreem)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.proxy)).toThrow(
        OperationError
      );
    });
  });

  describe("user", () => {
    const access: AccessRequirement = { kind: "user" };

    it("仅允许登录用户会话", () => {
      expect(() => assertAccess(access, principals.user)).not.toThrow();
      expect(() => assertAccess(access, principals.admin)).not.toThrow();
      expect(() => assertAccess(access, principals.apiKey)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.system)).toThrow(
        OperationError
      );
    });
  });

  describe("roles", () => {
    const readAccess: AccessRequirement = {
      kind: "roles",
      roles: ["observer_admin", "admin", "super_admin"],
    };
    const writeAccess: AccessRequirement = {
      kind: "roles",
      roles: ["admin", "super_admin"],
    };

    it("allows only listed user roles", () => {
      expect(() =>
        assertAccess(readAccess, principals.observerAdmin)
      ).not.toThrow();
      expect(() => assertAccess(writeAccess, principals.admin)).not.toThrow();
      expect(() =>
        assertAccess(writeAccess, principals.superAdmin)
      ).not.toThrow();
    });

    it("rejects user roles outside the list", () => {
      expect(() => assertAccess(writeAccess, principals.user)).toThrow(
        OperationError
      );
      expect(() => assertAccess(writeAccess, principals.observerAdmin)).toThrow(
        OperationError
      );
    });

    it("rejects every non-user principal, including system", () => {
      for (const principal of [
        principals.apiKey,
        principals.system,
        principals.cron,
        principals.webhookCreem,
        principals.proxy,
      ]) {
        expect(() => assertAccess(writeAccess, principal)).toThrow(
          OperationError
        );
      }
    });
  });

  describe("admin", () => {
    const access: AccessRequirement = { kind: "admin" };

    it("allows admin and super_admin", () => {
      expect(() => assertAccess(access, principals.admin)).not.toThrow();
      expect(() => assertAccess(access, principals.superAdmin)).not.toThrow();
    });

    it("allows observer_admin", () => {
      expect(() =>
        assertAccess(access, principals.observerAdmin)
      ).not.toThrow();
    });

    it("allows system principal", () => {
      expect(() => assertAccess(access, principals.system)).not.toThrow();
    });

    it("rejects regular user", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError
      );
    });

    it("rejects non-user principals", () => {
      expect(() => assertAccess(access, principals.apiKey)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.cron)).toThrow(
        OperationError
      );
    });
  });

  describe("superAdmin", () => {
    const access: AccessRequirement = { kind: "superAdmin" };

    it("allows super_admin only", () => {
      expect(() => assertAccess(access, principals.superAdmin)).not.toThrow();
    });

    it("rejects admin (non-super)", () => {
      expect(() => assertAccess(access, principals.admin)).toThrow(
        OperationError
      );
    });

    it("rejects regular user", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError
      );
    });

    it("allows system principal", () => {
      expect(() => assertAccess(access, principals.system)).not.toThrow();
    });
  });

  describe("imageBackendPoolViewer", () => {
    const access: AccessRequirement = {
      kind: "imageBackendPoolViewer",
    };

    it("allows observer_admin, admin, super_admin", () => {
      expect(() =>
        assertAccess(access, principals.observerAdmin)
      ).not.toThrow();
      expect(() => assertAccess(access, principals.admin)).not.toThrow();
      expect(() => assertAccess(access, principals.superAdmin)).not.toThrow();
    });

    it("rejects regular user", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError
      );
    });

    it("rejects non-user principals", () => {
      expect(() => assertAccess(access, principals.apiKey)).toThrow(
        OperationError
      );
    });

    it("allows system principal", () => {
      expect(() => assertAccess(access, principals.system)).not.toThrow();
    });
  });

  describe("apiKey", () => {
    const access: AccessRequirement = { kind: "apiKey" };

    it("allows apiKey principal", () => {
      expect(() => assertAccess(access, principals.apiKey)).not.toThrow();
    });

    it("rejects user principal", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError
      );
    });

    it("allows system principal", () => {
      expect(() => assertAccess(access, principals.system)).not.toThrow();
    });

    it("rejects cron principal", () => {
      expect(() => assertAccess(access, principals.cron)).toThrow(
        OperationError
      );
    });
  });

  describe("cron", () => {
    const access: AccessRequirement = { kind: "cron" };

    it("allows cron principal", () => {
      expect(() => assertAccess(access, principals.cron)).not.toThrow();
    });

    it("rejects user principal", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError
      );
    });

    it("allows system principal", () => {
      expect(() => assertAccess(access, principals.system)).not.toThrow();
    });
  });

  describe("webhook", () => {
    it("allows matching webhook provider", () => {
      const creem: AccessRequirement = {
        kind: "webhook",
        provider: "creem",
      };
      expect(() => assertAccess(creem, principals.webhookCreem)).not.toThrow();

      const epay: AccessRequirement = {
        kind: "webhook",
        provider: "epay",
      };
      expect(() => assertAccess(epay, principals.webhookEpay)).not.toThrow();

      const alipay: AccessRequirement = {
        kind: "webhook",
        provider: "alipay",
      };
      expect(() =>
        assertAccess(alipay, principals.webhookAlipay)
      ).not.toThrow();
    });

    it("rejects mismatched webhook provider", () => {
      const creem: AccessRequirement = {
        kind: "webhook",
        provider: "creem",
      };
      expect(() => assertAccess(creem, principals.webhookEpay)).toThrow(
        OperationError
      );
      expect(() => assertAccess(creem, principals.webhookAlipay)).toThrow(
        OperationError
      );
    });

    it("rejects non-webhook principals", () => {
      const creem: AccessRequirement = {
        kind: "webhook",
        provider: "creem",
      };
      expect(() => assertAccess(creem, principals.user)).toThrow(
        OperationError
      );
    });

    it("allows system principal", () => {
      const creem: AccessRequirement = {
        kind: "webhook",
        provider: "creem",
      };
      expect(() => assertAccess(creem, principals.system)).not.toThrow();
    });
  });

  describe("proxySecret", () => {
    const access: AccessRequirement = { kind: "proxySecret" };

    it("allows proxy principal", () => {
      expect(() => assertAccess(access, principals.proxy)).not.toThrow();
    });

    it("rejects non-proxy principals", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.apiKey)).toThrow(
        OperationError
      );
    });

    it("allows system principal", () => {
      expect(() => assertAccess(access, principals.system)).not.toThrow();
    });
  });

  describe("owner", () => {
    const access: AccessRequirement = {
      kind: "owner",
      resource: "generation",
    };

    it("allows user principal (defers ownership check to execute)", () => {
      expect(() => assertAccess(access, principals.user)).not.toThrow();
    });

    it("allows apiKey principal", () => {
      expect(() => assertAccess(access, principals.apiKey)).not.toThrow();
    });

    it("allows system principal", () => {
      expect(() => assertAccess(access, principals.system)).not.toThrow();
    });

    it("rejects cron / webhook / proxy (no user identity)", () => {
      expect(() => assertAccess(access, principals.cron)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.webhookCreem)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.proxy)).toThrow(
        OperationError
      );
    });
  });

  describe("system", () => {
    const access: AccessRequirement = { kind: "system" };

    it("allows system principal only", () => {
      expect(() => assertAccess(access, principals.system)).not.toThrow();
    });

    it("rejects all non-system principals", () => {
      expect(() => assertAccess(access, principals.user)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.admin)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.superAdmin)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.apiKey)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.cron)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.webhookCreem)).toThrow(
        OperationError
      );
      expect(() => assertAccess(access, principals.proxy)).toThrow(
        OperationError
      );
    });
  });

  describe("system principal keeps legacy access bypasses", () => {
    const allAccessKinds: AccessRequirement[] = [
      { kind: "public" },
      { kind: "protected" },
      { kind: "owner", resource: "test" },
      { kind: "admin" },
      { kind: "superAdmin" },
      { kind: "imageBackendPoolViewer" },
      { kind: "apiKey" },
      { kind: "cron" },
      { kind: "webhook", provider: "creem" },
      { kind: "proxySecret" },
      { kind: "system" },
    ];

    for (const access of allAccessKinds) {
      it(`bypasses "${access.kind}" access`, () => {
        expect(() => assertAccess(access, principals.system)).not.toThrow();
      });
    }
  });
});
