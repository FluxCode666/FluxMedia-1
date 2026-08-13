/**
 * 首页服务端数据装配测试。
 *
 * 使用方：Vitest；验证首阶段并行、登录后二阶段角色读取、区块独立降级、公开 DTO
 * 收窄与安全日志，避免首页把异常或内部会话带入客户端边界。
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  ensureUolInitialized: vi.fn(),
  getServerSession: vi.fn(),
  getUserRoleById: vi.fn(),
  invokeOperation: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@repo/shared/auth/role-server", () => ({
  getUserRoleById: runtimeMocks.getUserRoleById,
}));
vi.mock("@repo/shared/auth/server", () => ({
  getServerSession: runtimeMocks.getServerSession,
}));
vi.mock("@repo/shared/logger", () => ({
  logger: { error: runtimeMocks.loggerError },
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: runtimeMocks.invokeOperation,
  OperationError: class OperationError extends Error {
    code: string;

    /** 构造测试所需的最小 UOL 错误。 */
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: runtimeMocks.ensureUolInitialized,
}));
vi.mock("@/i18n/routing", () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement("a", { href }, children),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("./homepage-sla-toggle", () => ({
  HomepageSlaToggle: () => null,
}));
vi.mock("next-intl/server", async () => {
  const [{ default: zh }, { default: en }] = await Promise.all([
    import("../../../../messages/zh.json"),
    import("../../../../messages/en.json"),
  ]);

  /** 从测试消息对象中读取点分路径。 */
  function readPath(root: unknown, path: string): unknown {
    let current = root;
    for (const segment of path.split(".")) {
      if (
        typeof current !== "object" ||
        current === null ||
        Array.isArray(current) ||
        !(segment in current)
      ) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  return {
    getTranslations: async ({
      locale,
      namespace,
    }: {
      locale: string;
      namespace: string;
    }) => {
      const messages = locale === "zh" ? zh : en;
      const root = readPath(messages, namespace);
      const translate = ((key: string) => {
        const value = readPath(root, key);
        if (typeof value !== "string") {
          throw new Error(`Missing test translation: ${namespace}.${key}`);
        }
        return value;
      }) as ((key: string) => string) & { raw: (key: string) => unknown };
      translate.raw = (key: string) => readPath(root, key);
      return translate;
    },
  };
});

import { HomepageContent } from "./homepage-content";
import {
  type HomepagePageData,
  type HomepagePageDataLoaders,
  loadHomepagePageData,
} from "./homepage-page-data";

const PUBLIC_IMAGE_MODEL = {
  category: "image" as const,
  configKey: "gpt-image-2",
  modelId: "gpt-image-2",
  displayName: "GPT Image 2",
  iconKey: "openai" as const,
  description: "Image generation",
  coverUrl: "/model-marketplace/default-image.webp",
  minimumCredits: 1.27,
  homepageVisible: true,
  homepagePriority: 5,
  priceUnit: "per_image" as const,
  pricing: {
    base1024Credits: 1.27,
    base1kCredits: 1.5,
    base2kCredits: 2.5,
    base4kCredits: 5,
  },
};

const PUBLIC_VIDEO_MODEL = {
  category: "video" as const,
  configKey: "veo31",
  modelId: "veo31",
  displayName: "Veo 3.1",
  iconKey: "google" as const,
  description: "Video generation",
  coverUrl: "/model-marketplace/default-video.webp",
  minimumCredits: 3,
  homepageVisible: true,
  homepagePriority: 2,
  priceUnit: "per_second" as const,
  creditsPerSecond: 3,
  creditsPerSecondByResolution: {
    "720p": 3,
    "1080p": 5,
  },
  supportedDurations: [4, 6, 8],
  supportedAspectRatios: ["16:9", "9:16"],
  supportedResolutions: ["720p", "1080p"],
  input: {
    frames: "first-and-optional-last" as const,
    referenceImages: { maxCount: 0, configurable: false },
    framesAndReferencesMutuallyExclusive: true,
  },
  audio: { supported: false, defaultEnabled: false },
  configuredReachable: true,
  infrastructureLimits: {
    maxMediaInputCount: 256 as const,
    maxMediaInputBytes: 209_715_200 as const,
  },
};

const READY_CATALOG = {
  items: [PUBLIC_IMAGE_MODEL, PUBLIC_VIDEO_MODEL],
};

const READY_SLA_STATS = {
  sampleSize: 100,
  completed: 96,
  failed: 4,
  successRate: 0.96,
  platformErrors: 4,
  moderationErrors: 0,
  userRequestErrors: 0,
};

/** 创建覆盖首页四个首阶段依赖和角色二阶段依赖的默认 loader。 */
function createLoaders(
  overrides: Partial<HomepagePageDataLoaders> = {}
): HomepagePageDataLoaders {
  return {
    createRequestId: () => "homepage-request-1",
    loadCatalog: vi.fn().mockResolvedValue(READY_CATALOG),
    loadSlaVisibility: vi.fn().mockResolvedValue(true),
    loadSlaStats: vi.fn().mockResolvedValue(READY_SLA_STATS),
    loadSession: vi.fn().mockResolvedValue(null),
    loadRole: vi.fn().mockResolvedValue("user"),
    reportFailure: vi.fn(),
    ...overrides,
  };
}

/** 创建由测试显式释放的 Promise，用于证明加载顺序而不依赖计时器。 */
function createDeferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("loadHomepagePageData", () => {
  it("三个生产 loader 初始化 UOL 后以独立 system reason 并行调用 operation", async () => {
    for (const mock of Object.values(runtimeMocks)) mock.mockReset();
    runtimeMocks.ensureUolInitialized.mockResolvedValue(undefined);
    runtimeMocks.invokeOperation.mockImplementation(
      async (operationName: string) => {
        if (operationName === "modelMarketplace.listPublicModels") {
          return READY_CATALOG;
        }
        if (operationName === "settings.getHomepageSlaVisibility") {
          return { enabled: true };
        }
        if (operationName === "analytics.getHomepageGenerationSlaStats") {
          return READY_SLA_STATS;
        }
        throw new Error("unexpected operation");
      }
    );
    runtimeMocks.getServerSession.mockResolvedValue(null);

    const result = await loadHomepagePageData();

    expect(runtimeMocks.ensureUolInitialized).toHaveBeenCalledTimes(3);
    expect(runtimeMocks.invokeOperation).toHaveBeenCalledWith(
      "modelMarketplace.listPublicModels",
      {},
      { type: "system", reason: "homepage-model-marketplace" },
      { requestId: expect.any(String) }
    );
    expect(runtimeMocks.invokeOperation).toHaveBeenCalledWith(
      "settings.getHomepageSlaVisibility",
      {},
      { type: "system", reason: "homepage-sla-visibility" },
      { requestId: expect.any(String) }
    );
    expect(runtimeMocks.invokeOperation).toHaveBeenCalledWith(
      "analytics.getHomepageGenerationSlaStats",
      {},
      { type: "system", reason: "homepage-generation-sla-stats" },
      { requestId: expect.any(String) }
    );
    expect(runtimeMocks.invokeOperation).toHaveBeenCalledTimes(3);
    expect(
      runtimeMocks.ensureUolInitialized.mock.invocationCallOrder[0] ?? 0
    ).toBeLessThan(
      runtimeMocks.invokeOperation.mock.invocationCallOrder[0] ?? 0
    );
    expect(runtimeMocks.getUserRoleById).not.toHaveBeenCalled();
    expect(result.catalog).toEqual({
      status: "ready",
      image: [{ id: PUBLIC_IMAGE_MODEL.modelId }],
      homepage: [
        {
          id: PUBLIC_IMAGE_MODEL.modelId,
          category: "image",
          priority: 5,
        },
        {
          id: PUBLIC_VIDEO_MODEL.modelId,
          category: "video",
          priority: 2,
        },
      ],
    });
    expect(result.reliability).toEqual({
      visibility: "enabled",
      stats: { status: "ready", data: READY_SLA_STATS },
    });
  });

  it("生产日志调用也只接收稳定事件字段而不接收原始 Error", async () => {
    for (const mock of Object.values(runtimeMocks)) mock.mockReset();
    const canary = new Error(
      "https://user:password@example.test Bearer token-canary SELECT secret api_key=key-canary"
    );
    canary.stack = "stack-canary";
    runtimeMocks.ensureUolInitialized.mockResolvedValue(undefined);
    runtimeMocks.invokeOperation.mockRejectedValue(canary);
    runtimeMocks.getServerSession.mockRejectedValue(canary);

    await expect(loadHomepagePageData()).resolves.toMatchObject({
      catalog: { status: "unavailable" },
      ctaHref: "/sign-up",
    });

    const logged = JSON.stringify(runtimeMocks.loggerError.mock.calls);
    expect(logged).not.toMatch(
      /password@example|Bearer|token-canary|SELECT|api_key|key-canary|stack-canary/
    );
    expect(runtimeMocks.loggerError).toHaveBeenCalledTimes(4);
    for (const [event, message] of runtimeMocks.loggerError.mock.calls) {
      expect(Object.keys(event).sort()).toEqual([
        "event",
        "requestId",
        "retryable",
        "safeCode",
        "section",
      ]);
      expect(message).toBe("Homepage dependency unavailable");
    }
  });

  it("首阶段并行启动四个依赖，取得 userId 后才进入角色二阶段", async () => {
    const catalog = createDeferred<unknown>();
    const visibility = createDeferred<unknown>();
    const stats = createDeferred<unknown>();
    const session = createDeferred<unknown>();
    const loadRole = vi.fn().mockResolvedValue("admin");
    const loaders = createLoaders({
      loadCatalog: vi.fn(() => catalog.promise),
      loadSlaVisibility: vi.fn(() => visibility.promise),
      loadSlaStats: vi.fn(() => stats.promise),
      loadSession: vi.fn(() => session.promise),
      loadRole,
    });

    const resultPromise = loadHomepagePageData(loaders);

    expect(loaders.loadCatalog).toHaveBeenCalledWith("homepage-request-1");
    expect(loaders.loadSlaVisibility).toHaveBeenCalledWith(
      "homepage-request-1"
    );
    expect(loaders.loadSlaStats).toHaveBeenCalledWith("homepage-request-1");
    expect(loaders.loadSession).toHaveBeenCalledOnce();
    expect(loadRole).not.toHaveBeenCalled();

    session.resolve({ user: { id: "user-1" } });
    catalog.resolve(READY_CATALOG);
    visibility.resolve(true);
    stats.resolve(READY_SLA_STATS);

    const result = await resultPromise;
    expect(loadRole).toHaveBeenCalledWith("user-1");
    expect(result.ctaHref).toBe("/dashboard/generate");
    expect(result.canToggleSlaStatus).toBe(true);
  });

  it.each([
    ["catalog", "model_catalog"],
    ["stats", "sla_stats"],
    ["both", "model_catalog,sla_stats"],
  ] as const)("隔离 %s 读取失败且不伪造其他区块状态", async (failureKind, expectedSections) => {
    const reportFailure = vi.fn();
    const loaders = createLoaders({ reportFailure });
    if (failureKind === "catalog" || failureKind === "both") {
      vi.mocked(loaders.loadCatalog).mockRejectedValue(
        new Error("catalog unavailable")
      );
    }
    if (failureKind === "stats" || failureKind === "both") {
      vi.mocked(loaders.loadSlaStats).mockRejectedValue(
        new Error("sla unavailable")
      );
    }

    const result = await loadHomepagePageData(loaders);

    expect(result.catalog.status).toBe(
      failureKind === "stats" ? "ready" : "unavailable"
    );
    expect(result.reliability.visibility).toBe("enabled");
    expect(result.reliability.stats.status).toBe(
      failureKind === "catalog" ? "ready" : "unavailable"
    );
    expect(
      reportFailure.mock.calls
        .map(([event]) => event.section)
        .sort()
        .join(",")
    ).toBe(expectedSections);
  });

  it("区分成功空目录、读取失败和每类真实空状态", async () => {
    const empty = await loadHomepagePageData(
      createLoaders({
        loadCatalog: vi.fn().mockResolvedValue({
          items: [],
        }),
      })
    );
    const failed = await loadHomepagePageData(
      createLoaders({
        loadCatalog: vi.fn().mockRejectedValue(new Error("unavailable")),
      })
    );

    expect(empty.catalog).toEqual({
      status: "ready",
      image: [],
      homepage: [],
    });
    expect(failed.catalog).toEqual({ status: "unavailable" });
  });

  it("首页开关只筛选视觉候选，不移除快速集成使用的完整图像目录", async () => {
    const result = await loadHomepagePageData(
      createLoaders({
        loadCatalog: vi.fn().mockResolvedValue({
          items: [
            { ...PUBLIC_IMAGE_MODEL, homepageVisible: false },
            PUBLIC_VIDEO_MODEL,
          ],
        }),
      })
    );

    expect(result.catalog).toEqual({
      status: "ready",
      image: [{ id: PUBLIC_IMAGE_MODEL.modelId }],
      homepage: [
        {
          id: PUBLIC_VIDEO_MODEL.modelId,
          category: "video",
          priority: PUBLIC_VIDEO_MODEL.homepagePriority,
        },
      ],
    });
  });

  it("把零样本收窄为不足，关闭展示时保留真实统计但不伪造百分比", async () => {
    const result = await loadHomepagePageData(
      createLoaders({
        loadSlaVisibility: vi.fn().mockResolvedValue(false),
        loadSlaStats: vi.fn().mockResolvedValue({
          ...READY_SLA_STATS,
          sampleSize: 0,
          completed: 0,
          failed: 0,
          platformErrors: 0,
          successRate: 1,
        }),
      })
    );

    expect(result.reliability.visibility).toBe("disabled");
    expect(result.reliability.stats).toEqual({ status: "insufficient" });
  });

  it.each([
    {
      name: "有效管理员会话",
      session: { user: { id: "admin-1" } },
      roleResult: "admin",
      roleFailure: false,
      href: "/dashboard/generate",
      canToggle: true,
    },
    {
      name: "有效会话但角色读取失败",
      session: { user: { id: "user-1" } },
      roleResult: "user",
      roleFailure: true,
      href: "/dashboard/generate",
      canToggle: false,
    },
    {
      name: "无会话",
      session: null,
      roleResult: "admin",
      roleFailure: false,
      href: "/sign-up",
      canToggle: false,
    },
  ] as const)("$name 时 CTA 与管理员能力独立收窄", async ({
    session,
    roleResult,
    roleFailure,
    href,
    canToggle,
  }) => {
    const loadRole = roleFailure
      ? vi.fn().mockRejectedValue(new Error("role unavailable"))
      : vi.fn().mockResolvedValue(roleResult);
    const result = await loadHomepagePageData(
      createLoaders({
        loadSession: vi.fn().mockResolvedValue(session),
        loadRole,
      })
    );

    expect(result.ctaHref).toBe(href);
    expect(result.canToggleSlaStatus).toBe(canToggle);
    expect(loadRole).toHaveBeenCalledTimes(session ? 1 : 0);
  });

  it("会话读取失败安全回退注册入口且不读取角色", async () => {
    const loadRole = vi.fn().mockResolvedValue("admin");
    const result = await loadHomepagePageData(
      createLoaders({
        loadSession: vi.fn().mockRejectedValue(new Error("session failed")),
        loadRole,
      })
    );

    expect(result.ctaHref).toBe("/sign-up");
    expect(result.canToggleSlaStatus).toBe(false);
    expect(loadRole).not.toHaveBeenCalled();
  });

  it("畸形公开模型载荷失败关闭且客户端结果不包含内部字段", async () => {
    const catalogWithCanaries = {
      items: [
        {
          ...PUBLIC_IMAGE_MODEL,
          apiKey: "api-key-canary",
          baseUrl: "https://user:password@example.test",
        },
      ],
    };
    const result = await loadHomepagePageData(
      createLoaders({
        loadCatalog: vi.fn().mockResolvedValue(catalogWithCanaries),
        loadSlaStats: vi.fn().mockResolvedValue({
          ...READY_SLA_STATS,
          rawError: new Error("stack-canary"),
        }),
        loadSession: vi.fn().mockResolvedValue({
          user: { id: "user-1", email: "session-email-canary" },
          token: "session-token-canary",
        }),
      })
    );
    const serialized = JSON.stringify(result);

    expect(result.catalog).toEqual({
      status: "unavailable",
    });
    expect(serialized).not.toMatch(
      /api-key-canary|password@example|principal-canary|database-row-canary|stack-canary|session-email-canary|session-token-canary/
    );
  });

  it("日志只接收稳定字段，不记录密码 URL、Bearer、SQL、API Key 或异常文本", async () => {
    const reportFailure = vi.fn();
    const secretError = new Error(
      "https://user:password@example.test Bearer token-canary SELECT * FROM secret api_key=key-canary"
    );
    secretError.stack = "stack-canary";
    await loadHomepagePageData(
      createLoaders({
        loadCatalog: vi.fn().mockRejectedValue(secretError),
        loadSlaVisibility: vi.fn().mockRejectedValue(secretError),
        loadSlaStats: vi.fn().mockRejectedValue(secretError),
        loadSession: vi.fn().mockRejectedValue(secretError),
        reportFailure,
      })
    );

    const logged = JSON.stringify(reportFailure.mock.calls);
    expect(logged).not.toMatch(
      /password@example|Bearer|token-canary|SELECT|api_key|key-canary|stack-canary/
    );
    for (const [event] of reportFailure.mock.calls) {
      expect(Object.keys(event).sort()).toEqual([
        "event",
        "requestId",
        "retryable",
        "safeCode",
        "section",
      ]);
    }
  });
});

/** 创建覆盖完整可见区块的服务端页面数据。 */
function createRenderablePageData(
  overrides: Partial<HomepagePageData> = {}
): HomepagePageData {
  return {
    catalog: {
      status: "ready",
      image: [{ id: PUBLIC_IMAGE_MODEL.modelId }],
      homepage: [
        {
          id: PUBLIC_IMAGE_MODEL.modelId,
          category: "image",
          priority: 5,
        },
      ],
    },
    reliability: {
      visibility: "enabled",
      stats: { status: "ready", data: READY_SLA_STATS },
    },
    ctaHref: "/dashboard/generate",
    canToggleSlaStatus: false,
    ...overrides,
  };
}

describe("HomepageContent 服务端完成态", () => {
  it("首页按优先级混排图像与视频并在六个格子后截断", async () => {
    const element = await HomepageContent({
      locale: "zh",
      data: createRenderablePageData({
        catalog: {
          status: "ready",
          image: [
            { id: " image-4-ultra " },
            { id: "gpt-image-2" },
            { id: "imagen-4" },
            { id: "gpt-image-1.5" },
            { id: "nano-banana-pro" },
            { id: "nano-banana" },
            { id: "preview-overflow-canary" },
          ],
          homepage: [
            { id: " image-4-ultra ", category: "image", priority: 5 },
            { id: "veo31", category: "video", priority: 1 },
            { id: "gpt-image-2", category: "image", priority: 2 },
            { id: "imagen-4", category: "image", priority: 3 },
            { id: "gpt-image-1.5", category: "image", priority: 4 },
            { id: "nano-banana-pro", category: "image", priority: 5 },
            { id: "preview-overflow-canary", category: "video", priority: 9 },
          ],
        },
      }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('data-model-category="mixed"');
    expect(html).toContain('id="models"');
    expect(html).not.toMatch(/role="(?:tab|tablist|tabpanel)"/);
    expect(html).toContain("image-4-ultra");
    expect(html).toContain("gpt-image-2");
    expect(html).toContain("imagen-4");
    expect(html).toContain("veo31");
    expect(html).not.toContain("veo31-4s-16x9-1080p");
    expect(html).toContain("视频");
    expect(html).not.toContain("preview-overflow-canary");
    expect(html).toContain('href="/models"');
    expect(html).toContain("查看全部模型");
    expect(html).toContain("快速集成");
    expect(html).toContain("/v1/images/generations");
    expect(html).toContain(
      "&quot;model&quot;: &quot;image-4-ultra&quot;,"
    );
    expect(html).toContain("%2Fcinema%2Fwall%2Fw01.webp");
    expect(html).toContain("96.00%");
    expect(html).toContain("为什么有时看不到可靠性百分比？");
    expect(html).toContain("首页只展示统计服务可验证的结果");
    expect(html.match(/href="\/dashboard\/generate"/g)?.length).toBe(2);
    expect(html).not.toContain("浏览作品");
    expect(html).toContain("<footer");
    expect(html).toContain("© 2026 FluxMedia. 保留所有权利。");
    expect(html).not.toMatch(/Pricing|订阅|额外积分包|twitter|github|discord/i);
    expect(html).not.toContain("把模型、作品和下一步放在一起");
  });

  it("英文空目录完成态保留混合模型空状态、双语 alt、注册 CTA 和诚实状态", async () => {
    const element = await HomepageContent({
      locale: "en",
      data: createRenderablePageData({
        catalog: {
          status: "ready",
          image: [],
          homepage: [],
        },
        reliability: {
          visibility: "enabled",
          stats: { status: "unavailable" },
        },
        ctaHref: "/sign-up",
      }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain(
      "No model is currently enabled for homepage display"
    );
    expect(html).toContain("Reliability statistics are currently unavailable");
    expect(html).toContain(
      "East Asian ink artwork of pale bamboo shadows and open space"
    );
    expect(html.match(/href="\/sign-up"/g)?.length).toBe(2);
    expect(html).toContain("© 2026 FluxMedia. All rights reserved.");
    expect(html).not.toMatch(/subscription|credit pack/i);
  });

  it.each([
    {
      name: "公开图像目录为空",
      catalog: {
        status: "ready" as const,
        image: [],
        homepage: [],
      },
      unavailableMessage: "当前没有允许在官网首页展示的模型",
    },
    {
      name: "运行时目录不可用",
      catalog: { status: "unavailable" as const },
      unavailableMessage: "当前无法读取公开模型目录",
    },
  ])("$name 时不生成 cURL 并保持诚实降级", async ({
    catalog,
    unavailableMessage,
  }) => {
    const element = await HomepageContent({
      locale: "zh",
      data: createRenderablePageData({ catalog }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain(unavailableMessage);
    expect(html).toContain("示例暂不可用");
    expect(html).not.toContain("curl ");
  });

  it("统计关闭时访客不见百分比，管理员仍得到服务端管理入口", async () => {
    const visitorElement = await HomepageContent({
      locale: "zh",
      data: createRenderablePageData({
        reliability: {
          visibility: "disabled",
          stats: { status: "ready", data: READY_SLA_STATS },
        },
      }),
    });
    const adminElement = await HomepageContent({
      locale: "zh",
      data: createRenderablePageData({
        reliability: {
          visibility: "disabled",
          stats: { status: "ready", data: READY_SLA_STATS },
        },
        canToggleSlaStatus: true,
      }),
    });

    const visitorHtml = renderToStaticMarkup(visitorElement);
    const adminHtml = renderToStaticMarkup(adminElement);
    expect(visitorHtml).not.toContain("96.00%");
    expect(visitorHtml).not.toContain("首页可靠性展示已关闭");
    expect(adminHtml).toContain("首页可靠性展示已关闭");
    expect(adminHtml).not.toContain("96.00%");
  });
});
