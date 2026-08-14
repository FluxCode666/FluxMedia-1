/**
 * 站内视频能力查询路由测试。
 *
 * 使用方：Vitest；锁定 Cookie session 到用户 Principal 的薄适配、未登录拒绝、
 * UOL 错误映射和 no-store 响应，防止 Web 绕过统一能力事实源。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockOperationError extends Error {
    readonly code: string;
    readonly httpStatus: number;

    constructor(code: string, message: string, httpStatus: number) {
      super(message);
      this.code = code;
      this.httpStatus = httpStatus;
    }
  }

  return {
    getSession: vi.fn(),
    getUserRoleById: vi.fn(),
    ensureInitialized: vi.fn(),
    invokeOperation: vi.fn(),
    MockOperationError,
  };
});

vi.mock("@repo/shared/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: mocks.getUserRoleById,
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
  OperationError: mocks.MockOperationError,
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureInitialized,
}));

import { GET } from "./route";

describe("GET /api/videos/capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getUserRoleById.mockResolvedValue("user");
    mocks.ensureInitialized.mockResolvedValue(undefined);
    mocks.invokeOperation.mockResolvedValue({
      items: [],
      limits: {
        maxMediaInputCount: 256,
        maxMediaInputBytes: 536_870_912,
      },
    });
  });

  it("使用当前用户 Principal 调用统一能力 operation", async () => {
    const request = new Request("https://example.com/api/videos/capabilities", {
      headers: { "x-request-id": "req-web-capabilities" },
    });
    const response = await GET(request as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.listCapabilities",
      {},
      { type: "user", userId: "user-1", role: "user" },
      { externalRequestId: "req-web-capabilities" }
    );
  });

  it("未登录时拒绝且不初始化 UOL", async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await GET(
      new Request("https://example.com/api/videos/capabilities") as never
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.ensureInitialized).not.toHaveBeenCalled();
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("把 UOL 稳定错误映射为 HTTP 响应", async () => {
    mocks.invokeOperation.mockRejectedValue(
      new mocks.MockOperationError("not_ready", "视频模型能力暂时不可用", 503)
    );

    const response = await GET(
      new Request("https://example.com/api/videos/capabilities") as never
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "视频模型能力暂时不可用",
      code: "not_ready",
    });
  });
});
