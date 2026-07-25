/**
 * 平台公开模型目录运行时服务测试。
 *
 * 使用方：Vitest；通过注入式仓储验证显式字段映射、空目录和事实源失败传播，
 * 无需连接数据库，也不会把凭据、地址、内部 ID 或健康错误带入输出。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@repo/database", () => ({ db: {} }));

/** 加载服务和默认能力矩阵，确保测试环境在数据库模块初始化前完成替换。 */
async function loadService() {
  const [service, capabilities] = await Promise.all([
    import("./platform-model-catalog-service"),
    import("@repo/shared/subscription/services/plan-capabilities"),
  ]);
  return {
    ...service,
    capabilityMatrix: capabilities.DEFAULT_PLAN_CAPABILITY_MATRIX,
  };
}

describe("loadPlatformModelCatalog", () => {
  it("从注入的运行时事实构建目录且不透传敏感 canary", async () => {
    const { capabilityMatrix, loadPlatformModelCatalog } = await loadService();
    const catalog = await loadPlatformModelCatalog({
      loadCapabilityMatrix: async () => capabilityMatrix,
      repository: {
        listGroups: async () => [
          {
            id: "default-group",
            isEnabled: true,
            isDefault: true,
            isUserSelectable: false,
            metadata: {
              minPlan: "starter",
              backendType: "mixed",
              childGroupIds: [],
              internalCanary: "group-secret",
            },
          },
        ],
        listApiMembers: async () => [
          {
            matchedGroupId: "default-group",
            groupId: null,
            isEnabled: true,
            status: "limited",
            cooldownUntil: "2026-07-24T00:00:00.000Z",
            interfaceMode: "images",
            imageUpstreamMode: "images",
            model: "vendor-image",
            supportedModelIds: [],
            adobeSourced: false,
            apiKey: "api-key-canary",
            baseUrl: "https://user:secret@example.test",
            internalId: "member-canary",
            lastError: "database-error-canary",
          },
        ],
        listAccountMembers: async () => [],
        listAdobeMembers: async () => [],
      },
    });

    expect(catalog).toEqual({
      image: [{ id: "vendor-image" }],
      video: [],
      conversation: [],
    });
    expect(JSON.stringify(catalog)).not.toMatch(
      /api-key-canary|secret@example|member-canary|database-error-canary/
    );
  });

  it("在没有可达分组或成员时返回三个空分类", async () => {
    const { capabilityMatrix, loadPlatformModelCatalog } = await loadService();
    await expect(
      loadPlatformModelCatalog({
        loadCapabilityMatrix: async () => capabilityMatrix,
        repository: {
          listGroups: async () => [],
          listApiMembers: async () => [],
          listAccountMembers: async () => [],
          listAdobeMembers: async () => [],
        },
      })
    ).resolves.toEqual({ image: [], video: [], conversation: [] });
  });

  it("事实源失败时拒绝结果而不是回退为静态模型", async () => {
    const { capabilityMatrix, loadPlatformModelCatalog } = await loadService();
    const failure = new Error("runtime catalog unavailable");

    await expect(
      loadPlatformModelCatalog({
        loadCapabilityMatrix: async () => capabilityMatrix,
        repository: {
          listGroups: async () => {
            throw failure;
          },
          listApiMembers: async () => [],
          listAccountMembers: async () => [],
          listAdobeMembers: async () => [],
        },
      })
    ).rejects.toBe(failure);
  });
});

describe("platform model catalog UOL binding", () => {
  let invokeOperation: typeof import("@repo/shared/uol").invokeOperation;
  let bindPlatformModelCatalogOperation: typeof import("@/server/platform-model-catalog-binding").bindPlatformModelCatalogOperation;

  // UOL 全量注册会触发较大的冷启动模块图；放入 suite hook 后，测试的 5 秒预算
  // 只衡量绑定与网关调用本身，避免 CI transform 速度污染业务断言。
  beforeAll(async () => {
    await import("@repo/shared/uol/operations");
    const [uol, binding] = await Promise.all([
      import("@repo/shared/uol"),
      import("@/server/platform-model-catalog-binding"),
    ]);
    invokeOperation = uol.invokeOperation;
    bindPlatformModelCatalogOperation =
      binding.bindPlatformModelCatalogOperation;
  }, 20_000);

  it("经真实 bindExecute 和 invokeOperation 返回严格白名单 DTO", async () => {
    const internalCatalog = {
      image: [
        {
          id: "gpt-image-2",
          apiKey: "binding-api-key-canary",
          baseUrl: "https://user:secret@example.test",
        },
      ],
      video: [],
      conversation: [],
      internalGroupId: "binding-group-canary",
    };
    bindPlatformModelCatalogOperation({
      loadCatalog: async () => internalCatalog,
    });

    const output = await invokeOperation(
      "externalApi.getPlatformModelCatalog",
      {},
      { type: "system", reason: "homepage-platform-model-catalog" }
    );

    expect(output).toEqual({
      image: [{ id: "gpt-image-2" }],
      video: [],
      conversation: [],
    });
    expect(JSON.stringify(output)).not.toMatch(
      /binding-api-key-canary|secret@example|binding-group-canary/
    );
  });

  it("既有启动入口同时绑定 SLA 统计且每次调用都实时读取", async () => {
    const stats = {
      sampleSize: 100,
      completed: 96,
      failed: 4,
      successRate: 0.96,
      platformErrors: 4,
      moderationErrors: 0,
      userRequestErrors: 0,
    };
    const loadGenerationSlaStats = vi.fn().mockResolvedValue(stats);
    bindPlatformModelCatalogOperation({ loadGenerationSlaStats });

    await expect(
      invokeOperation(
        "analytics.getHomepageGenerationSlaStats",
        {},
        { type: "system", reason: "homepage-generation-sla-stats" }
      )
    ).resolves.toEqual(stats);
    await expect(
      invokeOperation(
        "analytics.getHomepageGenerationSlaStats",
        {},
        { type: "system", reason: "homepage-generation-sla-stats" }
      )
    ).resolves.toEqual(stats);
    expect(loadGenerationSlaStats).toHaveBeenCalledTimes(2);
  });
});
