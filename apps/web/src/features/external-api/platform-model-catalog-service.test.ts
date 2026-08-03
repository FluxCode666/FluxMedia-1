/**
 * 平台媒体模型目录运行时服务与首页可靠性 UOL binding 测试。
 *
 * 职责：验证运行时事实注入、失败透传和 strict DTO 白名单，不连接数据库。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@repo/database", () => ({ db: {} }));

/** 加载服务及默认动态能力矩阵。 */
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
  it("从注入的统一成员事实构建媒体目录", async () => {
    const { capabilityMatrix, loadPlatformModelCatalog } = await loadService();
    await expect(
      loadPlatformModelCatalog({
        loadCapabilityMatrix: async () => capabilityMatrix,
        loadMarketplaceConfig: async () => null,
        repository: {
          listGroups: async () => [
            {
              id: "default-group",
              isEnabled: true,
              isDefault: true,
              isUserSelectable: false,
              minPlan: "starter",
            },
          ],
          listMembers: async () => [
            {
              groupIds: ["default-group"],
              type: "api",
              adobeMode: null,
              supportedModelIds: ["vendor-image"],
              isEnabled: true,
              status: "limited",
              apiKey: "canary-secret",
            },
          ],
        },
      })
    ).resolves.toEqual({ image: [{ id: "vendor-image" }], video: [] });
  });

  it("事实源失败时拒绝结果而不回退静态模型", async () => {
    const { capabilityMatrix, loadPlatformModelCatalog } = await loadService();
    const failure = new Error("runtime catalog unavailable");
    await expect(
      loadPlatformModelCatalog({
        loadCapabilityMatrix: async () => capabilityMatrix,
        loadMarketplaceConfig: async () => null,
        repository: {
          listGroups: async () => {
            throw failure;
          },
          listMembers: async () => [],
        },
      })
    ).rejects.toBe(failure);
  });
});

describe("homepage reliability UOL binding", () => {
  let invokeOperation: typeof import("@repo/shared/uol").invokeOperation;
  let bindHomepageReliabilityOperation: typeof import("@/server/homepage-reliability-binding").bindHomepageReliabilityOperation;

  beforeAll(async () => {
    await import("@repo/shared/uol/operations");
    const [uol, binding] = await Promise.all([
      import("@repo/shared/uol"),
      import("@/server/homepage-reliability-binding"),
    ]);
    invokeOperation = uol.invokeOperation;
    bindHomepageReliabilityOperation = binding.bindHomepageReliabilityOperation;
  }, 20_000);

  it("经真实网关实时读取并严格校验 SLA 统计", async () => {
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
    bindHomepageReliabilityOperation({ loadGenerationSlaStats });

    await expect(
      invokeOperation(
        "analytics.getHomepageGenerationSlaStats",
        {},
        { type: "system", reason: "homepage-generation-sla-stats" }
      )
    ).resolves.toEqual(stats);
    expect(loadGenerationSlaStats).toHaveBeenCalledTimes(1);
  });
});
