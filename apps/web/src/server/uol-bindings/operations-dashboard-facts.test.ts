/**
 * 运营总览基础事实 UOL binding 的 DB-free 测试。
 *
 * 使用方：Vitest；验证 Principal 到服务参数的转换、非法身份拒绝和领域错误映射。
 */
import "@repo/shared/uol/operations";
import { invokeOperation } from "@repo/shared/uol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgresql://unit-test:unit-test@127.0.0.1:5432/unit-test";
  return {
    getAppTimeZone: vi.fn(),
    recordOperationsWebVisit: vi.fn(),
    ensureCurrentOperationsAnalyticsEpoch: vi.fn(),
  };
});

vi.mock("@repo/shared/time-zone/server", () => ({
  getAppTimeZone: mocks.getAppTimeZone,
}));
vi.mock("@/features/operations-dashboard/operations-facts-service", () => ({
  OperationsFactsServiceError: class OperationsFactsServiceError extends Error {
    /** 构造供 binding 映射的测试领域错误。 */
    constructor(
      readonly code: "validation_error",
      message: string
    ) {
      super(message);
      this.name = "OperationsFactsServiceError";
    }
  },
  recordOperationsWebVisit: mocks.recordOperationsWebVisit,
  ensureCurrentOperationsAnalyticsEpoch:
    mocks.ensureCurrentOperationsAnalyticsEpoch,
}));

import "./operations-dashboard-facts";

describe("operations dashboard fact bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_TIME_ZONE", "Asia/Shanghai");
    mocks.getAppTimeZone.mockReturnValue("Asia/Shanghai");
    mocks.recordOperationsWebVisit.mockResolvedValue({
      appDate: "2026-08-13",
      recorded: true,
    });
    mocks.ensureCurrentOperationsAnalyticsEpoch.mockResolvedValue({
      appDate: "2026-08-16",
      startsAt: "2026-08-15T16:00:00.000Z",
      initialized: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("访问 operation 只使用真实 session user 身份和部署应用时区", async () => {
    await expect(
      invokeOperation(
        "operations.recordWebVisit",
        {},
        { type: "user", userId: "user-1", role: "user" }
      )
    ).resolves.toEqual({ appDate: "2026-08-13", recorded: true });
    expect(mocks.recordOperationsWebVisit).toHaveBeenCalledWith({
      userId: "user-1",
      timeZone: "Asia/Shanghai",
    });
  });

  it("访问 operation 在鉴权或 strict schema 阶段拒绝 API Key 和伪造字段", async () => {
    await expect(
      invokeOperation(
        "operations.recordWebVisit",
        {},
        {
          type: "apiKey",
          credentialKind: "external",
          userId: "user-1",
          apiKeyId: "key-1",
        }
      )
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(
      invokeOperation(
        "operations.recordWebVisit",
        { userId: "another-user" },
        { type: "user", userId: "user-1", role: "user" }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.recordOperationsWebVisit).not.toHaveBeenCalled();
  });

  it("自动 epoch 门禁只接收发布身份并使用部署应用时区", async () => {
    await expect(
      invokeOperation(
        "operations.ensureCurrentEpoch",
        { initializedBy: "release-v0.25.1" },
        { type: "system", reason: "deployment" }
      )
    ).resolves.toMatchObject({ initialized: true });
    expect(mocks.ensureCurrentOperationsAnalyticsEpoch).toHaveBeenCalledWith(
      { initializedBy: "release-v0.25.1" },
      "Asia/Shanghai"
    );

    await expect(
      invokeOperation(
        "operations.ensureCurrentEpoch",
        { initializedBy: "release-v0.25.1" },
        { type: "user", userId: "admin-1", role: "super_admin" }
      )
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("自动 epoch 门禁对缺失或非法 APP_TIME_ZONE 失败关闭", async () => {
    for (const timeZone of ["", "Invalid/Zone"]) {
      vi.stubEnv("APP_TIME_ZONE", timeZone);
      await expect(
        invokeOperation(
          "operations.ensureCurrentEpoch",
          { initializedBy: "release-v0.25.1" },
          { type: "system", reason: "deployment" }
        )
      ).rejects.toMatchObject({ code: "validation_error" });
    }
    expect(mocks.ensureCurrentOperationsAnalyticsEpoch).not.toHaveBeenCalled();
  });
});
