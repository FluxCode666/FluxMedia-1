/**
 * Adobe 凭据健康 UOL binding 测试。
 *
 * 职责：验证内部任务只能使用精确 cron Principal，管理员立即检查保持真实用户角色
 * 边界，且 binding 输出不会携带通知内部字段或凭据。
 */

import "@repo/shared/uol/operations";
import { invokeOperation, OperationError } from "@repo/shared/uol";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgresql://unit-test:unit-test@127.0.0.1:5432/unit-test";
});

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  check: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  reauthorize: vi.fn(),
  drain: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock("@/features/image-generation/adobe-credential-health-runtime", () => ({
  runAdobeCredentialHealthScan: mocks.scan,
  checkAdobeCredentialHealth: mocks.check,
  getAdobeCredentialHealth: mocks.get,
}));
vi.mock("@/features/image-backend-pool/adobe-credential-health-list", () => ({
  listAdobeCredentialHealthStatuses: mocks.list,
}));

vi.mock("@/features/image-generation/adobe-credential-notifications", () => ({
  drainAdobeCredentialNotifications: mocks.drain,
  cleanupAdobeCredentialHealthHistory: mocks.cleanup,
}));
vi.mock("@/features/image-generation/adobe-direct-reauthorization", () => ({
  AdobeCredentialReauthorizationError: class extends Error {},
  reauthorizeAdobeCredential: mocks.reauthorize,
}));

import "./adobe-credential-health";

const HEALTH = {
  memberId: "member-1",
  status: "healthy" as const,
  consecutiveFailures: 0,
  failureProfiles: [],
  lastCheckedAt: "2026-08-04T00:00:00.000Z",
  lastSuccessAt: "2026-08-04T00:00:00.000Z",
  nextCheckAt: "2026-08-04T00:45:00.000Z",
  evaluationDeadlineAt: null,
  isolatedAt: null,
  diagnostic: null,
};

describe("Adobe 凭据健康 UOL binding", () => {
  beforeEach(() => {
    mocks.scan.mockReset();
    mocks.check.mockReset();
    mocks.get.mockReset();
    mocks.list.mockReset();
    mocks.reauthorize.mockReset();
    mocks.drain.mockReset();
    mocks.cleanup.mockReset();
    mocks.scan.mockResolvedValue({ claimed: 1, completed: 1, failed: 0 });
    mocks.check.mockResolvedValue({
      evaluationId: "evaluation-1",
      disposition: "accepted",
      health: HEALTH,
      notificationCreated: false,
    });
    mocks.get.mockResolvedValue(HEALTH);
    mocks.list.mockResolvedValue([{ memberId: "member-1", status: "healthy" }]);
    mocks.reauthorize.mockResolvedValue({
      evaluationId: "evaluation-reauthorized",
      disposition: "accepted",
      health: HEALTH,
    });
  });

  it("只允许匹配 job 名的 cron Principal 执行健康扫描", async () => {
    await expect(
      invokeOperation(
        "pool.scanAdobeCredentialHealth",
        { batchSize: 10 },
        { type: "cron", job: "adobe-credential-health" }
      )
    ).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });

    await expect(
      invokeOperation(
        "pool.scanAdobeCredentialHealth",
        { batchSize: 10 },
        { type: "cron", job: "adobe-credential-notification-delivery" }
      )
    ).rejects.toBeInstanceOf(OperationError);
    expect(mocks.scan).toHaveBeenCalledTimes(1);
  });

  it("管理员可立即检查且输出不暴露通知内部字段", async () => {
    const output = await invokeOperation(
      "pool.checkAdobeCredentialHealth",
      { memberId: "member-1" },
      { type: "user", userId: "admin-1", role: "admin" }
    );

    expect(output).toEqual({
      evaluationId: "evaluation-1",
      disposition: "accepted",
      health: HEALTH,
    });
    expect(JSON.stringify(output)).not.toMatch(/cookie|token|notification/i);
  });

  it("observer_admin 不能读取专用原始诊断入口", async () => {
    await expect(
      invokeOperation(
        "pool.getAdobeCredentialHealth",
        { memberId: "member-1" },
        { type: "user", userId: "observer-1", role: "observer_admin" }
      )
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each([
    "observer_admin",
    "admin",
    "super_admin",
  ] as const)("%s 可以批量读取无诊断凭据健康状态", async (role) => {
    await expect(
      invokeOperation(
        "pool.listAdobeCredentialHealthStatuses",
        {},
        { type: "user", userId: `${role}-1`, role }
      )
    ).resolves.toEqual({
      statuses: [{ memberId: "member-1", status: "healthy" }],
    });
  });

  it.each([
    { type: "system" as const, reason: "test" },
    { type: "cron" as const, job: "adobe-credential-health" },
    {
      type: "apiKey" as const,
      credentialKind: "external" as const,
      userId: "user-1",
      apiKeyId: "key-1",
    },
  ])("拒绝非人工账号池查看者批量读取凭据健康状态", async (principal) => {
    await expect(
      invokeOperation("pool.listAdobeCredentialHealthStatuses", {}, principal)
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it.each([
    "admin",
    "super_admin",
  ] as const)("%s 用户可以为同一账号重新授权且输出保持脱敏", async (role) => {
    const output = await invokeOperation(
      "pool.reauthorizeAdobeCredential",
      {
        memberId: "member-1",
        cookie: "aux_sid=new-cookie",
        clientRequestId: `request-${role}`,
      },
      { type: "user", userId: `${role}-1`, role }
    );

    expect(output).toEqual({
      evaluationId: "evaluation-reauthorized",
      disposition: "accepted",
      health: HEALTH,
    });
    expect(mocks.reauthorize).toHaveBeenCalledWith({
      actorUserId: `${role}-1`,
      memberId: "member-1",
      cookie: "aux_sid=new-cookie",
      clientRequestId: `request-${role}`,
    });
    expect(JSON.stringify(output)).not.toMatch(
      /cookie|token|authorization|notification|delivery/i
    );
  });

  it.each([
    {
      type: "user" as const,
      userId: "observer-1",
      role: "observer_admin" as const,
    },
    { type: "system" as const, reason: "test" },
    { type: "cron" as const, job: "adobe-credential-health" },
    {
      type: "apiKey" as const,
      credentialKind: "external" as const,
      userId: "user-1",
      apiKeyId: "key-1",
    },
  ])("拒绝非真实管理员 Principal 重新授权", async (principal) => {
    await expect(
      invokeOperation(
        "pool.reauthorizeAdobeCredential",
        {
          memberId: "member-1",
          cookie: "aux_sid=new-cookie",
          clientRequestId: "request-forbidden",
        },
        principal
      )
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.reauthorize).not.toHaveBeenCalled();
  });
});
