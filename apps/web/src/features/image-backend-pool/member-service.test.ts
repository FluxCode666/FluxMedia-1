/**
 * 统一媒体后端成员服务测试。
 *
 * 职责：以 DB-free 仓储端口锁定新增/编辑、类型不可变、secret 保留、URL 安全、
 * 分组关系与运行中任务删除保护；数据库事务细节由集成测试覆盖。
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  type BackendMemberAdminSummary,
  type BackendMemberRepository,
  BackendMemberServiceError,
  createBackendMemberService,
} from "./member-service";

const NOW = new Date("2026-07-26T00:00:00.000Z");

/** 构造只记录调用的仓储，单个测试按需覆盖返回值。 */
function createRepository(): BackendMemberRepository & {
  saveMember: ReturnType<typeof vi.fn>;
  listMembers: ReturnType<typeof vi.fn>;
  deleteMember: ReturnType<typeof vi.fn>;
} {
  return {
    saveMember: vi.fn(async (input) => ({
      status: "saved" as const,
      id: input.id,
    })),
    listMembers: vi.fn(async () => []),
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
      parameterMappings: [],
    },
    ...overrides,
  };
}

describe("backend member service", () => {
  let repository: ReturnType<typeof createRepository>;
  let validateUpstreamUrl: Mock<(url: string) => Promise<unknown>>;
  let prepareAdobeDirectCredential: Mock<
    (
      cookie: string,
      scope?: string
    ) => Promise<{
      accessToken: string;
      accountUserId: string | null;
      displayName: string | null;
      email: string | null;
      expiresAt: Date | null;
      creditsTotal: number | null;
      creditsUsed: number | null;
      creditsAvailable: number | null;
      creditsUpdatedAt: Date;
      creditsError: string | null;
    }>
  >;

  beforeEach(() => {
    repository = createRepository();
    validateUpstreamUrl = vi.fn(
      async (_url: string) => new URL("https://example.com")
    );
    prepareAdobeDirectCredential = vi.fn(async () => ({
      accessToken: "access-token",
      accountUserId: "adobe-user-1",
      displayName: "Adobe User",
      email: "user@example.com",
      expiresAt: new Date("2026-07-26T01:00:00.000Z"),
      creditsTotal: 4_000,
      creditsUsed: 1_500,
      creditsAvailable: 2_500,
      creditsUpdatedAt: NOW,
      creditsError: null,
    }));
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
            parameterMappings: [],
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
        parameterMappings: [],
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

  it("Adobe direct 新增时校验单一 Cookie 并把凭据交给一对一配置仓储", async () => {
    const service = createBackendMemberService({
      repository,
      createId: () => "adobe-direct",
      now: () => NOW,
      validateUpstreamUrl,
      prepareAdobeDirectCredential,
    });

    await service.saveMember({
      type: "adobe",
      name: "Adobe Direct",
      groupIds: ["group-a"],
      supportedModelIds: ["seedance2"],
      contentSafetyEnabled: true,
      isEnabled: true,
      alwaysActive: false,
      failureCooldownEnabled: true,
      priority: 10,
      concurrency: 2,
      config: {
        mode: "direct",
        cookie: "cookie-secret",
        scope: "openid,AdobeID",
        defaultRatio: "1x1",
        defaultResolution: "2k",
        gptImageQuality: "high",
      },
    });

    expect(validateUpstreamUrl).not.toHaveBeenCalled();
    expect(prepareAdobeDirectCredential).toHaveBeenCalledWith(
      "cookie-secret",
      "openid,AdobeID"
    );
    expect(repository.saveMember).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "adobe-direct",
        type: "adobe",
        config: expect.objectContaining({
          mode: "direct",
          cookie: "cookie-secret",
        }),
        directCredential: expect.objectContaining({
          accessToken: "access-token",
          accountUserId: "adobe-user-1",
          creditsTotal: 4_000,
          creditsUsed: 1_500,
          creditsAvailable: 2_500,
          creditsError: null,
        }),
      }),
      NOW
    );
  });

  it("Adobe direct 导入扩展 JSON 时仅持久化其中的 Cookie", async () => {
    const service = createBackendMemberService({
      repository,
      createId: () => "adobe-direct-json",
      now: () => NOW,
      validateUpstreamUrl,
      prepareAdobeDirectCredential,
    });

    await service.saveMember({
      type: "adobe",
      name: "Adobe Direct",
      groupIds: ["group-a"],
      supportedModelIds: ["gpt-image-2"],
      contentSafetyEnabled: true,
      isEnabled: true,
      alwaysActive: false,
      failureCooldownEnabled: true,
      priority: 10,
      concurrency: 2,
      config: {
        mode: "direct",
        cookie: JSON.stringify({
          cookie: "aux_sid=abc; ims=def",
          headers: { "x-arp-session-id": "session-value" },
        }),
        defaultRatio: "1x1",
        defaultResolution: "2k",
        gptImageQuality: "high",
      },
    });

    expect(prepareAdobeDirectCredential).toHaveBeenCalledWith(
      "aux_sid=abc; ims=def",
      undefined
    );
    expect(repository.saveMember).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          cookie: "aux_sid=abc; ims=def",
        }),
      }),
      NOW
    );
  });

  it("Adobe direct Cookie 校验失败时不写入成员", async () => {
    prepareAdobeDirectCredential.mockRejectedValue(
      new Error("upstream rejected cookie")
    );
    const service = createBackendMemberService({
      repository,
      createId: () => "adobe-direct",
      validateUpstreamUrl,
      prepareAdobeDirectCredential,
    });

    const error = await service
      .saveMember({
        type: "adobe",
        name: "Adobe Direct",
        groupIds: ["group-a"],
        supportedModelIds: ["gpt-image-2"],
        contentSafetyEnabled: true,
        isEnabled: true,
        alwaysActive: false,
        failureCooldownEnabled: true,
        priority: 10,
        concurrency: 2,
        config: {
          mode: "direct",
          cookie: "invalid-cookie",
          defaultRatio: "1x1",
          defaultResolution: "2k",
          gptImageQuality: "high",
        },
      })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "validation_error",
      message: "Adobe Cookie 无法通过账号校验",
    });
    expect(repository.saveMember).not.toHaveBeenCalled();
  });

  it("Adobe direct 编辑未更新 Cookie 时不访问 Adobe 且沿用既有凭据", async () => {
    const service = createBackendMemberService({
      repository,
      now: () => NOW,
      validateUpstreamUrl,
      prepareAdobeDirectCredential,
    });

    await service.saveMember({
      id: "adobe-direct",
      type: "adobe",
      name: "Adobe Direct",
      groupIds: ["group-a"],
      supportedModelIds: ["gpt-image-2"],
      contentSafetyEnabled: true,
      isEnabled: true,
      alwaysActive: false,
      failureCooldownEnabled: true,
      priority: 10,
      concurrency: 2,
      config: {
        mode: "direct",
        defaultRatio: "1x1",
        defaultResolution: "2k",
        gptImageQuality: "high",
      },
    });

    expect(prepareAdobeDirectCredential).not.toHaveBeenCalled();
    expect(repository.saveMember).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "adobe-direct",
        isCreate: false,
      }),
      NOW
    );
    expect(repository.saveMember.mock.calls[0]?.[0]).not.toHaveProperty(
      "directCredential"
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
      lastAcquiredAt: null,
      lastUsedAt: null,
      lastError: null,
      lastErrorAt: null,
      config: {
        baseUrl: "https://images.example.com/v1",
        hasApiKey: true,
        useStream: false,
        parameterMappings: [],
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
