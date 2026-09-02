/**
 * 账号池 Server Action 薄适配测试。
 *
 * 职责：证明 API 上游脚本测试、进程诊断和成员启用状态修改只从真实管理员上下文构造
 * Principal，唯一委托对应 UOL operation；测试不加载领域服务、Worker 或数据库。
 */

import { createDefaultApiUpstreamOperations } from "@repo/shared/image-backend/api-upstream-adaptation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  invokeOperation: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@repo/shared/safe-action", () => {
  type ActionHandler = (input: {
    parsedInput: unknown;
    ctx: {
      userId: string;
      role: "observer_admin" | "admin" | "super_admin";
    };
  }) => Promise<unknown>;
  const createBuilder = () => {
    const builder = {
      metadata: () => builder,
      schema: () => builder,
      action: (handler: ActionHandler) => handler,
    };
    return builder;
  };
  return {
    ActionUserError: class ActionUserError extends Error {},
    adminAction: createBuilder(),
    imageBackendPoolViewerAction: createBuilder(),
    protectedAction: createBuilder(),
  };
});

vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: vi.fn(async () => "admin"),
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
  OperationError: class OperationError extends Error {},
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import {
  getApiUpstreamRuntimeDiagnosticsAction,
  importImageBackendMembersAction,
  listAdminImageBackendGroupsAction,
  saveImageBackendGroupAction,
  saveImageBackendMemberAction,
  setImageBackendMemberEnabledAction,
  testApiUpstreamAdapterAction,
} from "./actions";

type MockAction = (input: {
  parsedInput: unknown;
  ctx: {
    userId: string;
    role: "observer_admin" | "admin" | "super_admin";
  };
}) => Promise<unknown>;

/** 验证成功写入同时失效供应商与分组管理页面。 */
function expectBackendPoolManagementPagesRevalidated(): void {
  expect(mocks.revalidatePath).toHaveBeenCalledTimes(2);
  expect(mocks.revalidatePath).toHaveBeenNthCalledWith(
    1,
    "/dashboard/admin/suppliers"
  );
  expect(mocks.revalidatePath).toHaveBeenNthCalledWith(
    2,
    "/dashboard/admin/supplier-groups"
  );
}

