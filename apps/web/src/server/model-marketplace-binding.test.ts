/**
 * 模型配置与模型广场 UOL late binding 集成测试。
 *
 * 使用真实 registry 的 bindExecute 与 invokeOperation 验证权限、严格 DTO、领域错误映射
 * 和公开依赖 not_ready 边界；所有生产服务均通过内存函数注入，不连接数据库或存储。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ||=
    "postgres://test:test@127.0.0.1:5432/fluxmedia_test";
});

vi.mock("server-only", () => ({}));
vi.mock("@/features/model-configuration/service", () => ({
  productionModelConfigurationService: {
    read: vi.fn(),
    updateEntry: vi.fn(),
  },
}));
vi.mock("@/features/model-marketplace/service", () => ({
  productionModelMarketplaceService: {
    listPublicModels: vi.fn(),
  },
}));

import type {
  ModelConfigurationSnapshot,
  ModelMarketplacePublicItem,
} from "@repo/shared/model-marketplace";
import { invokeOperation, type Principal } from "@repo/shared/uol";
import "@repo/shared/uol/operations";
import { ModelConfigurationServiceError } from "@/features/model-configuration/service-core";
import {
  bindModelMarketplaceOperations,
  type ModelMarketplaceOperationBindingDependencies,
} from "./model-marketplace-binding";

const IMAGE_PRICING = {
  base1024Credits: 1.27,
  base1kCredits: 1.27,
  base2kCredits: 5.07,
  base4kCredits: 10,
};
const UPDATE_INPUT = {
  clientRequestId: "6b7d1204-3f43-4da7-b2b5-b7540927e462",
  category: "image",
  configKey: "gpt-image-2",
  expectedRevision: 0,
  visible: true,
  homepageVisible: true,
  homepagePriority: 5,
  description: "适合精细文字渲染",
  coverChange: { action: "keep" },
  pricing: IMAGE_PRICING,
};

const ADMIN = {
  type: "user",
  userId: "admin-1",
  role: "admin",
} satisfies Principal;
const SUPER_ADMIN = {
  type: "user",
  userId: "super-admin-1",
  role: "super_admin",
} satisfies Principal;
const USER = {
  type: "user",
  userId: "user-1",
  role: "user",
} satisfies Principal;
const SYSTEM = {
  type: "system",
  reason: "model-marketplace-page",
} satisfies Principal;

/**
 * 创建合法管理快照，运行时状态可按管理降级用例切换。
 *
 * @param runtimeCatalogStatus - 管理运行时目录读取状态。
 * @returns 不含任何存储内部引用的严格管理 DTO。
 */
function createManagementSnapshot(
  runtimeCatalogStatus: "ready" | "unavailable" = "ready"
): ModelConfigurationSnapshot {
  return {
    canEdit: false,
    runtimeCatalogStatus,
    entries: [
      {
        category: "image",
        configKey: "gpt-image-2",
        displayName: "GPT Image 2",
        iconKey: "openai",
        revision: 0,
        minimumCredits: 1.27,
        marketplaceApplicable: true,
        visible: true,
        homepageVisible: true,
        homepagePriority: 5,
        description: "适合精细文字渲染",
        coverUrl: "/model-marketplace/default-image.webp",
        usesDefaultCover: true,
        pricingSource: "explicit",
        pricing: IMAGE_PRICING,
      },
    ],
  };
}

/**
 * 创建合法公开图像卡片 DTO。
 *
 * @returns 只含第一方 URL、模型身份和公开价格的严格条目。
 */
function createPublicItem(): ModelMarketplacePublicItem {
  return {
    category: "image",
    configKey: "gpt-image-2",
    defaultModelId: "gpt-image-2",
    displayName: "GPT Image 2",
    iconKey: "openai",
    description: "适合精细文字渲染",
    coverUrl: "/model-marketplace/default-image.webp",
    minimumCredits: 1.27,
    homepageVisible: true,
    homepagePriority: 5,
    priceUnit: "per_image",
    pricing: IMAGE_PRICING,
  };
}

/**
 * 创建可被每个用例独立重置的绑定依赖 spy。
 *
 * @returns 三个生产服务入口及其 Vitest 调用记录。
 */
function createDependencies(): ModelMarketplaceOperationBindingDependencies {
  return {
    readModelConfiguration: vi.fn(async () => createManagementSnapshot()),
    updateModelConfigurationEntry: vi.fn(async () => ({
      category: "image" as const,
      configKey: "gpt-image-2",
      revision: 1,
    })),
    listPublicModels: vi.fn(async () => ({ items: [createPublicItem()] })),
  };
}

