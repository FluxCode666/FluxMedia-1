/**
 * 统一媒体运行时分组信任边界测试。
 *
 * 职责：验证站内显式选择与 API Key 服务端绑定的优先级，覆盖未绑定默认组、
 * 错误 owner/停用 Key、固定分组漂移和外部覆盖尝试的 fail-closed 行为。
 * 使用方：apps/web DB-free Vitest 门禁；数据库查询本身由参数化 SQL 实现。
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  type RuntimeGroupSelectionInput,
  selectRuntimeBackendGroupCandidate,
  selectTrustedRuntimeGroupTarget,
} from "./runtime-group-selection";
import { canRuntimeBackendLeaseServeRequest } from "./runtime-protocol-eligibility";
import { inspectRuntimeVideoBackendAvailability } from "./runtime-service";
import { projectConfiguredVideoModelIds } from "./runtime-video-reachability";

/** 构造只覆盖分组信任边界所需的最小运行时输入。 */
function runtimeInput(
  overrides: Partial<RuntimeGroupSelectionInput> = {}
): RuntimeGroupSelectionInput {
  return {
    ...overrides,
  };
}

describe("selectTrustedRuntimeGroupTarget", () => {
  it("允许站内用户显式选择分组", () => {
    expect(
      selectTrustedRuntimeGroupTarget(
        runtimeInput({ requestedGroupId: "group-user" })
      )
    ).toEqual({ targetGroupId: "group-user", isUserRequested: true });
  });

  it("API Key 绑定组覆盖默认选择且允许同组辅助编辑", () => {
    expect(
      selectTrustedRuntimeGroupTarget(runtimeInput({ apiKeyId: "key-1" }), {
        groupId: "group-bound",
      })
    ).toEqual({ targetGroupId: "group-bound", isUserRequested: false });
    expect(
      selectTrustedRuntimeGroupTarget(
        runtimeInput({ apiKeyId: "key-1", pinnedGroupId: "group-bound" }),
        { groupId: "group-bound" }
      )
    ).toEqual({ targetGroupId: "group-bound", isUserRequested: false });
  });

  it("未绑定 API Key 回退默认组或服务端固定的默认组", () => {
    expect(
      selectTrustedRuntimeGroupTarget(runtimeInput({ apiKeyId: "key-1" }), {
        groupId: null,
      })
    ).toEqual({ targetGroupId: undefined, isUserRequested: false });
    expect(
      selectTrustedRuntimeGroupTarget(
        runtimeInput({ apiKeyId: "key-1", pinnedGroupId: "group-default" }),
        { groupId: null }
      )
    ).toEqual({ targetGroupId: "group-default", isUserRequested: false });
  });

  it("拒绝无效 Key、客户端覆盖和固定分组漂移", () => {
    expect(() =>
      selectTrustedRuntimeGroupTarget(runtimeInput({ apiKeyId: "key-missing" }))
    ).toThrow(/无效、已停用或不属于/u);
    expect(() =>
      selectTrustedRuntimeGroupTarget(
        runtimeInput({ apiKeyId: "key-1", requestedGroupId: "group-client" }),
        { groupId: "group-bound" }
      )
    ).toThrow(/不能覆盖/u);
    expect(() =>
      selectTrustedRuntimeGroupTarget(
        runtimeInput({ apiKeyId: "key-1", pinnedGroupId: "group-other" }),
        { groupId: "group-bound" }
      )
    ).toThrow(/不一致/u);
  });
});

describe("selectRuntimeBackendGroupCandidate", () => {
  const candidates = [
    {
      id: "group-first",
      isDefault: false,
      isUserSelectable: true,
    },
    {
      id: "group-default",
      isDefault: true,
      isUserSelectable: false,
    },
  ];

  it("无显式目标时只选择唯一默认组，不回退列表首项", () => {
    expect(selectRuntimeBackendGroupCandidate(candidates, {})).toEqual(
      candidates[1]
    );
    expect(() =>
      selectRuntimeBackendGroupCandidate(
        candidates.map((candidate) => ({
          ...candidate,
          isDefault: false,
        })),
        {}
      )
    ).toThrow(/默认/u);
    expect(() =>
      selectRuntimeBackendGroupCandidate(
        candidates.map((candidate) => ({ ...candidate, isDefault: true })),
        {}
      )
    ).toThrow(/多个默认/u);
  });

  it("用户显式选择只检查 isUserSelectable，不读取套餐", () => {
    expect(
      selectRuntimeBackendGroupCandidate(candidates, {
        targetGroupId: "group-first",
        isUserRequested: true,
      })
    ).toEqual(candidates[0]);
    expect(() =>
      selectRuntimeBackendGroupCandidate(candidates, {
        targetGroupId: "group-default",
        isUserRequested: true,
      })
    ).toThrow(/不可由用户选择/u);
  });
});

