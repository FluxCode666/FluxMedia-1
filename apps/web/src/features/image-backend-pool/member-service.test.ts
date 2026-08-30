/**
 * 统一媒体后端成员服务测试。
 *
 * 职责：以 DB-free 仓储端口锁定新增/编辑、类型不可变、secret 保留、URL 安全、
 * 分组关系、启用状态修改、运行状态重置与运行中任务删除保护；数据库事务细节由集成
 * 测试覆盖。
 */

import { createDefaultApiUpstreamOperations } from "@repo/shared/image-backend/api-upstream-adaptation";
import {
  type BackendMemberInput,
  backendMemberInputSchema,
} from "@repo/shared/image-backend/member-contract";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  type BackendMemberAdminSummary,
  type BackendMemberRepository,
  BackendMemberServiceError,
  createApiAdapterDraft,
  createBackendMemberService,
} from "./member-service";

const NOW = new Date("2026-07-26T00:00:00.000Z");

/** 构造只记录调用的仓储，单个测试按需覆盖返回值。 */
function createRepository(): BackendMemberRepository & {
  saveMember: ReturnType<typeof vi.fn>;
  listMembers: ReturnType<typeof vi.fn>;
  resetMemberStatus: ReturnType<typeof vi.fn>;
  setMemberEnabled: ReturnType<typeof vi.fn>;
  deleteMember: ReturnType<typeof vi.fn>;
} {
  return {
    saveMember: vi.fn(async (input) => ({
      status: "saved" as const,
      id: input.id,
    })),
    listMembers: vi.fn(async () => []),
    resetMemberStatus: vi.fn(async () => "reset" as const),
    setMemberEnabled: vi.fn(async () => "updated" as const),
    deleteMember: vi.fn(async () => "deleted" as const),
  };
}

/** 构造默认合法的 API 媒体成员输入。 */
function apiInput(overrides: Record<string, unknown> = {}) {
  return {
    type: "api",
    name: "Primary Images",
    groupIds: ["group-a"],
    supportedModelIds: ["gpt-image-2"],
    contentSafetyEnabled: true,
    isEnabled: true,
    alwaysActive: false,
    failureCooldownEnabled: true,
    priority: 10,
    concurrency: 5,
    config: {
      baseUrl: "https://images.example.com/v1",
      apiKey: "secret-api-key",
      useStream: true,
      modelMappings: [],
      ...(typeof overrides.id === "string"
        ? { expectedCurrentVersionId: "adapter-current" }
        : {}),
    },
    ...overrides,
  };
}

