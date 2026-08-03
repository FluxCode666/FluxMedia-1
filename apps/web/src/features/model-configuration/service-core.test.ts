/**
 * 模型配置保存内核的 DB-free 行为测试。
 *
 * 使用内存事务、存储与审计端口验证单条目合并、乐观锁、幂等回执及封面补偿清理，
 * 不连接 PostgreSQL，也不依赖具体 Drizzle 仓储实现。
 */

import {
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  getVideoPricingResolutionKey,
  getVideoPricingResolutions,
} from "@repo/shared/adobe";
import {
  createDefaultGlobalImageCreditOverrides,
  type GlobalImageCreditOverrides,
} from "@repo/shared/image-backend/group-image-pricing";
import {
  createDefaultModelMarketplaceConfig,
  type ModelConfigurationSnapshot,
  type ModelMarketplaceConfig,
  type ModelMarketplaceCoverRef,
} from "@repo/shared/model-marketplace";
import {
  createDefaultVideoModelCapabilityOverrides,
  type VideoModelCapabilityOverrides,
} from "@repo/shared/video-generation";
import { describe, expect, it, vi } from "vitest";
import {
  createModelConfigurationService,
  type ModelConfigurationServiceDependencies,
  ModelConfigurationServiceError,
  type ModelConfigurationTransaction,
} from "./service-core";

const IMAGE_PRICING = {
  base1024Credits: 2,
  base1kCredits: 3,
  base2kCredits: 4,
  base4kCredits: 5,
};
const ACTOR_USER_ID = "user-super-admin";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-26T08:00:00.000Z");
const ASSET_BUCKET = "model-marketplace";
const OLD_COVER_KEY = `image/${"d".repeat(64)}/${"e".repeat(64)}.webp`;
const SHARED_COVER_KEY = `image/${"f".repeat(64)}/${"1".repeat(64)}.webp`;

type AuditEvent = Parameters<
  ModelConfigurationServiceDependencies["audit"]["record"]
>[1];

interface MemoryState {
  config: ModelMarketplaceConfig;
  imagePricing: GlobalImageCreditOverrides;
  videoPricing: Record<string, number>;
  videoCapabilities: VideoModelCapabilityOverrides;
  auditEvents: AuditEvent[];
}

interface MemoryAuditContext {
  events: AuditEvent[];
}

/**
 * 创建覆盖保存测试所需模型身份的严格管理目录快照。
 *
 * @returns 可直接由 catalogLoader 返回的图像与视频条目集合。
 */
function createCatalogSnapshot(): ModelConfigurationSnapshot {
  const imageEntries = ["gpt-image-2", "custom-image", "other-image"].map(
    (configKey) => ({
      category: "image" as const,
      configKey,
      displayName: configKey,
      iconKey: "generic" as const,
      revision: 0,
      minimumCredits: 2,
      marketplaceApplicable: true as const,
      visible: true,
      homepageVisible: true,
      homepagePriority: 5,
      description: "",
      coverUrl: null,
      usesDefaultCover: true,
      pricingSource: "explicit" as const,
      pricing: { ...IMAGE_PRICING },
    })
  );
  const videoEntries = ["sora2", "veo31", "seedance2", "seedance2-fast"].map(
    (configKey) => {
      const supportedResolutions = getVideoPricingResolutions(configKey);
      return {
        category: "video" as const,
        configKey,
        displayName: configKey,
        iconKey: "generic" as const,
        revision: 0,
        minimumCredits: 30,
        marketplaceApplicable: true as const,
        visible: true,
        homepageVisible: false,
        homepagePriority: 5,
        description: "",
        coverUrl: null,
        usesDefaultCover: true,
        creditsPerSecond: 30,
        creditsPerSecondByResolution: Object.fromEntries(
          supportedResolutions.map((resolution) => [resolution, 30])
        ),
        supportedResolutions,
        ...(configKey.startsWith("seedance2")
          ? { maxReferenceImages: 10 }
          : {}),
      };
    }
  );
  return {
    canEdit: true,
    runtimeCatalogStatus: "ready",
    entries: [...imageEntries, ...videoEntries],
  };
}

