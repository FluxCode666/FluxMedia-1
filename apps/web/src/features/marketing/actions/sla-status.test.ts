/** 首页 SLA 展示开关 Go 传输核心测试。 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  requestGoJson: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@repo/shared/logger", () => ({ logger: { error: runtimeMocks.loggerError } }));
vi.mock("@/server/go-backend-client", () => ({ requestGoJson: runtimeMocks.requestGoJson }));
vi.mock("@repo/shared/safe-action", () => {
  class ActionUserError extends Error {
    constructor(message: string) { super(message); this.name = "ActionUserError"; }
  }
  type Builder = { metadata: (_value: unknown) => Builder; schema: (_value: unknown) => Builder; action: <T>(handler: T) => T };
  const builder = {} as Builder;
  builder.metadata = () => builder;
  builder.schema = () => builder;
  builder.action = <T>(handler: T) => handler;
  return { ActionUserError, protectedAction: builder };
});

import { runMarketingSlaVisibilityUpdate } from "./sla-status";

describe("runMarketingSlaVisibilityUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.requestGoJson.mockResolvedValue({ enabled: false });
  });

  it("调用 Go 管理接口并返回最小 DTO", async () => {
    const updateVisibility = (input: { enabled: boolean }) =>
      runtimeMocks.requestGoJson("/api/marketing/sla-visibility", {
        method: "PUT",
        body: JSON.stringify(input),
      });
    await expect(
      runMarketingSlaVisibilityUpdate({ enabled: false }, "admin-1", {
        updateVisibility,
        reportFailure: runtimeMocks.loggerError,
      })
    ).resolves.toEqual({ enabled: false });
    expect(runtimeMocks.requestGoJson).toHaveBeenCalledWith(
      "/api/marketing/sla-visibility",
      { method: "PUT", body: JSON.stringify({ enabled: false }) }
    );
  });

  it("把 Go 权限错误映射为稳定管理员提示", async () => {
    const reportFailure = vi.fn();
    await expect(
      runMarketingSlaVisibilityUpdate({ enabled: true }, "admin-1", {
        updateVisibility: async () => { throw new Error("没有权限执行此操作"); },
        reportFailure,
      })
    ).rejects.toThrow("此操作需要管理员权限");
    expect(reportFailure).toHaveBeenCalledWith({
      event: "marketing_sla_visibility_update_failed",
      safeCode: "forbidden",
    });
  });

  it("未知异常返回通用提示且安全日志不包含原始异常", async () => {
    const reportFailure = vi.fn();
    await expect(
      runMarketingSlaVisibilityUpdate({ enabled: true }, "admin-1", {
        updateVisibility: async () => {
          throw new Error("https://user:password@example.test Bearer token-canary SELECT api_key=key-canary");
        },
        reportFailure,
      })
    ).rejects.toThrow("更新首页 SLA 展示失败，请稍后重试");
    expect(reportFailure).toHaveBeenCalledWith({
      event: "marketing_sla_visibility_update_failed",
      safeCode: "unexpected_failure",
    });
    expect(JSON.stringify(reportFailure.mock.calls)).not.toMatch(/password@example|Bearer|token-canary|SELECT|api_key|key-canary/);
  });
});
