/**
 * 统一媒体后端号池 UOL binding 的 DB-free 测试。
 *
 * 职责：锁定无网络脚本测试的生产契约校验、模拟媒体令牌和脱敏进程诊断；
 * 真实 QuickJS Worker 的执行与资源限制由其专用测试覆盖。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/shared/uol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/shared/uol")>();
  return { ...actual, bindExecute: vi.fn() };
});

import {
  buildAdminPoolMembers,
  executeApiUpstreamAdapterTestBinding,
  executeApiUpstreamRuntimeDiagnosticsBinding,
} from "./image-backend-pool";

describe("image backend pool UOL bindings", () => {
  it("通用号池 DTO 移除 Adobe refresh 和余额诊断错误", () => {
    const [member] = buildAdminPoolMembers([
      {
        id: "adobe-direct",
        name: "Adobe Direct",
        type: "adobe",
        groupIds: [],
        supportedModelIds: ["gpt-image-2"],
        contentSafetyEnabled: true,
        isEnabled: true,
        alwaysActive: false,
        failureCooldownEnabled: true,
        priority: 1,
        concurrency: 1,
        status: "active",
        healthStatus: "healthy",
        inflightCount: 0,
        leaseAcquiredCount: 0,
        createdAt: "2026-07-26T00:00:00.000Z",
        lastAcquiredAt: null,
        lastUsedAt: null,
        lastError: null,
        lastErrorAt: null,
        config: {
          mode: "direct",
          hasCookie: true,
          displayName: null,
          email: null,
          credentialStatus: "active",
          lastRefreshAt: null,
          lastRefreshError: "cookie=secret",
          consecutiveFailures: 0,
          fireflyCredentialStatus: "active",
          fireflyLastRefreshAt: null,
          fireflyLastRefreshError: "Bearer secret",
          fireflyConsecutiveFailures: 0,
          creditsTotal: null,
          creditsUsed: null,
          creditsAvailable: null,
          creditsUpdatedAt: null,
          creditsError: "upstream raw response",
          defaultRatio: "1x1",
          defaultResolution: "2k",
          gptImageQuality: "high",
        },
      },
    ]);

    expect(member?.config).not.toHaveProperty("lastRefreshError");
    expect(member?.config).not.toHaveProperty("fireflyLastRefreshError");
    expect(member?.config).not.toHaveProperty("creditsError");
  });

  it("请求测试预览部分信封并保持模拟媒体令牌恰好一次", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const runScript = vi.fn(
      async (
        input: unknown,
        _script: string,
        context: Readonly<Record<string, unknown>>
      ) => {
        expect(JSON.stringify(input)).not.toContain("mock://media/image-1");
        expect(context).toMatchObject({
          operation: "images.edit",
          stage: "request",
          contentType: "multipart/form-data",
        });
        const request = input as {
          query: Record<string, unknown>;
          body: { image: string; prompt: string };
        };
        const image = request.body.image;
        return {
          body: { ...request.body, image },
          query: { trace: true },
        };
      }
    );

    const result = await executeApiUpstreamAdapterTestBinding(
      {
        operation: "images.edit",
        stage: "request",
        script: "return { body: input };",
        sample: {
          query: {},
          body: {
            model: "gpt-image-2",
            prompt: "夜景",
            image: "mock://media/image-1",
          },
        },
      },
      { runScript }
    );

    expect(result).toEqual({
      preview: {
        body: {
          image: "mock://media/image-1",
          model: "gpt-image-2",
          prompt: "夜景",
        },
        query: { trace: true },
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("响应测试只接受与操作媒体类型一致的标准结果", async () => {
    const runScript = vi.fn(async () => ({
      status: "completed",
      outputs: [{ kind: "video", url: "https://cdn.example.com/result.mp4" }],
    }));

    await expect(
      executeApiUpstreamAdapterTestBinding(
        {
          operation: "videos.generate",
          stage: "response",
          script: "return { status: 'completed', outputs: [] };",
          sample: { statusCode: 200, headers: {}, body: { id: "task-1" } },
        },
        { runScript }
      )
    ).resolves.toEqual({
      preview: {
        status: "completed",
        outputs: [{ kind: "video", url: "https://cdn.example.com/result.mp4" }],
      },
    });

    runScript.mockResolvedValueOnce({
      status: "completed",
      outputs: [{ kind: "image", url: "https://cdn.example.com/image.png" }],
    });
    await expect(
      executeApiUpstreamAdapterTestBinding(
        {
          operation: "videos.generate",
          stage: "response",
          script: "return response;",
          sample: {},
        },
        { runScript }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("查询请求脚本不能通过测试器添加 GET Body", async () => {
    await expect(
      executeApiUpstreamAdapterTestBinding(
        {
          operation: "videos.query",
          stage: "request",
          script: "return { body: input };",
          sample: { query: {} },
        },
        { runScript: vi.fn(async (input) => ({ body: input })) }
      )
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "供应商请求处理脚本测试失败，请检查脚本和样例",
    });
  });

  it("测试器拒绝把模拟媒体令牌复制到业务 Header", async () => {
    await expect(
      executeApiUpstreamAdapterTestBinding(
        {
          operation: "images.edit",
          stage: "request",
          script: "return {};",
          sample: {
            query: {},
            body: { image: "mock://media/image-1" },
          },
        },
        {
          runScript: vi.fn(async (input) => {
            const request = input as { body: { image: string } };
            return {
              body: request.body,
              headers: { "X-Media-Token": request.body.image },
            };
          }),
        }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("测试器拒绝缺少 query 信封的裸请求 Body", async () => {
    await expect(
      executeApiUpstreamAdapterTestBinding(
        {
          operation: "images.generate",
          stage: "request",
          script: "return {};",
          sample: { model: "gpt-image-2", prompt: "test" },
        },
        { runScript: vi.fn(async () => ({})) }
      )
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("进程诊断只投影 Worker、队列和许可计数", () => {
    const result = executeApiUpstreamRuntimeDiagnosticsBinding({
      getRuntimeDiagnostics: () => ({
        state: "ready",
        configuredWorkers: 2,
        readyWorkers: 1,
        busyWorkers: 1,
        queuedRequests: 3,
        queuedResponses: 1,
        queuedBytes: 4_096,
        activeResponsePermits: 2,
        responsePermitCapacity: 32,
        saturationCount: 4,
        replacementCount: 1,
      }),
    });

    expect(result).toEqual({
      lifecycle: "ready",
      workerCount: 2,
      liveWorkerCount: 1,
      requestQueueLength: 3,
      responseQueueLength: 1,
      responsePermitsInUse: 2,
      responsePermitCapacity: 32,
      saturationCount: 4,
      replacementCount: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /script|body|header|prompt|taskId/i
    );
  });
});
