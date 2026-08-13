/**
 * Dashboard 网页访问站内适配器测试。
 *
 * 使用方：Vitest；验证真实 user Principal、UOL 初始化及失败时不泄露用户或错误内容。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  invokeOperation: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
}));
vi.mock("@repo/shared/logger", () => ({ logWarn: mocks.logWarn }));

import { tryRecordDashboardWebVisit } from "./dashboard-web-visit";

describe("tryRecordDashboardWebVisit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
  });

  it("只以服务端 session 构造的 user Principal 调用空输入 operation", async () => {
    mocks.invokeOperation.mockResolvedValue({
      appDate: "2026-08-13",
      recorded: true,
    });

    await expect(
      tryRecordDashboardWebVisit("user-1", "admin")
    ).resolves.toEqual({ appDate: "2026-08-13", recorded: true });
    expect(mocks.ensureUolInitialized).toHaveBeenCalledOnce();
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "operations.recordWebVisit",
      {},
      { type: "user", userId: "user-1", role: "admin" }
    );
  });

  it("统计失败只记录脱敏告警并返回 null", async () => {
    mocks.invokeOperation.mockRejectedValue(
      new Error("private SQL for user-1 at /dashboard/private")
    );

    await expect(
      tryRecordDashboardWebVisit("user-1", "user")
    ).resolves.toBeNull();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      "Dashboard web visit recording failed",
      {
        source: "dashboard-web-visit",
        operation: "operations.recordWebVisit",
        errorType: "Error",
      }
    );
  });
});
