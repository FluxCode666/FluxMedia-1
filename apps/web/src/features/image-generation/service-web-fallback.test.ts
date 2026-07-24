import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerateImageResult } from "./types";

vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingBoolean: vi.fn(async () => false),
  getRuntimeSettingNumber: vi.fn(
    async (_key: string, fallback: number) => fallback
  ),
  getRuntimeSettingString: vi.fn(async () => ""),
}));

vi.mock("@repo/shared/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const backendPoolMock = vi.hoisted(() => {
  class ImageBackendPoolUnavailableError extends Error {}
  return {
    ImageBackendPoolUnavailableError,
    acquireImageBackendInflight: vi.fn(),
    bindImageBackendStickyMember: vi.fn(async () => undefined),
    releaseImageBackendInflight: vi.fn(),
    releaseImageBackendInflightLease: vi.fn(async () => undefined),
    recordImageBackendSchedulerSwitch: vi.fn(async () => undefined),
    isImageBackendSwitchableError: vi.fn((error?: string | null) =>
      (error || "").includes("terminated")
    ),
    // 本测试只关注可切换错误的回退路径，未知错误兜底固定不触发。
    isUnclassifiedBackendError: vi.fn(() => false),
    reportImageBackendResult: vi.fn(async (input: { success: boolean }) => ({
      success: input.success,
      retryable: !input.success,
      switchable: !input.success,
    })),
    resolveImageBackendPoolConfig: vi.fn(),
  };
});

vi.mock("@/features/image-backend-pool/service", () => backendPoolMock);

const chatgptWebMock = vi.hoisted(() => ({
  generateImageWithChatGptWeb: vi.fn(
    async (): Promise<GenerateImageResult> => ({ error: "terminated" })
  ),
  editImageWithChatGptWeb: vi.fn(
    async (): Promise<GenerateImageResult> => ({ error: "terminated" })
  ),
}));

vi.mock("./chatgpt-web", () => chatgptWebMock);