describe("模型配置与模型广场 UOL binding", () => {
  let dependencies: ModelMarketplaceOperationBindingDependencies;

  beforeEach(() => {
    dependencies = createDependencies();
    bindModelMarketplaceOperations(dependencies);
  });

  it("管理读取透传真实 Principal 并由网关输出严格 DTO", async () => {
    const output = await invokeOperation<ModelConfigurationSnapshot>(
      "settings.getModelConfiguration",
      {},
      ADMIN,
      { requestId: "binding-read" }
    );

    expect(output).toEqual(createManagementSnapshot());
    expect(dependencies.readModelConfiguration).toHaveBeenCalledWith(ADMIN);
    expect(JSON.stringify(output)).not.toMatch(/"bucket"|"key"/);
  });

  it("管理运行时目录不可用时仍返回降级快照", async () => {
    vi.mocked(dependencies.readModelConfiguration).mockResolvedValueOnce(
      createManagementSnapshot("unavailable")
    );

    await expect(
      invokeOperation("settings.getModelConfiguration", {}, SUPER_ADMIN, {
        requestId: "binding-read-runtime-unavailable",
      })
    ).resolves.toMatchObject({ runtimeCatalogStatus: "unavailable" });
  });

  it("网关拒绝管理服务返回的附加内部字段", async () => {
    vi.mocked(dependencies.readModelConfiguration).mockResolvedValueOnce({
      ...createManagementSnapshot(),
      storageBucket: "model-marketplace",
    } as never);

    await expect(
      invokeOperation("settings.getModelConfiguration", {}, ADMIN, {
        requestId: "binding-read-invalid-output",
      })
    ).rejects.toMatchObject({ code: "internal_error" });
  });

  it("写操作只把真实超级管理员用户 ID 交给保存服务", async () => {
    await expect(
      invokeOperation(
        "settings.updateModelConfigurationEntry",
        UPDATE_INPUT,
        SUPER_ADMIN,
        { requestId: "binding-write" }
      )
    ).resolves.toEqual({
      category: "image",
      configKey: "gpt-image-2",
      revision: 1,
    });
    expect(dependencies.updateModelConfigurationEntry).toHaveBeenCalledWith({
      actorUserId: SUPER_ADMIN.userId,
      input: expect.objectContaining({
        clientRequestId: UPDATE_INPUT.clientRequestId,
      }),
    });

    for (const principal of [USER, ADMIN, SYSTEM]) {
      await expect(
        invokeOperation(
          "settings.updateModelConfigurationEntry",
          UPDATE_INPUT,
          principal,
          { requestId: `binding-write-denied-${principal.type}` }
        )
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(dependencies.updateModelConfigurationEntry).toHaveBeenCalledOnce();
  });

  it.each([
    ["revision_conflict", "conflict"],
    ["idempotency_conflict", "idempotency_conflict"],
    ["not_configurable", "validation_error"],
    ["invalid_dependency_result", "internal_error"],
    ["revision_exhausted", "internal_error"],
  ] as const)("把保存领域错误 %s 映射为 %s", async (serviceCode, operationCode) => {
    vi.mocked(dependencies.updateModelConfigurationEntry).mockRejectedValueOnce(
      new ModelConfigurationServiceError(serviceCode, "稳定领域错误")
    );

    await expect(
      invokeOperation(
        "settings.updateModelConfigurationEntry",
        UPDATE_INPUT,
        SUPER_ADMIN,
        { requestId: `binding-error-${serviceCode}` }
      )
    ).rejects.toMatchObject({ code: operationCode });
  });

  it("公开目录只允许 system Principal 且不泄漏内部字段", async () => {
    const output = await invokeOperation<{
      items: ModelMarketplacePublicItem[];
    }>("modelMarketplace.listPublicModels", {}, SYSTEM, {
      requestId: "binding-public",
    });

    expect(output).toEqual({ items: [createPublicItem()] });
    expect(JSON.stringify(output)).not.toMatch(
      /"bucket"|"key"|"credential"|"health"|"member"/
    );
    await expect(
      invokeOperation("modelMarketplace.listPublicModels", {}, USER, {
        requestId: "binding-public-denied",
      })
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it.each([
    "runtime catalog unavailable: backend-secret",
    "pricing setting unavailable: database-secret",
    "marketplace config invalid: raw-json-secret",
    "asset bucket unavailable: storage-secret",
  ])("公开依赖失败稳定映射为不泄漏详情的 not_ready", async (message) => {
    vi.mocked(dependencies.listPublicModels).mockRejectedValueOnce(
      new Error(message)
    );

    try {
      await invokeOperation("modelMarketplace.listPublicModels", {}, SYSTEM, {
        requestId: "binding-public-not-ready",
      });
      throw new Error("公开依赖失败时不应返回成功");
    } catch (error) {
      expect(error).toMatchObject({ code: "not_ready", httpStatus: 503 });
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message).not.toContain(message);
      expect(error.message).toBe("模型广场暂不可用，请稍后重试");
    }
  });

  it("网关拒绝生产服务返回的非严格 DTO", async () => {
    vi.mocked(dependencies.listPublicModels).mockResolvedValueOnce({
      items: [
        {
          ...createPublicItem(),
          bucket: "model-marketplace",
        },
      ],
    } as never);

    await expect(
      invokeOperation("modelMarketplace.listPublicModels", {}, SYSTEM, {
        requestId: "binding-public-invalid-output",
      })
    ).rejects.toMatchObject({ code: "internal_error" });
  });
});
