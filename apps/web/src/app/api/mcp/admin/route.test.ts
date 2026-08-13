/**
 * Admin MCP 人工会话专属操作隔离测试。
 *
 * 职责：通过真实 JSON-RPC 路由验证 tools/list 只返回工厂生成的列表，
 * tools/call 无法伪造被 human-only 过滤的操作名并触发 UOL。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildAdminMcpTools: vi.fn(),
  ensureUolInitialized: vi.fn(),
  invokeOperation: vi.fn(),
}));

vi.mock("@repo/shared/logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock("@repo/shared/mcp", () => ({
  authenticateMcpAdmin: () => ({
    ok: true,
    principal: {
      type: "user",
      userId: "admin-1",
      role: "super_admin",
    },
  }),
  buildAdminMcpTools: mocks.buildAdminMcpTools,
  getMcpRateLimitPerMin: () => 1_000,
  isMcpAdminEnabled: () => true,
  redactSensitiveFields: (value: unknown) => value,
  toolNameToOperationName: (name: string) => name.replace("_", "."),
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
  OperationError: class OperationError extends Error {},
}));
vi.mock("@repo/shared/uol/operations", () => ({}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import { POST } from "./route";

/** 构造已鉴权 Admin MCP JSON-RPC 请求。 */
function createRpcRequest(
  method: string,
  params?: Record<string, unknown>
): Request {
  return new Request("http://localhost/api/mcp/admin", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("POST /api/mcp/admin human-only isolation", () => {
  beforeEach(() => {
    mocks.buildAdminMcpTools.mockReset().mockReturnValue([
      {
        name: "support_listTickets",
        description: "tickets",
        inputSchema: { type: "object" },
      },
    ]);
    mocks.ensureUolInitialized.mockReset().mockResolvedValue(undefined);
    mocks.invokeOperation.mockReset();
  });

  it("omits human-only operations from tools/list", async () => {
    const response = await POST(createRpcRequest("tools/list"));
    const body = await response.json();
    const names = body.result.tools.map((tool: { name: string }) => tool.name);

    expect(response.status).toBe(200);
    expect(names).toEqual(["support_listTickets"]);
    expect(names).not.toContain("moderation_setGlobalRiskLevel");
    expect(names).not.toContain("modelMarketplace_listPublicModels");
    expect(names).not.toContain("pool_testApiUpstreamAdapter");
    expect(names).not.toContain("pool_getApiUpstreamRuntimeDiagnostics");
    expect(names).not.toContain("pool_listAdminMembers");
    expect(names).not.toContain("pool_listAdminGroups");
  });

  it("rejects direct calls to a human-only operation", async () => {
    for (const name of [
      "moderation_setGlobalRiskLevel",
      "pool_testApiUpstreamAdapter",
      "pool_getApiUpstreamRuntimeDiagnostics",
      "pool_listAdminMembers",
      "pool_listAdminGroups",
    ]) {
      const response = await POST(
        createRpcRequest("tools/call", { name, arguments: {} })
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatchObject({
        code: -32601,
        message: `Tool not available: ${name}`,
      });
    }
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });
});
