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
      "/dashboard/admin/settings"
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
      "/dashboard/admin/settings"
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
      "/dashboard/admin/settings"
    );
  });
});