describe("image service Web-first fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("falls back to Responses when force Web exhausts Web candidates", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    const imageBase64 = Buffer.from("codex-fallback-image").toString("base64");
    // codex(responses 账号)的普通生成现在直连 /images/generations(size 走顶层),
    // 不再走 /responses 工具路径;mock 返回标准 images JSON。
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ data: [{ b64_json: imageBase64 }] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    backendPoolMock.resolveImageBackendPoolConfig
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        config: {
          baseUrl: "https://api.example.test/v1",
          apiKey: "codex-key",
          model: "gpt-5.4",
          backend: {
            type: "pool-account",
            id: "codex-1",
            groupId: "group-1",
            userId: "user-1",
            requestKind: "image_generation",
            accountBackend: "responses",
            reportResult: true,
          },
        },
      });

    const result = await generateImage(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: "web-key",
        backend: {
          type: "pool-account",
          id: "web-1",
          groupId: "group-1",
          // 混合分组:web 先行,轮询完才回退 codex(回退仅 mixed 生效)。
          groupBackendType: "mixed",
          userId: "user-1",
          requestKind: "image_generation",
          accountBackend: "web",
          reportResult: true,
        },
      },
      {
        prompt: "make an icon",
        model: "gpt-image-2",
        size: "1024x1024",
        forceWebBackend: true,
      }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountBackendPreference: "web",
        accountBackendPreferenceMode: "mixed-only",
      })
    );
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accountBackendPreference: "responses",
        accountBackendPreferenceMode: "mixed-only",
      })
    );
    // 回退到的 codex 账号在普通生成下命中直连 images 端点,而非 /responses。
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/images/generations",
      expect.anything()
    );
  });

  it("非混合分组:Web 耗尽不回退 Codex(回退仅 mixed 生效)", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    // 纯 web 分组的 web 成员撞可切换错误 → 换号 re-resolve 返回 null(web 已轮询完)。
    // 因目标分组非 mixed,不应触发 web→codex 回退,直接返回失败结果。
    backendPoolMock.resolveImageBackendPoolConfig.mockResolvedValueOnce(null);

    const result = await generateImage(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: "web-key",
        backend: {
          type: "pool-account",
          id: "web-1",
          groupId: "group-web",
          // 纯 web 分组:闭环,web 耗尽即止,不跨车道回退 codex。
          groupBackendType: "web",
          userId: "user-1",
          requestKind: "image_generation",
          accountBackend: "web",
          reportResult: true,
        },
      },
      {
        prompt: "make an icon",
        model: "gpt-image-2",
        size: "1024x1024",
        forceWebBackend: true,
      }
    );

    // 返回失败结果(未回退到 codex,无图)。
    expect(result.imageBase64).toBeUndefined();
    expect(result.error).toContain("terminated");
    // 只发生一次 web 侧 re-resolve;绝不应再以 responses 偏好回退。
    expect(backendPoolMock.resolveImageBackendPoolConfig).toHaveBeenCalledTimes(
      1
    );
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({ accountBackendPreference: "responses" })
    );
  });

  it("重试保留显式分组、模型和蒙版能力约束", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { editImage } = await import("./service");
    const imageBase64 = Buffer.from("masked-retry-image").toString("base64");
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ data: [{ b64_json: imageBase64 }] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    backendPoolMock.resolveImageBackendPoolConfig.mockResolvedValueOnce({
      config: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "api-key-2",
        backend: {
          type: "pool-api",
          id: "api-2",
          groupId: "group-selected",
          userId: "user-1",
          requestKind: "image_edit",
          reportResult: true,
        },
      },
    });

    const result = await editImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "codex-key-1",
        backend: {
          type: "pool-account",
          id: "codex-1",
          groupId: "group-selected",
          userId: "user-1",
          // 外绘会复用主生图 config；重试仍必须按 image_edit 选候选。
          requestKind: "image_generation",
          accountBackend: "responses",
          requestedBackendGroupId: "group-selected",
          requiresMask: true,
          reportResult: true,
        },
      },
      {
        prompt: "replace the background",
        model: "gpt-image-2",
        images: [
          {
            data: Buffer.from("source-image"),
            name: "source.png",
            type: "image/png",
          },
        ],
        mask: {
          data: Buffer.from("mask-image"),
          name: "mask.png",
          type: "image/png",
        },
      }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(backendPoolMock.resolveImageBackendPoolConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        backendGroupId: "group-selected",
        requiresMask: true,
        requestedModel: "gpt-image-2",
        requestKind: "image_edit",
        excludedMemberKeys: ["account:codex-1"],
      })
    );
  });

  it("蒙版编辑拒绝 Web 候选，即使其适配器会成功", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { editImage } = await import("./service");
    chatgptWebMock.editImageWithChatGptWeb.mockResolvedValueOnce({
      imageBase64: Buffer.from("must-not-run").toString("base64"),
    });

    const result = await editImage(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: "web-key",
        backend: {
          type: "pool-account",
          id: "web-1",
          groupId: "group-selected",
          userId: "user-1",
          requestKind: "image_edit",
          accountBackend: "web",
          reportResult: true,
          inflightLease: true,
          inflightLeaseId: "lease-web-1",
          inflightLeasePersisted: false,
        },
      },
      {
        prompt: "replace the background",
        model: "gpt-image-2",
        images: [
          {
            data: Buffer.from("source-image"),
            name: "source.png",
            type: "image/png",
          },
        ],
        mask: {
          data: Buffer.from("mask-image"),
          name: "mask.png",
          type: "image/png",
        },
      }
    );

    expect(result.error).toContain("不支持蒙版编辑");
    expect(chatgptWebMock.editImageWithChatGptWeb).not.toHaveBeenCalled();
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).not.toHaveBeenCalled();
    expect(
      backendPoolMock.releaseImageBackendInflightLease
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        memberType: "account",
        memberId: "web-1",
        leaseId: "lease-web-1",
      })
    );
  });

  it("蒙版编辑拒绝 Adobe 候选，且不发送任何上游请求", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { editImage } = await import("./service");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await editImage(
      {
        baseUrl: "https://firefly.example.test",
        apiKey: "adobe-key",
        backend: {
          type: "pool-adobe",
          id: "adobe-1",
          groupId: "group-selected",
          userId: "user-1",
          requestKind: "image_edit",
          reportResult: true,
          inflightLease: true,
          inflightLeaseId: "lease-adobe-1",
          inflightLeasePersisted: false,
        },
      },
      {
        prompt: "replace the background",
        model: "gpt-image-2",
        images: [
          {
            data: Buffer.from("source-image"),
            name: "source.png",
            type: "image/png",
          },
        ],
        mask: {
          data: Buffer.from("mask-image"),
          name: "mask.png",
          type: "image/png",
        },
      }
    );

    expect(result.error).toContain("不支持蒙版编辑");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      backendPoolMock.resolveImageBackendPoolConfig
    ).not.toHaveBeenCalled();
    expect(
      backendPoolMock.releaseImageBackendInflightLease
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        memberType: "adobe",
        memberId: "adobe-1",
        leaseId: "lease-adobe-1",
      })
    );
  });

  it("Chat 重试使用图像模型而非对话模型约束候选", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateChatImage } = await import("./service");
    backendPoolMock.resolveImageBackendPoolConfig.mockResolvedValueOnce(null);

    const result = await generateChatImage(
      {
        baseUrl: "https://chatgpt.com",
        apiKey: "web-key",
        backend: {
          type: "pool-account",
          id: "web-1",
          groupId: "group-1",
          userId: "user-1",
          requestKind: "chat",
          accountBackend: "web",
          reportResult: true,
        },
      },
      {
        prompt: "make an icon",
        model: "gpt-5.4",
        imageModel: "custom-image-model",
      }
    );

    expect(result.error).toContain("terminated");
    expect(backendPoolMock.resolveImageBackendPoolConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedModel: "custom-image-model",
      })
    );
  });

  it("带 API Key 重试时仍传递可信的隐式默认计费分组", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";
    const { generateImage } = await import("./service");
    const imageBase64 = Buffer.from("second-member-image").toString("base64");
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        // 首个 codex 成员的 /images/generations 返回无图,触发切换到下一个成员。
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ data: [{ b64_json: imageBase64 }] }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    backendPoolMock.resolveImageBackendPoolConfig.mockResolvedValueOnce({
      config: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "codex-key-2",
        model: "gpt-5.4",
        backend: {
          type: "pool-account",
          id: "codex-2",
          groupId: "group-1",
          userId: "user-1",
          requestKind: "image_generation",
          accountBackend: "responses",
          reportResult: true,
        },
      },
    });

    const result = await generateImage(
      {
        baseUrl: "https://api.example.test/v1",
        apiKey: "codex-key-1",
        model: "gpt-5.4",
        backend: {
          type: "pool-account",
          id: "codex-1",
          groupId: "group-1",
          billingGroupId: "group-default",
          userId: "user-1",
          apiKeyId: "api-key-1",
          requestKind: "image_generation",
          accountBackend: "responses",
          reportResult: true,
        },
      },
      {
        prompt: "make an icon",
        model: "gpt-image-2",
        size: "1024x1024",
      }
    );

    expect(result.imageBase64).toBe(imageBase64);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(backendPoolMock.reportImageBackendResult).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: "codex-1",
        success: false,
        error: expect.stringContaining("API returned no image data"),
      })
    );
    expect(backendPoolMock.resolveImageBackendPoolConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        excludedMemberKeys: ["account:codex-1"],
        apiKeyId: "api-key-1",
        pinnedImplicitGroupId: "group-default",
        requestedModel: "gpt-image-2",
      })
    );
  });
});