/**
 * 创建可回滚且记录锁顺序的内存事务仓储。
 *
 * @param initial - 可选的初始配置、价格和审计状态。
 * @returns 仓储端口、只读快照、锁轨迹与一次性提交失败控制器。
 */
function createMemoryRepository(initial?: Partial<MemoryState>) {
  let state: MemoryState = {
    config: createDefaultModelMarketplaceConfig(),
    imagePricing: createDefaultGlobalImageCreditOverrides(),
    videoPricing: { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND },
    videoCapabilities: createDefaultVideoModelCapabilityOverrides(),
    auditEvents: [],
    ...structuredClone(initial ?? {}),
  };
  const lockOrder: string[] = [];
  let failNextCommit = false;
  let failNextCapabilitySave = false;

  return {
    lockOrder,
    failCommitOnce() {
      failNextCommit = true;
    },
    failCapabilitySaveOnce() {
      failNextCapabilitySave = true;
    },
    read() {
      return structuredClone(state);
    },
    repository: {
      async transaction<T>(
        work: (transaction: ModelConfigurationTransaction) => Promise<T>
      ): Promise<T> {
        const draft = structuredClone(state);
        const transaction: ModelConfigurationTransaction = {
          auditContext: {
            events: draft.auditEvents,
          } satisfies MemoryAuditContext,
          async lockMarketplaceConfig() {
            lockOrder.push("config");
            return structuredClone(draft.config);
          },
          async lockImagePricing() {
            lockOrder.push("image");
            return structuredClone(draft.imagePricing);
          },
          async lockVideoPricing() {
            lockOrder.push("video");
            return structuredClone(draft.videoPricing);
          },
          async lockVideoCapabilities() {
            lockOrder.push("capabilities");
            return structuredClone(draft.videoCapabilities);
          },
          async saveMarketplaceConfig(config) {
            draft.config = structuredClone(config);
          },
          async saveImagePricing(pricing) {
            draft.imagePricing = structuredClone(pricing);
          },
          async saveVideoPricing(pricing) {
            draft.videoPricing = structuredClone(pricing);
          },
          async saveVideoCapabilities(capabilities) {
            if (failNextCapabilitySave) {
              failNextCapabilitySave = false;
              throw new Error("capability save failed");
            }
            draft.videoCapabilities = structuredClone(capabilities);
          },
        };
        const result = await work(transaction);
        if (failNextCommit) {
          failNextCommit = false;
          throw new Error("commit failed");
        }
        state = draft;
        return result;
      },
    },
  };
}

/**
 * 创建覆盖存储成功、缺失与故障路径的内存对象存储。
 *
 * @returns 可观察对象 Map 与 Vitest spy 包装的存储端口。
 */
function createMemoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const putObject = vi.fn(
    async (reference: ModelMarketplaceCoverRef, bytes: Uint8Array) => {
      objects.set(`${reference.bucket}/${reference.key}`, bytes.slice());
    }
  );
  const getObject = vi.fn(async (reference: ModelMarketplaceCoverRef) => {
    const bytes = objects.get(`${reference.bucket}/${reference.key}`);
    return bytes
      ? ({ status: "found", bytes: bytes.slice() } as const)
      : ({ status: "not_found" } as const);
  });
  const deleteObject = vi.fn(async (reference: ModelMarketplaceCoverRef) => {
    objects.delete(`${reference.bucket}/${reference.key}`);
  });
  return { objects, storage: { putObject, getObject, deleteObject } };
}

/**
 * 创建保存服务及可断言的端口桩。
 *
 * @param initial - 可选的内存仓储初始状态。
 * @returns 保存服务及存储、缓存、审计、日志、处理器和哈希 spy。
 */
