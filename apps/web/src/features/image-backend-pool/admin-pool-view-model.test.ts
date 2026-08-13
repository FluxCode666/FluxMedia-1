/**
 * 账号池管理列表纯筛选测试。
 *
 * 职责：锁定名称模糊搜索、Adobe Direct 凭据健康、支持模型精确筛选及部署时区
 * 创建日期边界，
 * 不加载 React、数据库或 Server Action。
 */
import { describe, expect, it } from "vitest";

import type { BackendPoolAdminMemberSummary } from "./actions";
import {
  type BackendMemberFilters,
  EMPTY_BACKEND_MEMBER_FILTERS,
  filterBackendGroups,
  filterBackendMembers,
  hasInvalidBackendMemberDateRange,
} from "./admin-pool-view-model";
import type { AdobeCredentialHealthStatus } from "./adobe-credential-health-status";

/** 构造默认合法的 API 供应商账号摘要。 */
function createMember(
  overrides: Partial<BackendPoolAdminMemberSummary> = {}
): BackendPoolAdminMemberSummary {
  return {
    id: "member-api",
    name: "Primary API",
    type: "api",
    groupIds: ["group-a"],
    supportedModelIds: ["gpt-image-2"],
    contentSafetyEnabled: true,
    isEnabled: true,
    alwaysActive: false,
    failureCooldownEnabled: true,
    priority: 10,
    concurrency: 2,
    status: "active",
    healthStatus: "healthy",
    credentialHealthStatus: null,
    inflightCount: 0,
    leaseAcquiredCount: 0,
    createdAt: "2026-08-01T02:00:00.000Z",
    lastAcquiredAt: null,
    lastUsedAt: null,
    lastError: null,
    lastErrorAt: null,
    config: {
      baseUrl: "https://api.example.com",
      hasApiKey: true,
      useStream: false,
      videoSubmissionRetryCount: 2,
      modelMappings: [],
      authentication: { mode: "bearer" },
    },
    ...overrides,
  } as BackendPoolAdminMemberSummary;
}

/** 构造指定凭据健康状态的 Adobe Direct 账号摘要。 */
function createAdobeDirectMember(
  credentialHealthStatus: AdobeCredentialHealthStatus,
  credentialStatus: "active" | "error" | "exhausted" | "invalid" = "active"
): BackendPoolAdminMemberSummary {
  return createMember({
    id: `direct-${credentialHealthStatus}`,
    type: "adobe",
    credentialHealthStatus,
    config: {
      mode: "direct",
      hasCookie: true,
      displayName: null,
      email: null,
      credentialStatus,
      lastRefreshAt: null,
      lastRefreshError: null,
      consecutiveFailures: 0,
      fireflyCredentialStatus: null,
      fireflyLastRefreshAt: null,
      fireflyLastRefreshError: null,
      fireflyConsecutiveFailures: 0,
      creditsTotal: null,
      creditsUsed: null,
      creditsAvailable: null,
      creditsUpdatedAt: null,
      creditsError: null,
      defaultRatio: "1x1",
      defaultResolution: "2k",
      gptImageQuality: "high",
    },
  });
}

/** 基于空值构造单个测试需要的供应商账号筛选。 */
function createFilters(
  overrides: Partial<BackendMemberFilters>
): BackendMemberFilters {
  return { ...EMPTY_BACKEND_MEMBER_FILTERS, ...overrides };
}

