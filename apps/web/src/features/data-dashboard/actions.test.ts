/**
 * 数据看板 Server Action 薄适配测试。
 *
 * 使用方：Vitest；验证 action 只使用 protected session userId、角色与 strict 日期输入，
 * 并把 UOL 稳定错误转换为客户端可恢复状态而不泄露内部异常。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserRoleById: vi.fn(),
  loadDataDashboardPageData: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/shared/safe-action", () => ({
  protectedAction: {
    metadata: () => ({
      schema: () => ({
        action:
          <T>(
            handler: (input: {
              ctx: { userId: string };
              parsedInput: unknown;
            }) => Promise<T>
          ) =>
          (input: { ctx: { userId: string }; parsedInput: unknown }) =>
            handler(input),
      }),
    }),
  },
}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: mocks.getUserRoleById,
}));
vi.mock("@repo/shared/logger", () => ({ logError: mocks.logError }));
vi.mock("@repo/shared/uol", () => ({
  OperationError: class OperationError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.name = "OperationError";
      this.code = code;
    }
  },
}));
vi.mock("./data-dashboard-page-data", () => ({
  loadDataDashboardPageData: mocks.loadDataDashboardPageData,
}));

import { OperationError } from "@repo/shared/uol";
import { refreshDataDashboardAction } from "./actions";

type MockAction = (input: {
  ctx: { userId: string };
  parsedInput: unknown;
}) => Promise<unknown>;

describe("refreshDataDashboardAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserRoleById.mockResolvedValue("user");
  });

  it("以当前 session 用户加载一次原子快照", async () => {
    const snapshot = { marker: "snapshot" };
    mocks.loadDataDashboardPageData.mockResolvedValue(snapshot);
    const input = { startDate: "2026-08-01", endDate: "2026-08-09" };

    await expect(
      (refreshDataDashboardAction as unknown as MockAction)({
        ctx: { userId: "session-user" },
        parsedInput: input,
      })
    ).resolves.toEqual({ status: "ready", snapshot });
    expect(mocks.loadDataDashboardPageData).toHaveBeenCalledWith({
      userId: "session-user",
      role: "user",
      rangeInput: input,
    });
  });

  it.each([
    ["validation_error", "validation_error"],
    ["not_ready", "not_ready"],
    ["rate_limited", "rate_limited"],
    ["timeout", "timeout"],
    ["unauthenticated", "unauthenticated"],
    ["internal_error", "unavailable"],
  ] as const)("将 %s 映射为 %s 状态", async (code, status) => {
    mocks.loadDataDashboardPageData.mockRejectedValue(
      new OperationError(code, "safe operation failure")
    );

    await expect(
      (refreshDataDashboardAction as unknown as MockAction)({
        ctx: { userId: "session-user" },
        parsedInput: {},
      })
    ).resolves.toEqual({ status });
  });

  it("未知异常记录服务端日志并返回无详情 unavailable", async () => {
    const error = new Error("database credentials and private SQL");
    mocks.loadDataDashboardPageData.mockRejectedValue(error);

    await expect(
      (refreshDataDashboardAction as unknown as MockAction)({
        ctx: { userId: "session-user" },
        parsedInput: {},
      })
    ).resolves.toEqual({ status: "unavailable" });
    expect(mocks.logError).toHaveBeenCalledWith(error, {
      source: "data-dashboard-action",
    });
  });
});
