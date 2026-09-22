/**
 * 运营总览 Server Action 薄适配契约测试。
 *
 * 使用方：Vitest。替换 safe-action builder、Go 传输，验证访问事实结果
 * 收敛以及所有管理员 Action 只转发解析后的输入并由 Go 读取会话身份。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type AdminContext = {
  userId: string;
  role: "admin" | "super_admin";
};

type AdminActionInput = {
  ctx: AdminContext;
  parsedInput: unknown;
};

type ProtectedActionInput = {
  ctx: { userId: string };
};

const mocks = vi.hoisted(() => ({
  requestGoJson: vi.fn(),
  tryRecordDashboardWebVisit: vi.fn(),
}));

vi.mock("@repo/shared/safe-action", () => ({
  adminAction: {
    metadata: () => ({
      schema: () => ({
        action:
          <T>(handler: (input: AdminActionInput) => Promise<T>) =>
          (input: AdminActionInput) =>
            handler(input),
      }),
    }),
  },
  protectedAction: {
    metadata: () => ({
      action:
        <T>(handler: (input: ProtectedActionInput) => Promise<T>) =>
        (input: ProtectedActionInput) =>
          handler(input),
    }),
  },
}));

vi.mock("@/server/go-backend-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/go-backend-client")>()),
  requestGoJson: mocks.requestGoJson,
}));

import { GoBackendRequestError } from "@/server/go-backend-client";

vi.mock("./dashboard-web-visit", () => ({
  tryRecordDashboardWebVisit: mocks.tryRecordDashboardWebVisit,
}));

import {
  createOperationsExportAction,
  getOperationsDetailAction,
  getOperationsOverviewAction,
  listOperationsExportsAction,
  prepareOperationsExportDownloadAction,
  recordDashboardWebVisitAction,
  retryOperationsExportAction,
} from "./actions";

type MockAdminAction = (input: AdminActionInput) => Promise<unknown>;
type MockProtectedAction = (input: ProtectedActionInput) => Promise<unknown>;

const adminContext: AdminContext = {
  userId: "admin-1",
  role: "admin",
};

describe("recordDashboardWebVisitAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("使用 session 用户与数据库角色记录服务端自然日", async () => {
    mocks.tryRecordDashboardWebVisit.mockResolvedValue({
      appDate: "2026-08-15",
    });

    await expect(
      (recordDashboardWebVisitAction as unknown as MockProtectedAction)({
        ctx: { userId: "user-1" },
      })
    ).resolves.toEqual({ status: "recorded", appDate: "2026-08-15" });
    expect(mocks.tryRecordDashboardWebVisit).toHaveBeenCalledWith(
      "user-1"
    );
  });

  it("统计不可用时只返回稳定 unavailable 状态", async () => {
    mocks.tryRecordDashboardWebVisit.mockResolvedValue(null);

    await expect(
      (recordDashboardWebVisitAction as unknown as MockProtectedAction)({
        ctx: { userId: "user-1" },
      })
    ).resolves.toEqual({ status: "unavailable" });
  });
});

describe("operations admin actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      "/api/admin/operations/detail",
      getOperationsDetailAction,
      { query: {}, detail: { module: "growth", detail: "users" } },
    ],
    [
      "/api/admin/operations/exports",
      createOperationsExportAction,
      { query: {}, exportType: "user_growth", clientRequestId: "request-1" },
    ],

    [
      "/api/admin/operations/exports/retry",
      retryOperationsExportAction,
      { taskId: "task-1", clientRequestId: "request-2" },
    ],
    [
      "/api/admin/operations/exports/prepare-download",
      prepareOperationsExportDownloadAction,
      { taskId: "task-1", mode: "signed_url" },
    ],
  ] as const)("%s 只转发解析后的请求正文", async (name, action, input) => {
    const output = { marker: name };
    mocks.requestGoJson.mockResolvedValue(output);

    await expect(
      (action as unknown as MockAdminAction)({
        ctx: adminContext,
        parsedInput: input,
      })
    ).resolves.toEqual(output);
    expect(mocks.requestGoJson).toHaveBeenCalledWith(name, {
      method: "POST", body: JSON.stringify(input),
    });
  });

  it("overview 成功时包装 Go 快照为 ready 状态", async () => {
    const snapshot = { marker: "overview" };
    const input = { query: { granularity: "day" } };
    mocks.requestGoJson.mockResolvedValue(snapshot);

    await expect(
      (getOperationsOverviewAction as unknown as MockAdminAction)({
        ctx: { userId: "super-1", role: "super_admin" },
        parsedInput: input,
      })
    ).resolves.toEqual({ status: "ready", snapshot });
    expect(mocks.requestGoJson).toHaveBeenCalledWith(
      "/api/admin/operations/overview",
      { method: "POST", body: JSON.stringify(input) }
    );
  });


  it("导出列表编码游标并使用 GET", async () => {
    mocks.requestGoJson.mockResolvedValue({ items: [], nextCursor: null });
    await (listOperationsExportsAction as unknown as MockAdminAction)({
      ctx: adminContext, parsedInput: { limit: 20, cursor: "signed+/cursor=" },
    });
    expect(mocks.requestGoJson).toHaveBeenCalledWith(
      "/api/admin/operations/exports?limit=20&cursor=signed%2B%2Fcursor%3D"
    );
  });

  it.each([
    [400, "INVALID_INPUT", "validation_error"],
    [429, "RATE_LIMITED", "rate_limited"],
    [503, "NOT_READY", "not_ready"],
    [504, "TIMEOUT", "timeout"],
    [500, "INTERNAL_ERROR", "unavailable"],
  ] as const)("overview 保留 Go HTTP %s %s 的安全状态 %s", async (httpStatus, code, status) => {
    mocks.requestGoJson.mockRejectedValue(new GoBackendRequestError("private details", httpStatus, code));
    await expect((getOperationsOverviewAction as unknown as MockAdminAction)({
      ctx: adminContext, parsedInput: { query: {} },
    })).resolves.toEqual({ status });
  });
});