describe("admin pool view model", () => {
  it("按分组名称片段进行大小写无关的模糊搜索", () => {
    const groups = [
      { id: "primary", name: "Primary Pool" },
      { id: "backup", name: "备用账号组" },
    ];

    expect(
      filterBackendGroups(
        groups.map((group) => ({
          ...group,
          description: null,
          isEnabled: true,
          isDefault: false,
          isUserSelectable: true,
          contentSafety: "inherit" as const,
          imageCreditOverrides: { version: 1 as const, byModel: {} },
          videoCreditOverrides: {},
          childGroupIds: [],
          priority: 0,
        })),
        "  primary "
      ).map((group) => group.id)
    ).toEqual(["primary"]);
  });

  it("按 Adobe Direct 的真实凭据健康状态筛选", () => {
    const directMembers = (
      ["pending", "healthy", "degraded", "isolated", "overdue"] as const
    ).map((status) => createAdobeDirectMember(status));

    expect(
      filterBackendMembers(
        directMembers,
        createFilters({ credentialStatus: "healthy" }),
        "Asia/Shanghai"
      ).map((member) => member.id)
    ).toEqual(["direct-healthy"]);
    expect(
      filterBackendMembers(
        directMembers,
        createFilters({ credentialStatus: "isolated" }),
        "Asia/Shanghai"
      ).map((member) => member.id)
    ).toEqual(["direct-isolated"]);
    expect(
      filterBackendMembers(
        directMembers,
        createFilters({ credentialStatus: "unhealthy" }),
        "Asia/Shanghai"
      ).map((member) => member.id)
    ).toEqual(["direct-degraded", "direct-isolated", "direct-overdue"]);
  });

  it("将非 Adobe Direct 账号归入凭据健康不适用", () => {
    const gateway = createMember({
      id: "gateway",
      type: "adobe",
      config: {
        mode: "gateway",
        baseUrl: "https://adobe.example.com",
        hasApiKey: true,
        defaultRatio: "1x1",
        defaultResolution: "2k",
        gptImageQuality: "high",
      },
    });

    expect(
      filterBackendMembers(
        [createMember(), gateway, createAdobeDirectMember("healthy")],
        createFilters({ credentialStatus: "not_applicable" }),
        "Asia/Shanghai"
      ).map((member) => member.id)
    ).toEqual(["member-api", "gateway"]);
  });

  it("凭据健康筛选不混入缓存 Token 或最近调用质量", () => {
    const direct = createAdobeDirectMember("healthy", "invalid");
    direct.healthStatus = "unhealthy";

    expect(
      filterBackendMembers(
        [direct],
        createFilters({ credentialStatus: "healthy" }),
        "Asia/Shanghai"
      )
    ).toEqual([direct]);
  });

  it("组合名称和支持模型筛选并保持服务端顺序", () => {
    const members = [
      createMember({
        id: "first",
        name: "Seedance Primary",
        supportedModelIds: ["Seedance2", "gpt-image-2"],
      }),
      createMember({
        id: "second",
        name: "seedance Backup",
        supportedModelIds: ["gpt-image-2"],
      }),
    ];

    expect(
      filterBackendMembers(
        members,
        createFilters({ name: " DANCE ", modelId: "seedance2" }),
        "Asia/Shanghai"
      ).map((member) => member.id)
    ).toEqual(["first"]);
  });

  it("按部署时区自然日包含创建时间范围的两端", () => {
    const beforeMidnightUtc = createMember({
      id: "shanghai-august",
      createdAt: "2026-07-31T16:30:00.000Z",
    });
    const previousShanghaiDay = createMember({
      id: "shanghai-july",
      createdAt: "2026-07-31T15:59:59.999Z",
    });

    expect(
      filterBackendMembers(
        [beforeMidnightUtc, previousShanghaiDay],
        createFilters({
          createdFrom: "2026-08-01",
          createdTo: "2026-08-01",
        }),
        "Asia/Shanghai"
      ).map((member) => member.id)
    ).toEqual(["shanghai-august"]);
  });

  it("拒绝起点晚于终点的日期范围", () => {
    const filters = createFilters({
      createdFrom: "2026-08-02",
      createdTo: "2026-08-01",
    });

    expect(hasInvalidBackendMemberDateRange(filters)).toBe(true);
    expect(filterBackendMembers([createMember()], filters, "UTC")).toEqual([]);
  });

  it("支持单边创建日期范围并在非法时区时安全回退 UTC", () => {
    const members = [
      createMember({ id: "july", createdAt: "2026-07-31T23:00:00.000Z" }),
      createMember({ id: "august", createdAt: "2026-08-01T00:00:00.000Z" }),
    ];

    expect(
      filterBackendMembers(
        members,
        createFilters({ createdFrom: "2026-08-01" }),
        "Invalid/TimeZone"
      ).map((member) => member.id)
    ).toEqual(["august"]);
    expect(
      filterBackendMembers(
        members,
        createFilters({ createdTo: "2026-07-31" }),
        "UTC"
      ).map((member) => member.id)
    ).toEqual(["july"]);
  });

  it("启用日期筛选时拒绝非法成员创建时间", () => {
    const invalidMember = createMember({ createdAt: "not-a-date" });

    expect(
      filterBackendMembers(
        [invalidMember],
        createFilters({ createdFrom: "2026-08-01" }),
        "UTC"
      )
    ).toEqual([]);
  });
});
