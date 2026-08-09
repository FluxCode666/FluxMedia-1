/**
 * User MCP 媒体白名单隔离测试。
 *
 * 通过真实 JSON-RPC route 验证 tools/list 只返回工厂提供的媒体操作，且
 * tools/call 对旧白名单或人工会话操作的直接调用稳定拒绝。
 */

import type { McpApiKeyPrincipal } from "@repo/shared/mcp/user-auth";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateMcpUserKey: vi.fn(),
  bindMcpUserAuth: vi.fn(),
  buildUserMcpTools: vi.fn(),
  enrichUserMcpToolArguments: vi.fn(),
  ensureUolInitialized: vi.fn(),
  invokeOperation: vi.fn(),
}));

vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/database/schema", () => ({ mcpApiKey: {}, user: {} }));
vi.mock("@repo/shared/logger", () => ({ logWarn: vi.fn() }));
vi.mock("@repo/shared/mcp", () => ({
  authenticateMcpUserKey: mocks.authenticateMcpUserKey,
  bindMcpUserAuth: mocks.bindMcpUserAuth,
  buildUserMcpTools: mocks.buildUserMcpTools,
  enrichUserMcpToolArguments: mocks.enrichUserMcpToolArguments,
  isMcpUserEnabled: () => true,
  McpAuthError: class McpAuthError extends Error {
    readonly httpStatus = 401;
  },
}));
vi.mock("@repo/shared/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    success: true,
    limit: 30,
    reset: Date.now() + 60_000,
  }),
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
}));
vi.mock("@repo/shared/uol/operations", () => ({}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureUolInitialized,
}));

import { POST } from "./route";

const principal = {
  type: "apiKey" as const,
  credentialKind: "mcp" as const,
  userId: "user-1",
  apiKeyId: "mcp-key-1",
} satisfies McpApiKeyPrincipal;

/** 构造已鉴权 JSON-RPC 请求；鉴权结果由测试替身提供。 */
function createRpcRequest(
  method: string,
  params?: Record<string, unknown>
): NextRequest {
  return new Request("http://localhost/api/mcp/user", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }) as NextRequest;
}

describe("POST /api/mcp/user media allowlist isolation", () => {
  beforeEach(() => {
    mocks.authenticateMcpUserKey.mockReset().mockResolvedValue(principal);
    mocks.buildUserMcpTools.mockReset().mockReturnValue([
      {
        name: "image.listMyHistoryRecords",
        description: "history",
        inputSchema: { type: "object" },
        annotations: {
          readOnly: true,
          destructive: false,
          sideEffects: [],
          domain: "image-generation",
        },
      },
    ]);
    mocks.ensureUolInitialized.mockReset().mockResolvedValue(undefined);
    mocks.invokeOperation.mockReset();
    mocks.enrichUserMcpToolArguments
      .mockReset()
      .mockImplementation(
        (
          name: string,
          args: Record<string, unknown>,
          authenticatedPrincipal: typeof principal
        ) => {
          if (name === "image.generate") {
            const { userId: _discardedUserId, ...identityFreeArgs } = args;
            return identityFreeArgs;
          }
          return { ...args, userId: authenticatedPrincipal.userId };
        }
      );
  });

  it("returns only the current media tools supplied by the factory", async () => {
    const response = await POST(createRpcRequest("tools/list"));
    const body = await response.json();
    const names = body.result.tools.map((tool: { name: string }) => tool.name);

    expect(response.status).toBe(200);
    expect(names).toEqual(["image.listMyHistoryRecords"]);
    expect(names).not.toContain("modelMarketplace.listPublicModels");
    expect(names).not.toEqual(
      expect.arrayContaining([
        "image.getStatus",
        "image.getUserGenerations",
        "image.getUserGenerationCount",
        "externalApi.getCredits",
        "externalApi.getModels",
        "externalApi.createKey",
        "credits.getBalance",
        "credits.getMyActiveBatches",
        "credits.getMyTransactions",
        "credits.getMyBalance",
        "credits.listMyUsageEvents",
        "credits.getMyUsageEventDetail",
        "subscription.getMyPlan",
        "subscription.canUseCapability",
        "subscription.listMyPurchasablePlans",
        "subscription.createCheckout",
        "analytics.getMyUsageSummary",
        "analytics.getMyUsageTrends",
        "analytics.getMyDataDashboard",
      ])
    );
  });

  it("rejects direct calls to a human-only API key operation", async () => {
    const name = "externalApi.createKey";
    const response = await POST(
      createRpcRequest("tools/call", { name, arguments: {} })
    );
    const body = await response.json();

    expect(body.error).toMatchObject({
      code: -32601,
      message: `Tool not available: ${name}`,
    });
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });

  it("passes image.generate identity only through Principal", async () => {
    mocks.buildUserMcpTools.mockReturnValue([
      {
        name: "image.generate",
        description: "generate",
        inputSchema: {
          type: "object",
          properties: { prompt: { type: "string" } },
        },
        annotations: {
          readOnly: false,
          destructive: false,
          sideEffects: ["billing", "storage", "external-call"],
          domain: "image-generation",
        },
      },
    ]);
    mocks.invokeOperation.mockResolvedValue({ generationId: "generation-1" });

    const response = await POST(
      createRpcRequest("tools/call", {
        name: "image.generate",
        arguments: {
          userId: "another-user",
          prompt: "a test image",
          generationId: "generation-1",
          relayOnly: true,
          moderationBlockRiskLevel: "low",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "image.generate",
      {
        prompt: "a test image",
        generationId: "generation-1",
        relayOnly: true,
        moderationBlockRiskLevel: "low",
      },
      principal
    );
  });

  it.each([
    "image.getStatus",
    "image.getUserGenerations",
    "image.getUserGenerationCount",
    "externalApi.getCredits",
    "externalApi.getModels",
    "credits.getBalance",
    "credits.getMyActiveBatches",
    "credits.getMyTransactions",
    "credits.getMyBalance",
    "credits.listMyUsageEvents",
    "credits.getMyUsageEventDetail",
    "subscription.getMyPlan",
    "subscription.canUseCapability",
    "subscription.listMyPurchasablePlans",
    "subscription.createCheckout",
    "analytics.getMyUsageSummary",
    "analytics.getMyUsageTrends",
    "analytics.getMyDataDashboard",
  ])("returns method-not-found without invoking %s", async (name) => {
    const response = await POST(
      createRpcRequest("tools/call", { name, arguments: {} })
    );
    const body = await response.json();

    expect(body.error).toMatchObject({
      code: -32601,
      message: `Tool not available: ${name}`,
    });
    expect(mocks.invokeOperation).not.toHaveBeenCalled();
  });
});