describe("backend member service", () => {
  let repository: ReturnType<typeof createRepository>;
  let validateUpstreamUrl: Mock<(url: string) => Promise<unknown>>;

  beforeEach(() => {
    repository = createRepository();
    validateUpstreamUrl = vi.fn(
      async (_url: string) => new URL("https://example.com")
    );
  });

  it("新增 API 成员前校验 URL 并补齐服务端 ID", async () => {
    const service = createBackendMemberService({
      repository,
      createId: () => "member-new",
      now: () => NOW,
      validateUpstreamUrl,
    });

    await expect(service.saveMember(apiInput())).resolves.toEqual({
      id: "member-new",
    });
    expect(validateUpstreamUrl).toHaveBeenCalledWith(
      "https://images.example.com/v1"
    );
    expect(repository.saveMember).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "member-new",
        isCreate: true,
        type: "api",
        supportedModelIds: ["gpt-image-2"],
        config: expect.objectContaining({ useStream: true }),
      }),
      NOW
    );
  });

  it("校验并持久化账号模型映射与操作级请求脚本", async () => {
    const validateAdapterScript = vi.fn(async () => {});
    const service = createBackendMemberService({
      repository,
      createId: () => "member-adapted",
      now: () => NOW,
      validateUpstreamUrl,
      validateAdapterScript,
    });
    const operations = createDefaultApiUpstreamOperations();
    const requestScript =
      "return { body: { ...request.body, ratio: request.body.aspect_ratio } };";
    operations["videos.generate"].requestScript = requestScript;

    await service.saveMember(
      apiInput({
        supportedModelIds: ["seedance2"],
        config: {
          baseUrl: "https://video.example.com/v1",
          apiKey: "secret-api-key",
          useStream: false,
          modelMappings: [
            { modelId: "seedance2", upstreamModelId: "seedande-2.0" },
          ],
          operations,
        },
      })
    );

    expect(validateAdapterScript).toHaveBeenCalledTimes(1);
    expect(validateAdapterScript).toHaveBeenCalledWith(
      requestScript,
      "videos.generate",
      "request"
    );
    expect(repository.saveMember).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          modelMappings: [
            { modelId: "seedance2", upstreamModelId: "seedande-2.0" },
          ],
          operations: expect.objectContaining({
            "videos.generate": expect.objectContaining({
              requestScript,
            }),
          }),
        }),
      }),
      NOW
    );
  });

  it("保留 API 成员按模型声明的视频参考媒体能力", () => {
    const input = backendMemberInputSchema.parse(
      apiInput({
        supportedModelIds: ["seedance2"],
        config: {
          baseUrl: "https://video.example.com/v1",
          apiKey: "secret-api-key",
          useStream: false,
          videoProtocolMode: "custom",
          videoInputCapabilities: {
            referenceVideos: false,
            referenceAudios: false,
          },
          videoInputCapabilitiesByModel: {
            seedance2: {
              referenceVideos: true,
              referenceAudios: true,
            },
          },
          modelMappings: [],
          authentication: { mode: "bearer" },
          operations: createDefaultApiUpstreamOperations(),
        },
      })
    ) as Extract<BackendMemberInput, { type: "api" }>;

    expect(createApiAdapterDraft(input)).toMatchObject({
      videoInputCapabilities: {
        referenceVideos: false,
        referenceAudios: false,
      },
      videoInputCapabilitiesByModel: {
        seedance2: {
          referenceVideos: true,
          referenceAudios: true,
        },
      },
    });
  });

  it("请求处理脚本校验失败时拒绝保存 API 账号", async () => {
    const service = createBackendMemberService({
      repository,
      createId: () => "member-invalid-script",
      now: () => NOW,
      validateUpstreamUrl,
      validateAdapterScript: async () => {
        throw new Error("invalid JavaScript");
      },
    });

    const operations = createDefaultApiUpstreamOperations();
    operations["images.generate"].requestScript = "if (";
    const error = await service
      .saveMember(
        apiInput({
          config: {
            baseUrl: "https://images.example.com/v1",
            apiKey: "secret-api-key",
            useStream: false,
            modelMappings: [],
            operations,
          },
        })
      )
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "validation_error",
      message: "文生图生成请求脚本语法无效",
    });
    expect(repository.saveMember).not.toHaveBeenCalled();
  });

  it("逐一校验六操作请求与响应脚本并定位失败字段", async () => {
    const operations = createDefaultApiUpstreamOperations();
    operations["images.generate.query"] = {
      path: "/images/{task_id}",
      requestScript: "return { query: { verbose: true } };",
      responseScript: "return { status: 'processing' };",
    };
    operations["videos.generate"] = {
      path: "",
      requestScript: "return { body: input };",
      responseScript: "return response.body;",
    };
    const validateAdapterScript = vi.fn(
      async (
        _script: string,
        operation: string,
        stage: "request" | "response"
      ) => {
        if (operation === "videos.generate" && stage === "response") {
          throw new Error("invalid response script");
        }
      }
    );
    const service = createBackendMemberService({
      repository,
      validateUpstreamUrl,
      validateAdapterScript,
    });

    const error = await service
      .saveMember(
        apiInput({
          config: {
            baseUrl: "https://video.example.com/v1",
            apiKey: "secret-api-key",
            useStream: false,
            modelMappings: [],
            authentication: { mode: "bearer" },
            operations,
          },
        })
      )
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "validation_error",
      message: "生视频生成响应脚本语法无效",
    });
    expect(validateAdapterScript.mock.calls).toEqual([
      [
        "return { query: { verbose: true } };",
        "images.generate.query",
        "request",
      ],
      ["return { status: 'processing' };", "images.generate.query", "response"],
      ["return { body: input };", "videos.generate", "request"],
      ["return response.body;", "videos.generate", "response"],
    ]);
    expect(repository.saveMember).not.toHaveBeenCalled();
  });

  it("返回仓储原子保存产生的适配版本标识", async () => {
    repository.saveMember.mockResolvedValue({
      status: "saved",
      id: "member-versioned",
      adapterVersion: { id: "adapter-v2", revision: 2 },
    });
    const service = createBackendMemberService({
      repository,
      createId: () => "member-versioned",
      validateUpstreamUrl,
    });

    await expect(service.saveMember(apiInput())).resolves.toEqual({
      id: "member-versioned",
      adapterVersion: { id: "adapter-v2", revision: 2 },
    });
  });

  it("把版本 CAS 与跨凭据域占用映射为稳定冲突", async () => {
    const service = createBackendMemberService({
      repository,
      validateUpstreamUrl,
    });
    repository.saveMember.mockResolvedValueOnce({
      status: "version_conflict",
    });
    await expect(
      service.saveMember(apiInput({ id: "member-existing" }))
    ).rejects.toMatchObject({
      code: "conflict",
      message: "API 账号配置已被其他管理员更新，请刷新后重试",
    });

    repository.saveMember.mockResolvedValueOnce({
      status: "credential_scope_conflict",
    });
    await expect(
      service.saveMember(apiInput({ id: "member-existing" }))
    ).rejects.toMatchObject({
      code: "conflict",
      message: "当前仍有使用旧凭据域的任务或租约，不能切换上游地址或认证方式",
    });
  });

  it("默认地址解析允许保存 HTTP 私网上游", async () => {
    const service = createBackendMemberService({
      repository,
      createId: () => "member-private",
      now: () => NOW,
    });

    await expect(
      service.saveMember(
        apiInput({
          config: {
            baseUrl: "http://10.0.0.8:8080/v1",
            apiKey: "secret-api-key",
            useStream: false,
            modelMappings: [],
          },
        })
      )
    ).resolves.toEqual({ id: "member-private" });
    expect(repository.saveMember).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          baseUrl: "http://10.0.0.8:8080/v1",
        }),
      }),
      NOW
    );
  });

  it("编辑成员保留明确 ID 并允许 secret 留空由仓储沿用", async () => {
    const service = createBackendMemberService({
      repository,
      now: () => NOW,
      validateUpstreamUrl,
    });
    const input = apiInput({
      id: "member-existing",
      config: {
        baseUrl: "https://images.example.com/v1",
        modelMappings: [],
        expectedCurrentVersionId: "adapter-current",
      },
    });

    await service.saveMember(input);

    expect(repository.saveMember).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "member-existing",
        isCreate: false,
        config: expect.not.objectContaining({ apiKey: expect.anything() }),
      }),
      NOW
    );
  });

  it("拒绝重复分组且不进入仓储事务", async () => {
    const service = createBackendMemberService({
      repository,
      validateUpstreamUrl,
    });

    const error = await service
      .saveMember(apiInput({ groupIds: ["group-a", "group-a"] }))
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BackendMemberServiceError);
    expect(error).toMatchObject({ code: "validation_error" });
    expect(repository.saveMember).not.toHaveBeenCalled();
  });

  it("将跨类型编辑映射为要求删除重建的冲突", async () => {
    repository.saveMember.mockResolvedValue({ status: "type_conflict" });
    const service = createBackendMemberService({
      repository,
      validateUpstreamUrl,
    });

    const error = await service
      .saveMember(apiInput({ id: "member-existing" }))
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "conflict",
      message: "成员类型不可原地修改，请删除后重新创建",
    });
  });

  it("新成员缺少 secret 时返回稳定校验错误", async () => {
    repository.saveMember.mockResolvedValue({ status: "missing_secret" });
    const service = createBackendMemberService({
      repository,
      validateUpstreamUrl,
    });

    const error = await service
      .saveMember(apiInput())
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "validation_error",
      message: "新成员必须提供上游凭据",
    });
  });

  it("有效租约或未完成视频存在时拒绝删除", async () => {
    repository.deleteMember.mockResolvedValue("busy");
    const service = createBackendMemberService({
      repository,
      now: () => NOW,
      validateUpstreamUrl,
    });

    const error = await service
      .deleteMember("member-busy")
      .catch((cause: unknown) => cause);

    expect(repository.deleteMember).toHaveBeenCalledWith("member-busy", NOW);
    expect(error).toMatchObject({ code: "conflict" });
  });

  it("按统一成员 ID 重置运行状态并使用服务端时间", async () => {
    const service = createBackendMemberService({
      repository,
      now: () => NOW,
      validateUpstreamUrl,
    });

    await expect(
      service.resetMemberStatus("member-unhealthy")
    ).resolves.toEqual({ success: true });
    expect(repository.resetMemberStatus).toHaveBeenCalledWith(
      "member-unhealthy",
      NOW
    );
  });

  it("重置不存在的成员时返回稳定 not_found", async () => {
    repository.resetMemberStatus.mockResolvedValue("not_found");
    const service = createBackendMemberService({
      repository,
      now: () => NOW,
      validateUpstreamUrl,
    });

    const error = await service
      .resetMemberStatus("missing-member")
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "not_found",
      message: "媒体后端成员不存在",
    });
  });

  it("按统一成员 ID 原子修改启用状态并使用服务端时间", async () => {
    const service = createBackendMemberService({
      repository,
      now: () => NOW,
      validateUpstreamUrl,
    });

    await expect(
      service.setMemberEnabled("member-api", false)
    ).resolves.toEqual({ id: "member-api", isEnabled: false });
    expect(repository.setMemberEnabled).toHaveBeenCalledWith(
      "member-api",
      false,
      NOW
    );
  });

  it("修改不存在的成员启用状态时返回稳定 not_found", async () => {
    repository.setMemberEnabled.mockResolvedValue("not_found");
    const service = createBackendMemberService({
      repository,
      now: () => NOW,
      validateUpstreamUrl,
    });

    const error = await service
      .setMemberEnabled("missing-member", false)
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "not_found",
      message: "媒体后端成员不存在",
    });
  });

  it("管理列表只返回脱敏配置存在性", async () => {
    const summary: BackendMemberAdminSummary = {
      id: "member-api",
      name: "API",
      type: "api",
      groupIds: ["group-a"],
      supportedModelIds: ["gpt-image-2"],
      contentSafetyEnabled: true,
      isEnabled: true,
      alwaysActive: false,
      failureCooldownEnabled: true,
      priority: 10,
      concurrency: 5,
      status: "active",
      healthStatus: "healthy",
      inflightCount: 1,
      leaseAcquiredCount: 4,
      createdAt: "2026-07-26T00:00:00.000Z",
      lastAcquiredAt: null,
      lastUsedAt: null,
      lastError: null,
      lastErrorAt: null,
      config: {
        baseUrl: "https://images.example.com/v1",
        hasApiKey: true,
        useStream: false,
        videoSubmissionRetryCount: 2,
        videoProtocolMode: "custom",
        videoInputCapabilities: {
          referenceVideos: false,
          referenceAudios: false,
        },
        videoInputCapabilitiesByModel: {},
        modelMappings: [],
      },
    };
    repository.listMembers.mockResolvedValue([summary]);
    const service = createBackendMemberService({
      repository,
      now: () => NOW,
      validateUpstreamUrl,
    });

    const result = await service.listMembers();

    expect(result).toEqual([summary]);
    expect(JSON.stringify(result)).not.toContain("secret-api-key");
  });
});
