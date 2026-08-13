/**
 * 管理端数据看板 Server Action 薄适配测试。
 *
 * 使用方：Vitest；验证 Action 只使用 adminAction 提供的真实管理员 Principal，并把
 * UOL 稳定错误收敛为无内部详情的客户端状态。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  invokeOperation: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/shared/safe-action", () => ({
  adminAction: {
    metadata: () => ({
      schema: () => ({
        action:
          <T>(
            handler: (input: {
              ctx: { userId: string; role: "admin" | "super_admin" };
              parsedInput: unknown;
            }) => Promise<T>
          ) =>
          (input: {
            ctx: { userId: string; role: "admin" | "super_admin" };
            parsedInput: unknown;
          }) =>
            handler(input),
      }),
    }),
  },
}));
vi.mock("@repo/shared/logger", () => ({ logError: mocks.logError }));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
  OperationError: class OperationError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = "OperationError";
      this.code = code;
    }
  },
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import { OperationError } from "@repo/shared/uol";

import {
  refreshAdminDataDashboardAction,
  searchAdminDataDashboardUsersAction,
} from "./admin-actions";

type MockAction = (input: {
  ctx: { userId: string; role: "admin" | "super_admin" };
  parsedInput: unknown;
}) => Promise<unknown>;

describe("refreshAdminDataDashboardAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
  });

  it("使用管理员 Principal 调用全站 operation", async () => {
    const snapshot = { marker: "snapshot" };
    const input = { startDate: "2026-08-03", endDate: "2026-08-09" };
    mocks.invokeOperation.mockResolvedValue(snapshot);

    await expect(
      (refreshAdminDataDashboardAction as unknown as MockAction)({
        ctx: { userId: "admin-1", role: "admin" },
        parsedInput: input,
      })
    ).resolves.toEqual({ status: "ready", snapshot });
    expect(mocks.ensureUolInitialized).toHaveBeenCalledOnce();
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "analytics.getAdminDataDashboard",
      input,
      { type: "user", userId: "admin-1", role: "admin" }
    );
  });

  it.each([
    ["validation_error", "validation_error"],
    ["not_ready", "not_ready"],
    ["rate_limited", "rate_limited"],
    ["timeout", "timeout"],
    ["forbidden", "unavailable"],
    ["internal_error", "unavailable"],
  ] as const)("将 %s 映射为 %s 状态", async (code, status) => {
    mocks.invokeOperation.mockRejectedValue(
      new OperationError(code, "safe operation failure")
    );

    await expect(
      (refreshAdminDataDashboardAction as unknown as MockAction)({
        ctx: { userId: "admin-1", role: "super_admin" },
        parsedInput: {},
      })
    ).resolves.toEqual({ status });
  });

  it("未知异常记录日志并返回 unavailable", async () => {
    const error = new Error("private database failure");
    mocks.invokeOperation.mockRejectedValue(error);

    await expect(
      (refreshAdminDataDashboardAction as unknown as MockAction)({
        ctx: { userId: "admin-1", role: "admin" },
        parsedInput: {},
      })
    ).resolves.toEqual({ status: "unavailable" });
    expect(mocks.logError).toHaveBeenCalledWith(error, {
      source: "admin-data-dashboard-action",
    });
  });
});

describe("searchAdminDataDashboardUsersAction", () => {
  it("使用管理员 Principal 调用用户搜索 operation", async () => {
    const output = {
      users: [{ id: "user-1", name: "张三", email: "zhang@example.com" }],
    };
    mocks.invokeOperation.mockResolvedValue(output);

    await expect(
      (searchAdminDataDashboardUsersAction as unknown as MockAction)({
        ctx: { userId: "admin-1", role: "admin" },
        parsedInput: { query: "张", limit: 20 },
      })
    ).resolves.toEqual(output);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "analytics.searchAdminDataDashboardUsers",
      { query: "张", limit: 20 },
      { type: "user", userId: "admin-1", role: "admin" }
    );
  });
});
