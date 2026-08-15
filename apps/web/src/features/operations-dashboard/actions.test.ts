/**
 * 运营总览 Server Action 薄适配契约测试。
 *
 * 使用方：Vitest。替换 safe-action builder、角色读取和 UOL 网关，验证访问事实结果
 * 收敛以及所有管理员 Action 只转发解析后的输入和真实 Principal。
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
  ensureUolInitialized: vi.fn(),
  getUserRoleById: vi.fn(),
  invokeOperation: vi.fn(),
  tryRecordDashboardWebVisit: vi.fn(),
}));

vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: mocks.getUserRoleById,
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

vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
}));

vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

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
    mocks.getUserRoleById.mockResolvedValue("user");
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
    expect(mocks.getUserRoleById).toHaveBeenCalledWith("user-1");
    expect(mocks.tryRecordDashboardWebVisit).toHaveBeenCalledWith(
      "user-1",
      "user"
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
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
  });

  it.each([
    [
      "operations.getDetail",
      getOperationsDetailAction,
      { query: {}, detail: { module: "growth", detail: "users" } },
    ],
    [
      "operations.createExport",
      createOperationsExportAction,
      { query: {}, exportType: "user_growth", clientRequestId: "request-1" },
    ],
    ["operations.listExports", listOperationsExportsAction, { limit: 20 }],
    [
      "operations.retryExport",
      retryOperationsExportAction,
      { taskId: "task-1", clientRequestId: "request-2" },
    ],
    [
      "operations.prepareExportDownload",
      prepareOperationsExportDownloadAction,
      { taskId: "task-1", mode: "signed_url" },
    ],
  ] as const)("%s 转发解析输入和管理员 Principal", async (name, action, input) => {
    const output = { marker: name };
    mocks.invokeOperation.mockResolvedValue(output);

    await expect(
      (action as unknown as MockAdminAction)({
        ctx: adminContext,
        parsedInput: input,
      })
    ).resolves.toEqual(output);
    expect(mocks.ensureUolInitialized).toHaveBeenCalledOnce();
    expect(mocks.invokeOperation).toHaveBeenCalledWith(name, input, {
      type: "user",
      userId: "admin-1",
      role: "admin",
    });
  });

  it("overview 成功时包装 ready 快照并保留 super_admin Principal", async () => {
    const snapshot = { marker: "overview" };
    const input = { query: { granularity: "day" } };
    mocks.invokeOperation.mockResolvedValue(snapshot);

    await expect(
      (getOperationsOverviewAction as unknown as MockAdminAction)({
        ctx: { userId: "super-1", role: "super_admin" },
        parsedInput: input,
      })
    ).resolves.toEqual({ status: "ready", snapshot });
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "operations.getOverview",
      input,
      { type: "user", userId: "super-1", role: "super_admin" }
    );
  });
});