describe("image backend pool actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
  });

  it("分组分页动作只委托独立列表 operation", async () => {
    const input = { page: 3, pageSize: 50, name: "primary" };
    const output = {
      records: [],
      page: 1,
      pageSize: 50,
      totalCount: 0,
      totalPages: 1,
    };
    mocks.invokeOperation.mockResolvedValue(output);

    await expect(
      (listAdminImageBackendGroupsAction as unknown as MockAction)({
        parsedInput: input,
        ctx: { userId: "admin-1", role: "admin" },
      })
    ).resolves.toBe(output);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.listAdminGroups",
      input,
      { type: "user", userId: "admin-1", role: "admin" }
    );
  });

  it("脚本测试只调用 human-only UOL operation", async () => {
    const input = {
      operation: "videos.generate",
      stage: "request",
      script: "return { body: input };",
      sample: { model: "seedance2" },
    };
    const output = { preview: { body: { model: "seedance2" } } };
    mocks.invokeOperation.mockResolvedValue(output);

    await expect(
      (testApiUpstreamAdapterAction as unknown as MockAction)({
        parsedInput: input,
        ctx: { userId: "admin-1", role: "admin" },
      })
    ).resolves.toBe(output);
    expect(mocks.ensureUolInitialized).toHaveBeenCalledOnce();
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.testApiUpstreamAdapter",
      input,
      { type: "user", userId: "admin-1", role: "admin" }
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("运行诊断只读取当前进程 UOL operation", async () => {
    const output = {
      lifecycle: "ready",
      workerCount: 1,
      liveWorkerCount: 1,
      requestQueueLength: 0,
      responseQueueLength: 0,
      responsePermitsInUse: 0,
      responsePermitCapacity: 16,
      saturationCount: 0,
      replacementCount: 0,
    };
    mocks.invokeOperation.mockResolvedValue(output);

    await expect(
      (getApiUpstreamRuntimeDiagnosticsAction as unknown as MockAction)({
        parsedInput: {},
        ctx: { userId: "super-admin-1", role: "super_admin" },
      })
    ).resolves.toBe(output);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.getApiUpstreamRuntimeDiagnostics",
      {},
      {
        type: "user",
        userId: "super-admin-1",
        role: "super_admin",
      }
    );
  });

  it("修改成员启用状态只调用对应 UOL operation 并刷新两个管理页", async () => {
    const input = { id: "member-a", isEnabled: false };
    const output = { id: "member-a", isEnabled: false };
    mocks.invokeOperation.mockResolvedValue(output);

    await expect(
      (setImageBackendMemberEnabledAction as unknown as MockAction)({
        parsedInput: input,
        ctx: { userId: "admin-1", role: "admin" },
      })
    ).resolves.toEqual({ success: true, ...output });
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.setMemberEnabled",
      input,
      { type: "user", userId: "admin-1", role: "admin" }
    );
    expectBackendPoolManagementPagesRevalidated();
  });

  it("分组与成员成功写入均刷新两个相互影响的管理页", async () => {
    mocks.invokeOperation.mockResolvedValue({ id: "created-id" });

    await expect(
      (saveImageBackendGroupAction as unknown as MockAction)({
        parsedInput: { name: "primary" },
        ctx: { userId: "admin-1", role: "admin" },
      })
    ).resolves.toEqual({ success: true, id: "created-id" });
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.saveGroup",
      { name: "primary" },
      { type: "user", userId: "admin-1", role: "admin" }
    );
    expectBackendPoolManagementPagesRevalidated();

    vi.clearAllMocks();
    mocks.invokeOperation.mockResolvedValue({ id: "member-id" });

    await expect(
      (saveImageBackendMemberAction as unknown as MockAction)({
        parsedInput: { name: "supplier" },
        ctx: { userId: "admin-1", role: "admin" },
      })
    ).resolves.toEqual({ success: true, id: "member-id" });
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.saveMember",
      { name: "supplier" },
      { type: "user", userId: "admin-1", role: "admin" }
    );
    expectBackendPoolManagementPagesRevalidated();
  });

  it("写入失败时不会伪造双路由刷新", async () => {
    mocks.invokeOperation.mockRejectedValue(new Error("保存失败"));

    await expect(
      (saveImageBackendGroupAction as unknown as MockAction)({
        parsedInput: { name: "primary" },
        ctx: { userId: "admin-1", role: "admin" },
      })
    ).rejects.toThrow("保存失败");

    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("批量导入逐条校验并只为成功条目刷新管理页", async () => {
    mocks.invokeOperation.mockResolvedValue({ id: "member-imported" });
    const member = {
      id: "member-imported",
      name: "纳米 AI",
      type: "api",
      groupIds: ["group-primary"],
      supportedModelIds: ["gpt-image-2"],
      supportedResolutionsByModel: { "gpt-image-2": ["1k", "2k"] },
      contentSafetyEnabled: true,
      isEnabled: true,
      alwaysActive: false,
      failureCooldownEnabled: true,
      priority: 50,
      concurrency: 10,
      config: {
        baseUrl: "https://provider.example.com/v1",
        apiKey: "test-key",
        useStream: false,
        videoSubmissionRetryCount: 2,
        videoProtocolMode: "custom",
        videoInputFormat: "url",
        videoInputCapabilities: {
          referenceVideos: false,
          referenceAudios: false,
        },
        videoInputCapabilitiesByModel: {},
        modelMappings: [],
        authentication: { mode: "bearer" },
        expectedCurrentVersionId: "adapter-current",
        operations: createDefaultApiUpstreamOperations(),
      },
    };

    await expect(
      (importImageBackendMembersAction as unknown as MockAction)({
        parsedInput: {
          format: "fluxmedia-backend-members",
          version: 1,
          exportedAt: "2026-08-24T00:00:00.000Z",
          members: [member, { name: "坏账号" }],
        },
        ctx: { userId: "admin-1", role: "admin" },
      })
    ).resolves.toEqual({
      imported: [{ index: 0, id: "member-imported", name: "纳米 AI" }],
      failed: [
        {
          index: 1,
          name: "坏账号",
          message: expect.any(String),
        },
      ],
    });
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.saveMember",
      member,
      { type: "user", userId: "admin-1", role: "admin" }
    );
    expectBackendPoolManagementPagesRevalidated();
  });
});
