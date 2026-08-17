/**
 * 账号池 Server Action 薄适配测试。
 *
 * 职责：证明 API 上游脚本测试、进程诊断和成员启用状态修改只从真实管理员上下文构造
 * Principal，唯一委托对应 UOL operation；测试不加载领域服务、Worker 或数据库。
 */
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
  checkAdobeCredentialHealthAction,
  getAdminImageBackendPoolAction,
  getAdobeCredentialHealthAction,
  getApiUpstreamRuntimeDiagnosticsAction,
  listAdminImageBackendGroupsAction,
  listAdminImageBackendMembersAction,
  reauthorizeAdobeCredentialAction,
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

describe("image backend pool actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureUolInitialized.mockResolvedValue(undefined);
  });

  it("账号池查看动作并行合并 human-only 凭据健康状态", async () => {
    const pool = {
      groups: [],
      members: [
        { id: "direct-a", name: "Adobe Direct" },
        { id: "api-a", name: "API" },
      ],
    };
    mocks.invokeOperation.mockImplementation(async (name: string) => {
      if (name === "pool.getAdminPool") return pool;
      if (name === "pool.listAdobeCredentialHealthStatuses") {
        return {
          statuses: [{ memberId: "direct-a", status: "degraded" }],
        };
      }
      throw new Error(`未预期 operation：${name}`);
    });

    await expect(
      (getAdminImageBackendPoolAction as unknown as MockAction)({
        parsedInput: {},
        ctx: { userId: "observer-1", role: "observer_admin" },
      })
    ).resolves.toEqual({
      groups: [],
      members: [
        {
          id: "direct-a",
          name: "Adobe Direct",
          credentialHealthStatus: "degraded",
        },
        {
          id: "api-a",
          name: "API",
          credentialHealthStatus: null,
        },
      ],
    });
    const principal = {
      type: "user",
      userId: "observer-1",
      role: "observer_admin",
    };
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.getAdminPool",
      {},
      principal
    );
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.listAdobeCredentialHealthStatuses",
      {},
      principal
    );
  });

  it("成员分页动作只调用 human-only 列表 operation 并补空诊断字段", async () => {
    const input = {
      page: 2,
      pageSize: 20,
      name: "Adobe",
      credentialStatus: "healthy",
      modelId: "all",
      createdFrom: "",
      createdTo: "",
      timeZone: "Asia/Shanghai",
    };
    mocks.invokeOperation.mockResolvedValue({
      records: [
        {
          id: "direct-a",
          name: "Adobe Direct",
          type: "adobe",
          config: {
            mode: "direct",
            hasCookie: true,
            displayName: null,
            email: null,
            credentialStatus: "active",
            lastRefreshAt: null,
            lastRefreshError: null,
            consecutiveFailures: 0,
            fireflyCredentialStatus: null,
            fireflyLastRefreshAt: null,
            fireflyLastRefreshError: null,
            fireflyConsecutiveFailures: 0,
            creditsTotal: null,
            creditsUsed: null,
            creditsAvailable: null,
            creditsUpdatedAt: null,
            creditsError: null,
            defaultRatio: "1x1",
            defaultResolution: "2k",
            gptImageQuality: "high",
          },
          credentialHealthStatus: "healthy",
        },
      ],
      page: 1,
      pageSize: 20,
      totalCount: 1,
      totalPages: 1,
    });

    const result = await (
      listAdminImageBackendMembersAction as unknown as MockAction
    )({
      parsedInput: input,
      ctx: { userId: "observer-1", role: "observer_admin" },
    });
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.listAdminMembers",
      input,
      { type: "user", userId: "observer-1", role: "observer_admin" }
    );
    expect(result).toMatchObject({
      records: [
        {
          config: {
            lastRefreshError: null,
            fireflyLastRefreshError: null,
            creditsError: null,
          },
        },
      ],
    });
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

  it("修改成员启用状态只调用对应 UOL operation 并刷新管理页", async () => {
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
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/dashboard/admin/suppliers"
    );
  });

  it("Adobe 健康详情读取只委托 human-only UOL operation", async () => {
    const input = { memberId: "member-adobe" };
    const output = {
      memberId: "member-adobe",
      status: "isolated",
      diagnostic: { adobeErrorCode: "expired_token" },
    };
    mocks.invokeOperation.mockResolvedValue(output);

    await expect(
      (getAdobeCredentialHealthAction as unknown as MockAction)({
        parsedInput: input,
        ctx: { userId: "admin-1", role: "admin" },
      })
    ).resolves.toBe(output);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.getAdobeCredentialHealth",
      input,
      { type: "user", userId: "admin-1", role: "admin" }
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("Adobe 立即检查成功后刷新管理页", async () => {
    const input = { memberId: "member-adobe" };
    const output = {
      evaluationId: "evaluation-1",
      disposition: "accepted",
      health: { memberId: "member-adobe", status: "healthy" },
    };
    mocks.invokeOperation.mockResolvedValue(output);

    await expect(
      (checkAdobeCredentialHealthAction as unknown as MockAction)({
        parsedInput: input,
        ctx: { userId: "admin-1", role: "admin" },
      })
    ).resolves.toBe(output);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.checkAdobeCredentialHealth",
      input,
      { type: "user", userId: "admin-1", role: "admin" }
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/dashboard/admin/suppliers"
    );
  });

  it("Adobe 同账号重新授权传递浏览器幂等键并刷新管理页", async () => {
    const input = {
      memberId: "member-adobe",
      cookie: "aux_sid=new-cookie",
      clientRequestId: "request-1",
    };
    const output = {
      evaluationId: "evaluation-reauthorized",
      disposition: "accepted",
      health: { memberId: "member-adobe", status: "healthy" },
    };
    mocks.invokeOperation.mockResolvedValue(output);

    await expect(
      (reauthorizeAdobeCredentialAction as unknown as MockAction)({
        parsedInput: input,
        ctx: { userId: "super-admin-1", role: "super_admin" },
      })
    ).resolves.toBe(output);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "pool.reauthorizeAdobeCredential",
      input,
      {
        type: "user",
        userId: "super-admin-1",
        role: "super_admin",
      }
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/dashboard/admin/suppliers"
    );
  });
});
