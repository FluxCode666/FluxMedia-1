/**
 * 管理端数据看板 Server Action 薄适配测试。
 *
 * 使用方：Vitest；验证 Action 只使用 adminAction 提供的真实管理员 Principal，并把
 * Go 稳定错误收敛为无内部详情的客户端状态。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestGoJson: vi.fn(),
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
vi.mock("@/server/go-backend-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/go-backend-client")>()),
  requestGoJson: mocks.requestGoJson,
}));

import { GoBackendRequestError } from "@/server/go-backend-client";

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
  });

  it("把解析后的筛选发送到 Go 管理员端点，由会话转发确定身份", async () => {
    const snapshot = { marker: "snapshot" };
    const input = { startDate: "2026-08-03", endDate: "2026-08-09" };
    mocks.requestGoJson.mockResolvedValue({ status: "ready", snapshot });

    await expect(
      (refreshAdminDataDashboardAction as unknown as MockAction)({
        ctx: { userId: "admin-1", role: "admin" },
        parsedInput: input,
      })
    ).resolves.toEqual({ status: "ready", snapshot });
    expect(mocks.requestGoJson).toHaveBeenCalledWith(
      "/api/admin/analytics/data-dashboard",
      { method: "POST", body: JSON.stringify(input) }
    );
  });

  it.each([
    [400, "INVALID_INPUT", "validation_error"],
    [503, "NOT_READY", "not_ready"],
    [429, "RATE_LIMITED", "rate_limited"],
    [504, "TIMEOUT", "timeout"],
    [408, "TIMEOUT", "timeout"],
    [403, "FORBIDDEN", "unavailable"],
    [500, "INTERNAL_ERROR", "unavailable"],
  ] as const)("Go HTTP %s %s 映射为 %s 状态", async (httpStatus, code, status) => {
    mocks.requestGoJson.mockRejectedValue(
      new GoBackendRequestError("safe operation failure", httpStatus, code)
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
    mocks.requestGoJson.mockRejectedValue(error);

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
  it("将用户搜索和已选用户编码给 Go，正文不携带管理员身份", async () => {
    const output = {
      users: [{ id: "user-1", name: "张三", email: "zhang@example.com" }],
    };
    mocks.requestGoJson.mockResolvedValue(output);

    await expect(
      (searchAdminDataDashboardUsersAction as unknown as MockAction)({
        ctx: { userId: "admin-1", role: "admin" },
        parsedInput: { query: "张", limit: 20, selectedUserId: "selected-user" },
      })
    ).resolves.toEqual(output);
    expect(mocks.requestGoJson).toHaveBeenCalledWith(
      "/api/admin/analytics/users?query=%E5%BC%A0&limit=20&selectedUserId=selected-user"
    );
  });
});
