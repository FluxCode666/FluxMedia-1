/**
 * MCP 工具工厂测试。
 *
 * 职责：验证 Admin/User MCP 的注册、schema、白名单与 human-only
 * 暴露边界，确保人工会话专属 operation 不会进入 Agent 工具列表。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { usageTrendsInputSchema } from "../analytics/contracts";
import { imageGenerateInputSchema } from "../uol/operations/image-generation";
import type { Principal } from "../uol/principal";
import { bindExecute, clearRegistry, defineOperation } from "../uol/registry";
import type { AccessRequirement, OperationDefinition } from "../uol/types";
import { buildAdminMcpTools } from "./tool-factory";
import { enrichUserMcpToolArguments } from "./user-tool-arguments";
import { buildUserMcpTools } from "./user-tool-factory";

type TestOperationDefinition = OperationDefinition & {
  agentExposure?: "human-only";
};

const apiKeyPrincipal = {
  type: "apiKey",
  userId: "user-1",
  apiKeyId: "key-1",
  plan: "pro",
} satisfies Principal;

const adminPrincipal = {
  type: "user",
  userId: "admin-1",
  role: "super_admin",
} satisfies Principal;

function registerOperation(
  overrides: Partial<TestOperationDefinition> & {
    name: string;
    access: AccessRequirement;
  }
) {
  const definition: TestOperationDefinition = {
    name: overrides.name,
    domain: overrides.domain ?? "image-generation",
    title: overrides.title ?? "Test Operation",
    description: overrides.description ?? "A test operation",
    input: overrides.input ?? z.object({}),
    output: overrides.output ?? z.object({ ok: z.boolean() }),
    access: overrides.access,
    readOnly: overrides.readOnly ?? false,
    destructive: overrides.destructive ?? false,
    idempotency: overrides.idempotency ?? { kind: "natural" },
    sideEffects: overrides.sideEffects ?? [],
    ...(overrides.agentExposure
      ? { agentExposure: overrides.agentExposure }
      : {}),
    execute:
      overrides.execute ??
      (async () => {
        throw new Error(`Not yet wired: ${overrides.name}`);
      }),
  };
  return defineOperation(definition);
}

describe("MCP tool factories", () => {
  beforeEach(() => {
    clearRegistry();
    delete process.env.MCP_DENIED_OPS;
    delete process.env.MCP_READ_ONLY;
  });

  it("hides user tools until their UOL operation is bound", () => {
    registerOperation({
      name: "image.generate",
      access: { kind: "protected" },
    });

    expect(buildUserMcpTools(apiKeyPrincipal)).toHaveLength(0);

    bindExecute("image.generate", async () => ({ ok: true }));

    expect(buildUserMcpTools(apiKeyPrincipal).map((tool) => tool.name)).toEqual(
      ["image.generate"]
    );
  });

  it("hides admin tools until their UOL operation is bound", () => {
    registerOperation({
      name: "pool.getAdminPool",
      domain: "image-backend-pool",
      access: { kind: "imageBackendPoolViewer" },
      readOnly: true,
    });

    expect(buildAdminMcpTools(adminPrincipal)).toHaveLength(0);

    bindExecute("pool.getAdminPool", async () => ({ ok: true }));

    expect(buildAdminMcpTools(adminPrincipal).map((tool) => tool.name)).toEqual(
      ["pool_getAdminPool"]
    );
  });

  it("hides human-only operations from Admin MCP", () => {
    registerOperation({
      name: "moderation.setGlobalRiskLevel",
      domain: "moderation",
      access: { kind: "admin" },
      agentExposure: "human-only",
    });
    bindExecute("moderation.setGlobalRiskLevel", async () => ({ ok: true }));

    expect(buildAdminMcpTools(adminPrincipal)).toHaveLength(0);
  });

  it("hides human-only operations from User MCP", () => {
    registerOperation({
      name: "image.generate",
      access: { kind: "protected" },
      agentExposure: "human-only",
    });
    bindExecute("image.generate", async () => ({ ok: true }));

    expect(buildUserMcpTools(apiKeyPrincipal)).toHaveLength(0);
  });

  it("never projects the system-only platform catalog to Admin or User MCP", () => {
    registerOperation({
      name: "externalApi.getPlatformModelCatalog",
      domain: "external-api",
      access: { kind: "system" },
      agentExposure: "human-only",
      readOnly: true,
    });
    bindExecute("externalApi.getPlatformModelCatalog", async () => ({
      image: [],
      video: [],
      conversation: [],
    }));

    expect(buildAdminMcpTools(adminPrincipal)).toHaveLength(0);
    expect(buildUserMcpTools(apiKeyPrincipal)).toHaveLength(0);
  });

  it("preserves analytics unions, enums, defaults, and user-only exposure", () => {
    registerOperation({
      name: "analytics.getMyUsageTrends",
      domain: "analytics",
      access: { kind: "protected" },
      input: usageTrendsInputSchema,
      readOnly: true,
    });
    bindExecute("analytics.getMyUsageTrends", async () => ({ ok: true }));

    const [tool] = buildUserMcpTools(apiKeyPrincipal);
    expect(tool?.inputSchema).toMatchObject({
      anyOf: expect.arrayContaining([
        expect.objectContaining({
          type: "object",
          properties: expect.objectContaining({
            granularity: { const: "hour" },
            metric: {
              type: "string",
              enum: ["imageCount", "videoSeconds"],
              default: "imageCount",
            },
          }),
          required: expect.not.arrayContaining(["metric"]),
        }),
      ]),
    });
    expect(buildAdminMcpTools(adminPrincipal)).toHaveLength(0);
  });

  it("keeps analytics identity principal-only and overrides legacy userId", () => {
    expect(
      enrichUserMcpToolArguments(
        "analytics.getMyUsageSummary",
        { userId: "another-user" },
        apiKeyPrincipal
      )
    ).toEqual({});
    expect(
      enrichUserMcpToolArguments(
        "image.getUserGenerations",
        { userId: "another-user", page: 2 },
        apiKeyPrincipal
      )
    ).toEqual({ userId: "user-1", page: 2 });
  });

  it("keeps image.generate identity principal-only without dropping governance fields", () => {
    expect(
      enrichUserMcpToolArguments(
        "image.generate",
        {
          userId: "another-user",
          prompt: "a test image",
          relayOnly: true,
          moderationBlockRiskLevel: "low",
        },
        apiKeyPrincipal
      )
    ).toEqual({
      prompt: "a test image",
      relayOnly: true,
      moderationBlockRiskLevel: "low",
    });
  });

  it("projects image.generate schema without identity or governance overrides", () => {
    registerOperation({
      name: "image.generate",
      access: { kind: "protected" },
      input: imageGenerateInputSchema,
    });
    bindExecute("image.generate", async () => ({ ok: true }));

    const [tool] = buildUserMcpTools(apiKeyPrincipal);
    const variants = tool?.inputSchema.anyOf as
      | Array<Record<string, unknown>>
      | undefined;

    expect(variants).toHaveLength(3);
    for (const variant of variants ?? []) {
      const properties = variant.properties as
        | Record<string, unknown>
        | undefined;
      expect(properties).toBeDefined();
      expect(Object.hasOwn(properties ?? {}, "operation")).toBe(true);
      expect(Object.hasOwn(properties ?? {}, "userId")).toBe(false);
      expect(Object.hasOwn(properties ?? {}, "relayOnly")).toBe(false);
      expect(Object.hasOwn(properties ?? {}, "relay_only")).toBe(false);
      expect(Object.hasOwn(properties ?? {}, "moderationBlockRiskLevel")).toBe(
        false
      );
    }
  });

  it.each([
    "credits.getMyBalance",
    "credits.listMyUsageEvents",
    "credits.getMyUsageEventDetail",
    "subscription.listMyPurchasablePlans",
    "subscription.createCheckout",
  ])("does not add wallet operation %s to the User MCP allowlist", (name) => {
    registerOperation({
      name,
      domain: name.startsWith("credits.") ? "credits" : "subscription",
      access: { kind: "protected" },
      readOnly: true,
    });
    bindExecute(name, async () => ({ ok: true }));

    expect(buildUserMcpTools(apiKeyPrincipal)).toHaveLength(0);
  });
});