describe("projectConfiguredVideoModelIds", () => {
  it("API 与 Adobe direct 成员的真实 ID 计入视频配置可达性", () => {
    expect(
      projectConfiguredVideoModelIds([
        {
          memberType: "api",
          adobeMode: null,
          supportedModelIds: ["seedance2"],
        },
        {
          memberType: "adobe",
          adobeMode: "gateway",
          supportedModelIds: ["seedance2-fast"],
        },
        {
          memberType: "adobe",
          adobeMode: "direct",
          supportedModelIds: [
            "SEEDANCE2",
            "seedance2",
            "sora2",
            "firefly-sora2-8s-16x9",
            "unknown-video",
          ],
        },
      ])
    ).toEqual(["seedance2", "sora2"]);
  });

  it("配置可达性不读取健康、冷却、容量或实时租约状态", () => {
    const coolingAndFullMember = {
      memberType: "adobe" as const,
      adobeMode: "direct" as const,
      supportedModelIds: ["seedance2"],
      status: "limited",
      healthStatus: "unhealthy",
      cooldownUntil: "2099-01-01T00:00:00.000Z",
      inflightCount: 10,
      concurrency: 10,
    };

    expect(projectConfiguredVideoModelIds([coolingAndFullMember])).toEqual([
      "seedance2",
    ]);
  });
});

describe("canRuntimeBackendLeaseServeRequest", () => {
  it("API 与 Adobe Direct 可执行视频，Adobe Gateway 不可执行", () => {
    const videoRequest = { requestKind: "video" as const };
    expect(
      canRuntimeBackendLeaseServeRequest(videoRequest, {
        memberType: "api",
        adobeMode: null,
      })
    ).toBe(true);
    expect(
      canRuntimeBackendLeaseServeRequest(videoRequest, {
        memberType: "adobe",
        adobeMode: "direct",
      })
    ).toBe(true);
    expect(
      canRuntimeBackendLeaseServeRequest(videoRequest, {
        memberType: "adobe",
        adobeMode: "gateway",
      })
    ).toBe(false);
  });

  it("蒙版编辑仍只允许 API 账号", () => {
    const maskRequest = { requestKind: "image" as const, requiresMask: true };
    expect(
      canRuntimeBackendLeaseServeRequest(maskRequest, {
        memberType: "api",
        adobeMode: null,
      })
    ).toBe(true);
    expect(
      canRuntimeBackendLeaseServeRequest(maskRequest, {
        memberType: "adobe",
        adobeMode: "direct",
      })
    ).toBe(false);
  });
});

describe("inspectRuntimeVideoBackendAvailability", () => {
  const group = {
    id: "group-1",
    name: "Default",
    priority: 0,
    contentSafetyEnabled: true,
    imageCreditOverrides: {},
    videoCreditOverrides: {},
  };

  it.each([
    [{ eligible_count: 0, available_count: 0 }, "no_candidate"],
    [{ eligible_count: 2, available_count: 0 }, "capacity_rejected"],
    [{ eligible_count: 2, available_count: 1 }, "available"],
  ] as const)("把只读候选计数投影为 %s", async (row, expected) => {
    const execute = async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const compiled = new PgDialect().sqlToQuery(query);
      expect(compiled.sql).toContain("with eligible as");
      expect(compiled.sql).toContain("image_backend_member_lease");
      expect(compiled.sql).not.toContain("insert into");
      expect(compiled.sql).not.toContain("update image_backend_member");
      return { rows: [row] };
    };

    await expect(
      inspectRuntimeVideoBackendAvailability(
        {
          userId: "user-1",
          modelId: "seedance2",
          requiresContentSafety: true,
        },
        { group, database: { execute } }
      )
    ).resolves.toBe(expected);
  });
});