function createHarness(initial?: Partial<MemoryState>) {
  const memoryRepository = createMemoryRepository(initial);
  const memoryStorage = createMemoryStorage();
  const invalidate = vi.fn(async () => undefined);
  const warn = vi.fn();
  const process = vi.fn(async (bytes: Uint8Array) => ({
    bytes: new Uint8Array([9, ...bytes]),
    sha256: "a".repeat(64),
    contentType: "image/webp" as const,
  }));
  const record = vi.fn(
    async (context: unknown, event: AuditEvent): Promise<void> => {
      const auditContext = context as MemoryAuditContext;
      auditContext.events.push(structuredClone(event));
    }
  );
  const hash = vi.fn(async (value: string | Uint8Array) => {
    const text = typeof value === "string" ? value : [...value].join(",");
    let accumulator = 0;
    for (const character of text) {
      accumulator = (accumulator * 31 + character.charCodeAt(0)) >>> 0;
    }
    return accumulator.toString(16).padStart(64, "0");
  });
  const dependencies: ModelConfigurationServiceDependencies = {
    repository: memoryRepository.repository,
    storage: memoryStorage.storage,
    catalogLoader: {
      async load() {
        return createCatalogSnapshot();
      },
    },
    coverImageProcessor: { process },
    cache: { invalidate },
    audit: { record },
    logger: { warn },
    clock: { now: () => new Date(NOW) },
    hash: { sha256: hash },
    ids: { create: () => "audit-id" },
    assetBucket: ASSET_BUCKET,
  };
  return {
    service: createModelConfigurationService(dependencies),
    repository: memoryRepository,
    memoryStorage,
    invalidate,
    warn,
    process,
    record,
    hash,
  };
}

/**
 * 创建图像条目更新输入，允许测试按场景覆盖字段。
 *
 * @param overrides - 当前测试需要覆盖的图像输入字段。
 * @returns 满足共享显式图像分支的保存输入。
 */
function imageInput(
  overrides: Partial<{
    clientRequestId: string;
    configKey: string;
    expectedRevision: number;
    isCustom: boolean;
    supportedResolutions: string[];
    visible: boolean;
    description: string;
    coverChange:
      | { action: "keep" }
      | { action: "remove" }
      | { action: "replace"; bytes: Uint8Array };
    pricing: typeof IMAGE_PRICING;
  }> = {}
) {
  return {
    clientRequestId: REQUEST_ID,
    category: "image" as const,
    configKey: "gpt-image-2",
    expectedRevision: 0,
    visible: true,
    homepageVisible: true,
    homepagePriority: 5,
    description: "新的图像模型",
    coverChange: { action: "keep" as const },
    pricing: IMAGE_PRICING,
    ...overrides,
  };
}

