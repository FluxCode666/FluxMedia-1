/**
 * Adobe direct 同账号重新授权的 DB-free 回归测试。
 *
 * 职责：验证双 Profile/旧账号 fail-closed、稳定请求幂等，以及恢复事务不会改写管理员
 * 启用状态；所有 Adobe 网络和数据库依赖均为内存桩。
 */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeResponses: [] as unknown[],
  transactionResponses: [] as unknown[],
  transactionQueries: [] as SQL[],
  health: vi.fn(),
  buildTransport: vi.fn(async () => ({ request: vi.fn() })),
  evaluate: vi.fn(),
  prepare: vi.fn(),
  resolveTargets: vi.fn(async () => []),
  closeIncident: vi.fn(async () => ({
    incidentId: "incident-1",
    closed: true,
  })),
  drain: vi.fn(async () => undefined),
}));

const database = vi.hoisted(() => ({
  execute: vi.fn(async () => mocks.executeResponses.shift() ?? []),
  transaction: vi.fn(
    async (
      work: (transaction: {
        execute(query: SQL): Promise<unknown>;
      }) => Promise<unknown>
    ) =>
      work({
        async execute(query) {
          mocks.transactionQueries.push(query);
          return mocks.transactionResponses.shift() ?? [];
        },
      })
  ),
}));

vi.mock("@repo/database", () => ({ db: database }));
vi.mock("./adobe-direct", () => ({
  buildAdobeDirectApiTransport: mocks.buildTransport,
  prepareAdobeDirectCredential: mocks.prepare,
}));
vi.mock("./adobe-credential-health", () => ({
  evaluateAdobeCredentialProfiles: mocks.evaluate,
}));
vi.mock("./adobe-credential-health-runtime", () => ({
  getAdobeCredentialHealth: mocks.health,
}));
vi.mock("./adobe-credential-notifications", () => ({
  resolveAdobeCredentialNotificationTargets: mocks.resolveTargets,
  closeAdobeCredentialIncident: mocks.closeIncident,
  bestEffortDrainAdobeCredentialNotifications: mocks.drain,
}));

import {
  AdobeCredentialReauthorizationError,
  reauthorizeAdobeCredential,
} from "./adobe-direct-reauthorization";

const SNAPSHOT = {
  member_id: "member-1",
  member_name: "Adobe A",
  is_enabled: false,
  mode: "direct",
  scope: "AdobeID,openid",
  account_user_id: "adobe-user-1",
  credential_revision: 4,
  member_enable_revision: 7,
};

const HEALTH = {
  memberId: "member-1",
  status: "healthy",
  consecutiveFailures: 0,
  failureProfiles: [],
  lastCheckedAt: "2026-08-04T00:00:00.000Z",
  lastSuccessAt: "2026-08-04T00:00:00.000Z",
  nextCheckAt: "2026-08-04T00:45:00.000Z",
  evaluationDeadlineAt: null,
  isolatedAt: null,
  diagnostic: null,
};

