/**
 * 运营总览基础事实 UOL binding 的 DB-free 测试。
 *
 * 使用方：Vitest；验证 Principal 到服务参数的转换、非法身份拒绝和领域错误映射。
 */
import "@repo/shared/uol/operations";
import { invokeOperation } from "@repo/shared/uol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgresql://unit-test:unit-test@127.0.0.1:5432/unit-test";
  return {
    getAppTimeZone: vi.fn(),
    recordOperationsWebVisit: vi.fn(),
    initializeOperationsAnalyticsEpoch: vi.fn(),
  };
});

vi.mock("@repo/shared/time-zone/server", () => ({
  getAppTimeZone: mocks.getAppTimeZone,
}));
vi.mock("@/features/operations-dashboard/operations-facts-service", () => ({
  OperationsFactsServiceError: class OperationsFactsServiceError extends Error {
    /** 构造供 binding 映射的测试领域错误。 */
    constructor(
      readonly code: "validation_error" | "conflict",
      message: string
    ) {
      super(message);
      this.name = "OperationsFactsServiceError";
    }
  },
  recordOperationsWebVisit: mocks.recordOperationsWebVisit,
  initializeOperationsAnalyticsEpoch: mocks.initializeOperationsAnalyticsEpoch,
}));

import { OperationsFactsServiceError } from "@/features/operations-dashboard/operations-facts-service";
import "./operations-dashboard-facts";

describe("operations dashboard fact bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAppTimeZone.mockReturnValue("Asia/Shanghai");
    mocks.recordOperationsWebVisit.mockResolvedValue({
      appDate: "2026-08-13",
      recorded: true,
    });
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

  it("epoch 只允许 system 并映射日期边界与冲突错误", async () => {
    const input = {
      appDate: "2026-08-13",
      startsAt: "2026-08-12T16:00:00.000Z",
      initializedBy: "deployment-runbook",
      requestId: "epoch-request-1",
    };
    mocks.initializeOperationsAnalyticsEpoch.mockRejectedValueOnce(
      new OperationsFactsServiceError("validation_error", "日期边界无效")
    );
    await expect(
      invokeOperation("operations.initializeEpoch", input, {
        type: "system",
        reason: "deployment",
      })
    ).rejects.toMatchObject({ code: "validation_error" });

    mocks.initializeOperationsAnalyticsEpoch.mockRejectedValueOnce(
      new OperationsFactsServiceError("conflict", "已经初始化")
    );
    await expect(
      invokeOperation("operations.initializeEpoch", input, {
        type: "system",
        reason: "deployment",
      })
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      invokeOperation("operations.initializeEpoch", input, {
        type: "user",
        userId: "admin-1",
        role: "super_admin",
      })
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