describe("模型配置保存内核", () => {
  it("只更新目标图像条目并按展示行、价格行的固定顺序加锁", async () => {
    const existing = createDefaultModelMarketplaceConfig();
    existing.imageByModel["other-image"] = {
      revision: 4,
      visible: false,
      description: "保留",
      cover: null,
    };
    const harness = createHarness({ config: existing });

    const result = await harness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input: imageInput(),
    });

    expect(result).toEqual({
      category: "image",
      configKey: "gpt-image-2",
      revision: 1,
    });
    const state = harness.repository.read();
    expect(state.config.imageByModel["gpt-image-2"]).toMatchObject({
      revision: 1,
      visible: true,
      homepageVisible: true,
      homepagePriority: 5,
      description: "新的图像模型",
    });
    expect(state.config.imageByModel["other-image"]).toMatchObject({
      revision: 4,
      description: "保留",
    });
    expect(state.imagePricing.byModel["gpt-image-2"]).toEqual(IMAGE_PRICING);
    expect(harness.repository.lockOrder.slice(0, 2)).toEqual([
      "config",
      "image",
    ]);
    expect(state.auditEvents).toHaveLength(1);
    expect(harness.invalidate).toHaveBeenCalledOnce();
  });

  it("按分辨率更新目标视频族，并用最高单价维护旧版兜底键", async () => {
    const harness = createHarness();

    await harness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input: {
        clientRequestId: REQUEST_ID,
        category: "video",
        configKey: "veo31",
        expectedRevision: 0,
        visible: false,
        homepageVisible: false,
        homepagePriority: 5,
        description: "视频模型",
        coverChange: { action: "keep" },
        creditsPerSecondByResolution: { "1080p": 88, "720p": 36 },
      },
    });
    const state = harness.repository.read();
    expect(state.videoPricing.veo31).toBe(88);
    expect(
      state.videoPricing[getVideoPricingResolutionKey("veo31", "720p")]
    ).toBe(36);
    expect(
      state.videoPricing[getVideoPricingResolutionKey("veo31", "1080p")]
    ).toBe(88);
    expect(state.videoPricing.sora2).toBe(
      DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND.sora2
    );
    expect(state.config.videoByFamily.veo31).toMatchObject({
      revision: 1,
      visible: false,
      homepageVisible: false,
      homepagePriority: 5,
    });
    expect(state.imagePricing.byModel).not.toHaveProperty("default");
    expect(state.config.imageByModel).not.toHaveProperty("default");
  });

  it.each([
    "seedance2",
    "seedance2-fast",
  ] as const)("原子保存 %s 的价格、展示 revision 与独立参考图上限", async (configKey) => {
    const harness = createHarness();
    const supportedResolutions = getVideoPricingResolutions(configKey);
    const creditsPerSecondByResolution = Object.fromEntries(
      supportedResolutions.map((resolution) => [resolution, 42])
    );

    await harness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input: {
        clientRequestId: REQUEST_ID,
        category: "video",
        configKey,
        expectedRevision: 0,
        visible: true,
        homepageVisible: false,
        homepagePriority: 5,
        description: "Seedance 视频模型",
        coverChange: { action: "keep" },
        creditsPerSecondByResolution,
        maxReferenceImages: 20,
      },
    });

    const state = harness.repository.read();
    expect(state.config.videoByFamily[configKey]).toMatchObject({
      revision: 1,
    });
    expect(state.videoCapabilities.byModel[configKey]).toEqual({
      maxReferenceImages: 20,
    });
    expect(state.videoPricing[configKey]).toBe(42);
    expect(state.auditEvents).toHaveLength(1);
    expect(harness.repository.lockOrder.slice(0, 3)).toEqual([
      "config",
      "video",
      "capabilities",
    ]);
  });

  it("拒绝 Seedance 缺少上限或非 Seedance 提交上限", async () => {
    const harness = createHarness();
    const common = {
      clientRequestId: REQUEST_ID,
      category: "video" as const,
      expectedRevision: 0,
      visible: true,
      homepageVisible: false,
      homepagePriority: 5,
      description: "视频模型",
      coverChange: { action: "keep" as const },
    };

    await expect(
      harness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: {
          ...common,
          configKey: "seedance2",
          creditsPerSecondByResolution: Object.fromEntries(
            getVideoPricingResolutions("seedance2").map((resolution) => [
              resolution,
              42,
            ])
          ),
        },
      })
    ).rejects.toMatchObject({ code: "not_configurable" });
    await expect(
      harness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: {
          ...common,
          configKey: "veo31",
          creditsPerSecondByResolution: { "720p": 36, "1080p": 88 },
          maxReferenceImages: 20,
        },
      })
    ).rejects.toMatchObject({ code: "not_configurable" });
    expect(harness.repository.read().auditEvents).toHaveLength(0);
  });

  it("能力覆盖保存失败时价格、展示和审计全部回滚", async () => {
    const harness = createHarness();
    harness.repository.failCapabilitySaveOnce();

    await expect(
      harness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: {
          clientRequestId: REQUEST_ID,
          category: "video",
          configKey: "seedance2",
          expectedRevision: 0,
          visible: true,
          homepageVisible: false,
          homepagePriority: 5,
          description: "Seedance 视频模型",
          coverChange: { action: "keep" },
          creditsPerSecondByResolution: {
            "480p": 42,
            "720p": 42,
            "1080p": 42,
          },
          maxReferenceImages: 20,
        },
      })
    ).rejects.toThrow("capability save failed");

    const state = harness.repository.read();
    expect(state.config.videoByFamily.seedance2).toBeUndefined();
    expect(state.videoCapabilities.byModel.seedance2).toBeUndefined();
    expect(state.auditEvents).toHaveLength(0);
  });

  it("拒绝缺少或增加目录分辨率档位的视频价格", async () => {
    const harness = createHarness();
    const commonInput = {
      clientRequestId: REQUEST_ID,
      category: "video" as const,
      configKey: "veo31",
      expectedRevision: 0,
      visible: true,
      homepageVisible: false,
      homepagePriority: 5,
      description: "视频模型",
      coverChange: { action: "keep" as const },
    };

    for (const creditsPerSecondByResolution of [
      { "720p": 36 },
      { "720p": 36, "1080p": 88, "4k": 120 },
    ]) {
      await expect(
        harness.service.updateEntry({
          actorUserId: ACTOR_USER_ID,
          input: { ...commonInput, creditsPerSecondByResolution },
        })
      ).rejects.toMatchObject({
        code: "not_configurable",
        message: "视频分辨率价格与当前模型目录不一致",
      });
    }
    expect(harness.repository.read().auditEvents).toHaveLength(0);
  });

  it("拒绝条目 revision 冲突", async () => {
    const config = createDefaultModelMarketplaceConfig();
    config.imageByModel["custom-image"] = {
      revision: 3,
      visible: true,
      description: "current",
      cover: null,
    };
    const harness = createHarness({ config });

    await expect(
      harness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: imageInput({
          configKey: "custom-image",
          expectedRevision: 2,
        }),
      })
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(harness.repository.read().auditEvents).toHaveLength(0);
  });

  it("未配置价格的额外图像模型首次保存时写入显式价格", async () => {
    const harness = createHarness();

    const result = await harness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input: imageInput({ configKey: "custom-image" }),
    });

    expect(result).toMatchObject({ configKey: "custom-image", revision: 1 });
    expect(
      harness.repository.read().imagePricing.byModel["custom-image"]
    ).toEqual(IMAGE_PRICING);
    expect(
      harness.repository.read().config.imageByModel["custom-image"]
    ).toMatchObject({ revision: 1 });
  });

  it("原子创建自定义图像模型定义、价格与展示条目", async () => {
    const harness = createHarness();

    const result = await harness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input: imageInput({
        configKey: "vendor-image-x",
        isCustom: true,
        supportedResolutions: ["1k", "2k", "4k"],
      }),
    });

    const state = harness.repository.read();
    expect(result).toEqual({
      category: "image",
      configKey: "vendor-image-x",
      revision: 1,
    });
    expect(state.config.customModels).toContainEqual({
      modelId: "vendor-image-x",
      category: "image",
      supportedResolutions: ["1k", "2k", "4k"],
    });
    expect(state.imagePricing.byModel["vendor-image-x"]).toEqual(IMAGE_PRICING);
    expect(state.config.imageByModel["vendor-image-x"]).toMatchObject({
      revision: 1,
      visible: true,
    });
  });

  it("原子创建自定义视频模型并以声明分辨率写入价格矩阵", async () => {
    const harness = createHarness();

    await harness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input: {
        clientRequestId: REQUEST_ID,
        category: "video",
        configKey: "vendor-video-x",
        expectedRevision: 0,
        isCustom: true,
        visible: false,
        homepageVisible: false,
        homepagePriority: 5,
        description: "",
        coverChange: { action: "keep" },
        creditsPerSecondByResolution: { "720p": 30, "1080p": 45 },
      },
    });

    const state = harness.repository.read();
    expect(state.config.customModels).toContainEqual({
      modelId: "vendor-video-x",
      category: "video",
      supportedResolutions: ["720p", "1080p"],
    });
    expect(state.videoPricing).toMatchObject({
      "vendor-video-x": 45,
      "vendor-video-x@720p": 30,
      "vendor-video-x@1080p": 45,
    });
  });

  it("同请求同载荷只重放结果，不重复存储、审计或缓存副作用", async () => {
    const harness = createHarness();
    const input = imageInput({
      coverChange: {
        action: "replace",
        bytes: new Uint8Array([1, 2, 3]),
      },
    });

    const first = await harness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input,
    });
    const replay = await harness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input,
    });

    expect(replay).toEqual(first);
    expect(harness.memoryStorage.storage.putObject).toHaveBeenCalledOnce();
    expect(harness.repository.read().auditEvents).toHaveLength(1);
    expect(harness.invalidate).toHaveBeenCalledOnce();
  });

  it("同请求键复用不同载荷返回幂等冲突", async () => {
    const harness = createHarness();
    await harness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input: imageInput(),
    });

    await expect(
      harness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: imageInput({ description: "另一份载荷" }),
      })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("keep、remove 与 replace 分别保留、清空和替换封面引用", async () => {
    const oldCover = { bucket: ASSET_BUCKET, key: OLD_COVER_KEY };
    const config = createDefaultModelMarketplaceConfig();
    config.imageByModel["gpt-image-2"] = {
      revision: 1,
      visible: true,
      description: "old",
      cover: oldCover,
    };
    const keepHarness = createHarness({ config });
    await keepHarness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input: imageInput({ expectedRevision: 1 }),
    });
    expect(
      keepHarness.repository.read().config.imageByModel["gpt-image-2"]?.cover
    ).toEqual(oldCover);
    expect(
      keepHarness.memoryStorage.storage.deleteObject
    ).not.toHaveBeenCalled();

    const removeHarness = createHarness({ config });
    removeHarness.memoryStorage.objects.set(
      `${oldCover.bucket}/${oldCover.key}`,
      new Uint8Array([1])
    );
    await removeHarness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input: imageInput({
        expectedRevision: 1,
        coverChange: { action: "remove" },
      }),
    });
    expect(
      removeHarness.repository.read().config.imageByModel["gpt-image-2"]?.cover
    ).toBeNull();
    expect(removeHarness.memoryStorage.storage.getObject).toHaveBeenCalledWith(
      oldCover
    );
    expect(
      removeHarness.memoryStorage.storage.deleteObject
    ).toHaveBeenCalledWith(oldCover);

    const replaceHarness = createHarness({ config });
    await replaceHarness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input: imageInput({
        expectedRevision: 1,
        coverChange: { action: "replace", bytes: new Uint8Array([7]) },
      }),
    });
    const replacement =
      replaceHarness.repository.read().config.imageByModel["gpt-image-2"]
        ?.cover;
    expect(replacement).toMatchObject({ bucket: ASSET_BUCKET });
    expect(replacement?.key).toMatch(
      /^image\/[a-f0-9]{64}\/[a-f0-9]{64}\.webp$/
    );
  });

  it("remove 的存储预检失败时回滚并保留旧引用", async () => {
    const oldCover = { bucket: ASSET_BUCKET, key: OLD_COVER_KEY };
    const config = createDefaultModelMarketplaceConfig();
    config.imageByModel["gpt-image-2"] = {
      revision: 0,
      visible: true,
      description: "old",
      cover: oldCover,
    };
    const harness = createHarness({ config });
    harness.memoryStorage.storage.getObject.mockRejectedValueOnce(
      new Error("storage down")
    );

    await expect(
      harness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: imageInput({ coverChange: { action: "remove" } }),
      })
    ).rejects.toBeInstanceOf(Error);
    expect(
      harness.repository.read().config.imageByModel["gpt-image-2"]?.cover
    ).toEqual(oldCover);
    expect(harness.repository.read().auditEvents).toHaveLength(0);
  });

  it("持久化封面引用跨越模型资产桶时 fail-closed 且不触达存储", async () => {
    const foreignCover = {
      bucket: "generations",
      key: OLD_COVER_KEY,
    };
    const config = createDefaultModelMarketplaceConfig();
    config.imageByModel["gpt-image-2"] = {
      revision: 0,
      visible: true,
      description: "dirty",
      cover: foreignCover,
    };
    const harness = createHarness({ config });

    await expect(
      harness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: imageInput({ coverChange: { action: "remove" } }),
      })
    ).rejects.toMatchObject({ code: "invalid_dependency_result" });

    expect(harness.memoryStorage.storage.getObject).not.toHaveBeenCalled();
    expect(harness.memoryStorage.storage.putObject).not.toHaveBeenCalled();
    expect(harness.memoryStorage.storage.deleteObject).not.toHaveBeenCalled();
    expect(
      harness.repository.read().config.imageByModel["gpt-image-2"]?.cover
    ).toEqual(foreignCover);
  });

  it("事务失败后在短事务中复核并清理新对象", async () => {
    const harness = createHarness();
    harness.repository.failCommitOnce();

    await expect(
      harness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: imageInput({
          coverChange: {
            action: "replace",
            bytes: new Uint8Array([1, 2, 3]),
          },
        }),
      })
    ).rejects.toThrow("commit failed");
    expect(harness.memoryStorage.storage.putObject).toHaveBeenCalledOnce();
    expect(harness.memoryStorage.storage.deleteObject).toHaveBeenCalledOnce();
    expect(harness.repository.read().config.imageByModel).toEqual({});
    expect(harness.repository.read().auditEvents).toHaveLength(0);
  });

  it("新封面 put 失败时不修改配置、审计或执行无依据删除", async () => {
    const harness = createHarness();
    harness.memoryStorage.storage.putObject.mockRejectedValueOnce(
      new Error("put failed")
    );

    await expect(
      harness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: imageInput({
          coverChange: {
            action: "replace",
            bytes: new Uint8Array([1, 2, 3]),
          },
        }),
      })
    ).rejects.toThrow("put failed");
    expect(harness.repository.read().config.imageByModel).toEqual({});
    expect(harness.repository.read().auditEvents).toHaveLength(0);
    expect(harness.memoryStorage.storage.deleteObject).not.toHaveBeenCalled();
  });

  it("事务失败后的新对象清理失败只告警并保留原事务失败", async () => {
    const harness = createHarness();
    harness.repository.failCommitOnce();
    harness.memoryStorage.storage.deleteObject.mockRejectedValueOnce(
      new Error("cleanup failed")
    );

    await expect(
      harness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: imageInput({
          coverChange: {
            action: "replace",
            bytes: new Uint8Array([1, 2, 3]),
          },
        }),
      })
    ).rejects.toThrow("commit failed");
    expect(harness.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "model_configuration_cover_cleanup_failed",
        cleanupReason: "transaction_failed",
      })
    );
    expect(JSON.stringify(harness.warn.mock.calls)).not.toContain(
      "cleanup failed"
    );
  });

  it("清理前复核全局引用，不删除被其他模型共享的旧封面", async () => {
    const sharedCover = {
      bucket: ASSET_BUCKET,
      key: SHARED_COVER_KEY,
    };
    const config = createDefaultModelMarketplaceConfig();
    config.imageByModel["gpt-image-2"] = {
      revision: 0,
      visible: true,
      description: "one",
      cover: sharedCover,
    };
    config.imageByModel["other-image"] = {
      revision: 0,
      visible: true,
      description: "two",
      cover: sharedCover,
    };
    const harness = createHarness({ config });
    harness.memoryStorage.objects.set(
      `${sharedCover.bucket}/${sharedCover.key}`,
      new Uint8Array([1])
    );

    await harness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input: imageInput({ coverChange: { action: "remove" } }),
    });

    expect(harness.memoryStorage.storage.deleteObject).not.toHaveBeenCalled();
    expect(
      harness.memoryStorage.objects.has(
        `${sharedCover.bucket}/${sharedCover.key}`
      )
    ).toBe(true);
  });

  it("缓存与旧对象清理失败只记录结构化告警，不回滚已提交配置", async () => {
    const oldCover = { bucket: ASSET_BUCKET, key: OLD_COVER_KEY };
    const config = createDefaultModelMarketplaceConfig();
    config.imageByModel["gpt-image-2"] = {
      revision: 0,
      visible: true,
      description: "old",
      cover: oldCover,
    };
    const harness = createHarness({ config });
    harness.memoryStorage.objects.set(
      `${oldCover.bucket}/${oldCover.key}`,
      new Uint8Array([1])
    );
    harness.invalidate.mockRejectedValueOnce(new Error("cache down"));
    harness.memoryStorage.storage.deleteObject.mockRejectedValueOnce(
      new Error("delete down")
    );

    await expect(
      harness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: imageInput({ coverChange: { action: "remove" } }),
      })
    ).resolves.toMatchObject({ revision: 1 });
    expect(
      harness.repository.read().config.imageByModel["gpt-image-2"]?.cover
    ).toBeNull();
    expect(harness.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "model_configuration_cache_invalidation_failed",
      })
    );
    expect(harness.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "model_configuration_cover_cleanup_failed",
      })
    );
    expect(JSON.stringify(harness.warn.mock.calls)).not.toContain("cache down");
    expect(JSON.stringify(harness.warn.mock.calls)).not.toContain(
      "delete down"
    );
  });

  it("每次成功保存裁剪过期和超量回执，过期重试仍由 revision 阻止", async () => {
    const config = createDefaultModelMarketplaceConfig();
    for (let index = 0; index < 256; index += 1) {
      config.writeReceipts[index.toString(16).padStart(64, "0")] = {
        requestHash: "f".repeat(64),
        category: "image",
        configKey: "other-image",
        resultingRevision: index,
        completedAt:
          index === 0
            ? "2026-07-25T07:59:59.000Z"
            : new Date(NOW.getTime() - index * 1_000).toISOString(),
      };
    }
    const harness = createHarness({ config });
    await harness.service.updateEntry({
      actorUserId: ACTOR_USER_ID,
      input: imageInput(),
    });

    const receipts = harness.repository.read().config.writeReceipts;
    expect(Object.keys(receipts)).toHaveLength(256);
    expect(receipts["0".repeat(64)]).toBeUndefined();

    const expiredConfig = harness.repository.read().config;
    expiredConfig.writeReceipts = {};
    const retryHarness = createHarness({ config: expiredConfig });
    await expect(
      retryHarness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: imageInput(),
      })
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("完整财务 schema 脏值与未知目录模型都在任何存储写入前失败", async () => {
    const invalidImagePricing = createDefaultGlobalImageCreditOverrides();
    delete invalidImagePricing.byModel["gpt-image-2"];
    const invalidHarness = createHarness({ imagePricing: invalidImagePricing });

    await expect(
      invalidHarness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: imageInput({
          coverChange: { action: "replace", bytes: new Uint8Array([1]) },
        }),
      })
    ).rejects.toBeInstanceOf(Error);
    expect(
      invalidHarness.memoryStorage.storage.putObject
    ).not.toHaveBeenCalled();

    const unknownHarness = createHarness();
    await expect(
      unknownHarness.service.updateEntry({
        actorUserId: ACTOR_USER_ID,
        input: imageInput({ configKey: "unknown-image" }),
      })
    ).rejects.toBeInstanceOf(ModelConfigurationServiceError);
    expect(unknownHarness.process).not.toHaveBeenCalled();
  });
});