describe("Adobe direct 同账号重新授权", () => {
  beforeEach(() => {
    mocks.executeResponses.length = 0;
    mocks.transactionResponses.length = 0;
    mocks.transactionQueries.length = 0;
    database.execute.mockClear();
    database.transaction.mockClear();
    mocks.health.mockReset().mockResolvedValue(HEALTH);
    mocks.buildTransport.mockClear();
    mocks.evaluate.mockReset().mockResolvedValue({
      outcome: { kind: "success", failureProfiles: [], diagnostic: null },
      profiles: [
        { profile: "express", ok: true },
        { profile: "firefly", ok: true },
      ],
    });
    mocks.prepare.mockReset().mockResolvedValue({
      accessToken: "short-lived-token",
      accountUserId: "adobe-user-1",
      displayName: "Operator",
      email: "operator@example.com",
      expiresAt: new Date("2026-08-04T01:00:00.000Z"),
      creditsTotal: 100,
      creditsUsed: 20,
      creditsAvailable: 80,
      creditsUpdatedAt: new Date("2026-08-04T00:00:00.000Z"),
      creditsError: null,
    });
    mocks.resolveTargets.mockClear();
    mocks.closeIncident.mockClear();
    mocks.drain.mockClear();
  });

  it("双 Profile 同账号通过后原子恢复但保持管理员停用", async () => {
    mocks.executeResponses.push([], [SNAPSHOT]);
    mocks.transactionResponses.push([SNAPSHOT], [], [], [], []);

    const result = await reauthorizeAdobeCredential({
      actorUserId: "admin-1",
      memberId: "member-1",
      cookie: JSON.stringify({ cookie: "aux_sid=new-cookie", headers: {} }),
      clientRequestId: "request-1",
    });

    expect(result).toMatchObject({ disposition: "accepted", health: HEALTH });
    expect(mocks.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        cookie: "aux_sid=new-cookie",
        expectedAccountUserId: "adobe-user-1",
      })
    );
    expect(mocks.closeIncident).toHaveBeenCalledOnce();
    expect(mocks.drain).toHaveBeenCalledOnce();
    const compiled = mocks.transactionQueries.map((query) =>
      new PgDialect().sqlToQuery(query)
    );
    const memberUpdates = compiled.filter((query) =>
      query.sql.includes("UPDATE image_backend_member")
    );
    expect(memberUpdates).toHaveLength(1);
    expect(memberUpdates[0]?.sql).toContain(
      "image_backend_member_adobe_config"
    );
    expect(memberUpdates[0]?.sql).toContain("firefly_access_token = NULL");
    expect(memberUpdates[0]?.sql).toContain("firefly_credential_status = NULL");
    expect(compiled.some((query) => query.sql.includes("is_enabled ="))).toBe(
      false
    );
  });

  it("任一 Profile 身份失败时保留旧凭据和隔离状态", async () => {
    mocks.executeResponses.push([], [SNAPSHOT]);
    mocks.evaluate.mockResolvedValue({
      outcome: {
        kind: "member_failure",
        failureProfiles: ["firefly"],
        diagnostic: { adobeErrorCode: "identity_mismatch" },
      },
      profiles: [],
    });

    await expect(
      reauthorizeAdobeCredential({
        actorUserId: "admin-1",
        memberId: "member-1",
        cookie: "aux_sid=other-account",
        clientRequestId: "request-2",
      })
    ).rejects.toMatchObject({
      name: "AdobeCredentialReauthorizationError",
      code: "validation_error",
    });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.closeIncident).not.toHaveBeenCalled();
  });

  it("相同 clientRequestId 命中历史后不重复网络或恢复事务", async () => {
    mocks.executeResponses.push([
      { id: "evaluation-existing", disposition: "accepted" },
    ]);

    await expect(
      reauthorizeAdobeCredential({
        actorUserId: "admin-1",
        memberId: "member-1",
        cookie: "aux_sid=new-cookie",
        clientRequestId: "request-existing",
      })
    ).resolves.toEqual({
      evaluationId: "evaluation-existing",
      disposition: "accepted",
      health: HEALTH,
    });
    expect(mocks.buildTransport).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("并发同幂等请求在成员锁后复用已提交结果", async () => {
    mocks.executeResponses.push([], [SNAPSHOT]);
    mocks.transactionResponses.push(
      [SNAPSHOT],
      [{ id: "evaluation-existing", disposition: "accepted" }]
    );

    await expect(
      reauthorizeAdobeCredential({
        actorUserId: "admin-1",
        memberId: "member-1",
        cookie: "aux_sid=new-cookie",
        clientRequestId: "request-concurrent",
      })
    ).resolves.toEqual({
      evaluationId: "evaluation-existing",
      disposition: "accepted",
      health: HEALTH,
    });

    expect(mocks.evaluate).toHaveBeenCalledOnce();
    expect(mocks.transactionQueries).toHaveLength(2);
    expect(
      mocks.transactionQueries.some((query) =>
        new PgDialect()
          .sqlToQuery(query)
          .sql.includes("UPDATE image_backend_member_adobe_config")
      )
    ).toBe(false);
    expect(mocks.closeIncident).not.toHaveBeenCalled();
    expect(mocks.drain).not.toHaveBeenCalled();
  });

  it("网络验证期间凭据 revision 变化时拒绝覆盖新凭据", async () => {
    mocks.executeResponses.push([], [SNAPSHOT]);
    mocks.transactionResponses.push(
      [{ ...SNAPSHOT, credential_revision: 5 }],
      []
    );

    await expect(
      reauthorizeAdobeCredential({
        actorUserId: "admin-1",
        memberId: "member-1",
        cookie: "aux_sid=new-cookie",
        clientRequestId: "request-conflict",
      })
    ).rejects.toMatchObject({
      name: "AdobeCredentialReauthorizationError",
      code: "conflict",
    });

    expect(mocks.evaluate).toHaveBeenCalledOnce();
    expect(mocks.transactionQueries).toHaveLength(2);
    expect(mocks.closeIncident).not.toHaveBeenCalled();
    expect(mocks.drain).not.toHaveBeenCalled();
  });

  it("成员缺少不可变账号 ID 时 fail-closed", async () => {
    mocks.executeResponses.push([], [{ ...SNAPSHOT, account_user_id: null }]);

    const error = await reauthorizeAdobeCredential({
      actorUserId: "admin-1",
      memberId: "member-1",
      cookie: "aux_sid=new-cookie",
      clientRequestId: "request-no-id",
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AdobeCredentialReauthorizationError);
    expect(error).toMatchObject({ code: "validation_error" });
    expect(mocks.buildTransport).not.toHaveBeenCalled();
  });
});
