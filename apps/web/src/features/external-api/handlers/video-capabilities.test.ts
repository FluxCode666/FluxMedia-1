/**
 * 外部视频能力查询 UOL 适配器单测。
 *
 * 使用方：Vitest；验证 API Key Principal 薄调用 video.listCapabilities，并保持
 * 公共 DTO 不泄露成员、凭据、健康或容量字段。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  ensureInitialized: vi.fn(),
  invokeOperation: vi.fn(),
}));

vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: (handler: unknown) => handler,
}));
vi.mock("@repo/shared/uol", () => ({
  invokeOperation: mocks.invokeOperation,
}));
vi.mock("@/features/external-api/auth", () => ({
  authenticateExternalApiRequest: mocks.authenticate,
}));
vi.mock("@/features/external-api/images", () => ({
  openAIImageError: (message: string, status = 400, code?: string) =>
    Response.json({ error: { message, code: code ?? null } }, { status }),
}));
vi.mock("@/server/uol-init", () => ({
  ensureUolInitialized: mocks.ensureInitialized,
}));

import { getExternalVideoCapabilities } from "./video-capabilities";

describe("getExternalVideoCapabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      userId: "user-1",
      apiKeyId: "key-a",
    });
    mocks.ensureInitialized.mockResolvedValue(undefined);
    mocks.invokeOperation.mockResolvedValue({
      items: [
        {
          model: "seedance2",
          displayName: "Seedance 2.0",
          durations: [10],
          aspectRatios: ["16:9"],
          resolutions: ["1080p"],
          input: {
            frames: "first-and-optional-last",
            referenceImages: { maxCount: 20, configurable: true },
            framesAndReferencesMutuallyExclusive: true,
          },
          audio: { supported: true, defaultEnabled: false },
          configuredReachable: true,
        },
      ],
      limits: {
        maxMediaInputCount: 256,
        maxMediaInputBytes: 536_870_912,
      },
    });
  });

  it("使用 API Key Principal 薄调用 video.listCapabilities", async () => {
    const request = new Request("https://example.com/v1/videos/capabilities", {
      headers: { "x-request-id": "req-capabilities" },
    });
    const response = await getExternalVideoCapabilities(request as never);

    expect(response.status).toBe(200);
    expect(mocks.invokeOperation).toHaveBeenCalledWith(
      "video.listCapabilities",
      {},
      {
        type: "apiKey",
        credentialKind: "external",
        userId: "user-1",
        apiKeyId: "key-a",
      },
      { externalRequestId: "req-capabilities" }
    );
  });

  it("原样返回公共能力 DTO，且不泄露成员或实时容量", async () => {
    const response = await getExternalVideoCapabilities(
      new Request("https://example.com/v1/videos/capabilities") as never
    );
    const payload = await response.json();

    expect(payload.items[0]).toMatchObject({
      model: "seedance2",
      input: { referenceImages: { maxCount: 20 } },
      configuredReachable: true,
    });
    expect(payload.limits).toEqual({
      maxMediaInputCount: 256,
      maxMediaInputBytes: 536_870_912,
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /member|credential|cookie|token|health|cooldown|concurrency|capacity/i
    );
  });
});
