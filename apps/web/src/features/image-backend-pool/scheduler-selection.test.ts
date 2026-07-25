import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const schemaMock = vi.hoisted(() => {
  const column = (tableName: string, columnName: string) => ({
    __columnName: columnName,
    __tableName: tableName,
  });
  const table = <T extends readonly string[]>(tableName: string, columns: T) =>
    Object.fromEntries([
      ["__tableName", tableName],
      ...columns.map((name) => [name, column(tableName, name)]),
    ]);

  return {
    externalApiKey: table("external_api_key", ["id", "generationGroupId"]),
    imageBackendApiGroup: table("image_backend_api_group", [
      "apiId",
      "groupId",
    ]),
    imageBackendApi: table("image_backend_api", [
      "id",
      "groupId",
      "name",
      "mode",
      "baseUrl",
      "apiKey",
      "model",
      "supportedModelIds",
      "interfaceMode",
      "chatCompletionsUpstreamMode",
      "imageUpstreamMode",
      "useStream",
      "contentSafetyEnabled",
      "isEnabled",
      "alwaysActive",
      "priority",
      "concurrency",
      "failureCooldownEnabled",
      "successCount",
      "failCount",
      "status",
      "lastUsedAt",
      "lastAcquiredAt",
      "cooldownUntil",
      "lastError",
      "lastErrorAt",
      "metadata",
      "createdAt",
      "updatedAt",
    ]),
    imageBackendAdobe: table("image_backend_adobe", [
      "id",
      "groupId",
      "name",
      "baseUrl",
      "apiKey",
      "enabledModels",
      "defaultRatio",
      "defaultResolution",
      "gptImageQuality",
      "supportsVideo",
      "contentSafetyEnabled",
      "isEnabled",
      "alwaysActive",
      "priority",
      "concurrency",
      "failureCooldownEnabled",
      "successCount",
      "failCount",
      "status",
      "lastUsedAt",
      "lastAcquiredAt",
      "cooldownUntil",
      "lastError",
      "lastErrorAt",
      "metadata",
      "createdAt",
      "updatedAt",
    ]),
    imageBackendAdobeGroup: table("image_backend_adobe_group", [
      "adobeId",
      "groupId",
    ]),
    imageBackendGroup: table("image_backend_group", [
      "id",
      "name",
      "description",
      "isEnabled",
      "isDefault",
      "isUserSelectable",
      "contentSafetyEnabled",
      "priority",
      "metadata",
      "createdAt",
      "updatedAt",
    ]),
    imageBackendInflightLease: table("image_backend_inflight_lease", [
      "id",
      "memberType",
      "memberId",
      "expiresAt",
      "createdAt",
    ]),
    imageBackendStickyBinding: table("image_backend_sticky_binding", [
      "id",
      "scope",
      "bindingKey",
      "memberType",
      "memberId",
      "groupId",
      "accountBackend",
      "expiresAt",
      "lastHitAt",
      "hitCount",
      "metadata",
      "createdAt",
      "updatedAt",
    ]),
    imageBackendSchedulerMetric: table("image_backend_scheduler_metric", [
      "id",
      "bucketStartedAt",
      "requestKind",
      "selectedLayer",
      "memberType",
      "memberId",
      "groupId",
      "selectCount",
      "stickyPreviousHitCount",
      "stickySessionHitCount",
      "loadBalanceCount",
      "switchCount",
      "candidateCountTotal",
      "latencyMsTotal",
      "metadata",
      "createdAt",
      "updatedAt",
    ]),
    systemSetting: table("system_setting", ["key", "value"]),
  };
});

const dbMock = vi.hoisted(() => {
  const state = {
    groups: [] as Row[],
    apis: [] as Row[],
    adobes: [] as Row[],
    externalApiKeys: [] as Row[],
    stickyBindings: [] as Row[],
    schedulerMetrics: [] as Row[],
    leases: [] as Row[],
    filterGroupSelects: false,
    lockedLastAcquiredAtById: new Map<string, Date | null>(),
    limitCalls: [] as { tableName: string; limit: number }[],
    updates: [] as { tableName: string; values: Row }[],
    inserts: [] as { tableName: string; values: Row }[],
    executeCalls: [] as unknown[],
  };

  const tableNameOf = (table: unknown) =>
    typeof table === "object" && table && "__tableName" in table
      ? String((table as { __tableName: string }).__tableName)
      : "";

  const rowsForTable = (tableName: string) => {
    switch (tableName) {
      case "external_api_key":
        return state.externalApiKeys;
      case "image_backend_api":
        return state.apis;
      case "image_backend_adobe":
        return state.adobes;
      case "image_backend_group":
        return state.groups;
      case "image_backend_sticky_binding":
        return state.stickyBindings;
      case "image_backend_scheduler_metric":
        return state.schedulerMetrics;
      case "image_backend_inflight_lease":
        return state.leases;
      default:
        return [];
    }
  };

  const simplePredicateValue = (predicate: unknown, columnName: string) => {
    if (
      typeof predicate !== "object" ||
      !predicate ||
      !("kind" in predicate) ||
      !("values" in predicate) ||
      (predicate as { kind: unknown }).kind !== "eq"
    ) {
      return undefined;
    }
    const values = (predicate as { values: unknown[] }).values;
    const column = values[0];
    if (
      typeof column === "object" &&
      column &&
      "__columnName" in column &&
      (column as { __columnName: string }).__columnName === columnName
    ) {
      return values[1];
    }
    return undefined;
  };

  const findPredicateValue = (
    predicate: unknown,
    columnName: string
  ): unknown => {
    const value = simplePredicateValue(predicate, columnName);
    if (value !== undefined) return value;
    if (
      typeof predicate === "object" &&
      predicate &&
      "values" in predicate &&
      Array.isArray((predicate as { values: unknown[] }).values)
    ) {
      for (const child of (predicate as { values: unknown[] }).values) {
        const childValue = findPredicateValue(child, columnName);
        if (childValue !== undefined) return childValue;
      }
    }
    return undefined;
  };

  const createSelectBuilder = (options?: { filterByWhere?: boolean }) => {
    let tableName = "";
    let limitValue: number | null = null;
    let wherePredicate: unknown;
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn((table: unknown) => {
      tableName = tableNameOf(table);
      return builder;
    });
    builder.innerJoin = vi.fn(() => builder);
    builder.where = vi.fn((predicate: unknown) => {
      wherePredicate = predicate;
      return builder;
    });
    builder.orderBy = vi.fn(() => builder);
    builder.groupBy = vi.fn(() => builder);
    builder.for = vi.fn(() => builder);
    builder.limit = vi.fn((limit: number) => {
      limitValue = limit;
      state.limitCalls.push({ tableName, limit });
      return builder;
    });
    // biome-ignore lint/suspicious/noThenProperty: drizzle query mocks need to be awaitable.
    builder.then = (
      resolve: (value: Row[]) => unknown,
      reject?: (reason: unknown) => unknown
    ) => {
      let rows = rowsForTable(tableName);
      const shouldFilterByWhere =
        options?.filterByWhere ||
        (state.filterGroupSelects && tableName === "image_backend_group");
      if (shouldFilterByWhere) {
        const id = findPredicateValue(wherePredicate, "id");
        const memberType = findPredicateValue(wherePredicate, "memberType");
        const memberId = findPredicateValue(wherePredicate, "memberId");
        const isEnabled = findPredicateValue(wherePredicate, "isEnabled");
        const isDefault = findPredicateValue(wherePredicate, "isDefault");
        rows = rows.filter((row) => {
          if (id !== undefined && row.id !== id) return false;
          if (memberType !== undefined && row.memberType !== memberType) {
            return false;
          }
          if (memberId !== undefined && row.memberId !== memberId) {
            return false;
          }
          if (isEnabled !== undefined && row.isEnabled !== isEnabled) {
            return false;
          }
          if (isDefault !== undefined && row.isDefault !== isDefault) {
            return false;
          }
          return true;
        });
        if (
          id !== undefined &&
          tableName === "image_backend_api" &&
          state.lockedLastAcquiredAtById.has(String(id))
        ) {
          const lockedLastAcquiredAt = state.lockedLastAcquiredAtById.get(
            String(id)
          );
          for (const row of rowsForTable(tableName)) {
            if (row.id === id) {
              row.lastAcquiredAt = lockedLastAcquiredAt;
            }
          }
          rows = rows.map((row) =>
            row.id === id
              ? { ...row, lastAcquiredAt: lockedLastAcquiredAt }
              : row
          );
        }
      }
      rows = limitValue === null ? rows : rows.slice(0, limitValue);
      return Promise.resolve(rows).then(resolve, reject);
    };
    return builder;
  };

  const createUpdateBuilder = (table: unknown) => {
    const tableName = tableNameOf(table);
    let updateValues: Row = {};
    const builder: Record<string, unknown> = {};
    builder.set = vi.fn((values: Row) => {
      updateValues = values;
      state.updates.push({ tableName, values });
      return builder;
    });
    builder.where = vi.fn(async (predicate: unknown) => {
      const rows = rowsForTable(tableName);
      const id = findPredicateValue(predicate, "id");
      for (const row of rows) {
        if (id !== undefined && row.id !== id) continue;
        Object.assign(row, updateValues);
      }
      return undefined;
    });
    return builder;
  };

  const createInsertBuilder = (table: unknown) => {
    const tableName = tableNameOf(table);
    const builder: Record<string, unknown> = {};
    builder.values = vi.fn((values: Row) => {
      state.inserts.push({ tableName, values });
      if (tableName === "image_backend_inflight_lease") {
        state.leases.push(values);
      }
      return builder;
    });
    builder.onConflictDoUpdate = vi.fn(async () => undefined);
    return builder;
  };

  return {
    state,
    db: {
      select: vi.fn(() => createSelectBuilder()),
      update: vi.fn((table: unknown) => createUpdateBuilder(table)),
      insert: vi.fn((table: unknown) => createInsertBuilder(table)),
      execute: vi.fn(async (query: unknown) => {
        state.executeCalls.push(query);
        return [];
      }),
      transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
        const tx = {
          select: vi.fn(() => createSelectBuilder({ filterByWhere: true })),
          update: vi.fn((table: unknown) => createUpdateBuilder(table)),
          insert: vi.fn((table: unknown) => createInsertBuilder(table)),
          delete: vi.fn((table: unknown) => ({
            where: vi.fn(async (predicate: unknown) => {
              const tableName = tableNameOf(table);
              if (tableName === "image_backend_inflight_lease") {
                const memberType = findPredicateValue(predicate, "memberType");
                const memberId = findPredicateValue(predicate, "memberId");
                state.leases = state.leases.filter((lease) => {
                  if (
                    memberType !== undefined &&
                    lease.memberType !== memberType
                  ) {
                    return true;
                  }
                  if (memberId !== undefined && lease.memberId !== memberId) {
                    return true;
                  }
                  return false;
                });
              }
            }),
          })),
          execute: vi.fn(async (query: unknown) => {
            state.executeCalls.push(query);
            return [];
          }),
        };
        return await callback(tx);
      }),
    },
  };
});

vi.mock("@repo/database", () => ({
  db: dbMock.db,
}));

vi.mock("@repo/database/schema", () => schemaMock);

vi.mock("drizzle-orm", () => {
  const predicate = (kind: string, values: unknown[]) => ({ kind, values });
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    kind: "sql",
    strings,
    values,
  });
  return {
    and: (...values: unknown[]) => predicate("and", values),
    asc: (...values: unknown[]) => predicate("asc", values),
    count: (...values: unknown[]) => predicate("count", values),
    desc: (...values: unknown[]) => predicate("desc", values),
    eq: (...values: unknown[]) => predicate("eq", values),
    gt: (...values: unknown[]) => predicate("gt", values),
    inArray: (...values: unknown[]) => predicate("inArray", values),
    isNull: (...values: unknown[]) => predicate("isNull", values),
    lt: (...values: unknown[]) => predicate("lt", values),
    notInArray: (...values: unknown[]) => predicate("notInArray", values),
    or: (...values: unknown[]) => predicate("or", values),
    sql,
  };
});

vi.mock("@repo/shared/config/subscription-plan", () => ({
  isPlanAtLeast: vi.fn(() => true),
  normalizeSubscriptionPlan: vi.fn(
    (_value: unknown, fallback: string) => fallback
  ),
}));

vi.mock("@repo/shared/image-backend/nested-groups", () => ({
  validateNestedGroupConfig: vi.fn(() => ({ ok: true })),
}));

vi.mock("@repo/shared/logger", () => ({
  logWarn: vi.fn(),
}));

vi.mock("@repo/shared/subscription/services/plan-capabilities", () => ({
  canUsePlanCapability: vi.fn(() => true),
}));

vi.mock("@repo/shared/subscription/services/user-plan", () => ({
  getUserPlan: vi.fn(async () => ({ plan: "ultra" })),
}));

vi.mock("@repo/shared/system-settings", () => ({
  clearSystemSettingsCache: vi.fn(),
  getRuntimeSettingBoolean: vi.fn(
    async (_key: string, fallback = false) => fallback
  ),
  getRuntimeSettingJson: vi.fn(async () => undefined),
  getRuntimeSettingNumber: vi.fn(
    async (_key: string, fallback: number) => fallback
  ),
  getRuntimeSettingSelect: vi.fn(
    async (_key: string, fallback: string) => fallback
  ),
  getRuntimeSettingString: vi.fn(async () => ""),
}));

import { isPlanAtLeast } from "@repo/shared/config/subscription-plan";
import { canUsePlanCapability } from "@repo/shared/subscription/services/plan-capabilities";
import { getRuntimeSettingBoolean } from "@repo/shared/system-settings";
import {
  reportImageBackendResult,
  resetImageBackendInflightForTests,
  resolveImageBackendPoolConfig,
} from "./service";

/** 构造可被池调度器选择的 API 后端测试行。 */
function makeApi(index: number, overrides: Row = {}) {
  return {
    matchedGroupId: "group-a",
    id: `api-${index}`,
    groupId: null,
    name: `API ${index}`,
    baseUrl: "https://api.example.test/v1",
    apiKey: `api-key-${index}`,
    model: null,
    supportedModelIds: [],
    interfaceMode: "mixed",
    chatCompletionsUpstreamMode: "responses",
    imageUpstreamMode: "images",
    parameterMappings: [],
    useStream: false,
    adobeSourced: false,
    contentSafetyEnabled: true,
    priority: 10,
    concurrency: 10,
    lastUsedAt: null,
    lastAcquiredAt: null,
    createdAt: new Date(2026, 0, index),
    metadata: null,
    ...overrides,
  };
}

function makeAdobe(index: number, overrides: Row = {}) {
  return {
    matchedGroupId: "group-a",
    id: `adobe-${index}`,
    groupId: null,
    name: `Adobe ${index}`,
    mode: "direct",
    baseUrl: "https://firefly.example.test",
    apiKey: "adobe-key",
    enabledModels: null,
    defaultRatio: "1x1",
    defaultResolution: "2k",
    gptImageQuality: "high",
    supportsVideo: false,
    contentSafetyEnabled: true,
    priority: 10,
    concurrency: 10,
    lastUsedAt: null,
    lastAcquiredAt: null,
    createdAt: new Date(2026, 0, index),
    metadata: null,
    ...overrides,
  };
}

/**
 * 验证同一请求的隐式默认分组在默认配置切换后仍被可信固定。
 *
 * @param apiKeyId - 可选的未绑定 generationGroupId 的 API Key。
 * @returns 默认 A 的首次解析和固定重解析均会断言成功。
 * @remarks 测试同时验证固定组不是用户手选分组，因而不应调用手选能力校验。
 */
async function expectPinnedImplicitDefaultGroupToSurviveDefaultSwitch(
  apiKeyId?: string
) {
  const groupAImageCreditOverrides = {
    version: 1,
    byModel: { "gpt-image-2": { base2kCredits: 6 } },
  };
  dbMock.state.groups = [
    {
      id: "group-a",
      name: "Default A",
      description: null,
      isEnabled: true,
      isDefault: true,
      // 默认组并不要求用户可手选；重试固定它时也必须保持这一语义。
      isUserSelectable: false,
      contentSafetyEnabled: null,
      priority: 1,
      metadata: {
        backendType: "responses",
        imageCreditOverrides: groupAImageCreditOverrides,
      },
      createdAt: new Date(2026, 0, 1),
      updatedAt: new Date(2026, 0, 1),
    },
    {
      id: "group-b",
      name: "Default B",
      description: null,
      isEnabled: true,
      isDefault: false,
      isUserSelectable: true,
      contentSafetyEnabled: null,
      priority: 2,
      metadata: {
        backendType: "responses",
        imageCreditOverrides: {
          version: 1,
          byModel: { "gpt-image-2": { base2kCredits: 99 } },
        },
      },
      createdAt: new Date(2026, 0, 2),
      updatedAt: new Date(2026, 0, 2),
    },
  ];
  dbMock.state.apis = [
    {
      ...makeApi(1),
      matchedGroupId: "group-a",
      groupId: "group-a",
    },
  ];
  dbMock.state.externalApiKeys = apiKeyId
    ? [{ id: apiKeyId, generationGroupId: null }]
    : [];
  // 此测试需让分组查询遵守 where 条件，以确保移除 pin 后会实际命中新的默认 B。
  dbMock.state.filterGroupSelects = true;

  const initial = await resolveImageBackendPoolConfig({
    userId: "user-a",
    requestKind: "image_generation",
    ...(apiKeyId ? { apiKeyId } : {}),
  });

  expect(initial?.config.backend?.apiKeyId).toBe(apiKeyId);
  expect(initial?.config.backend?.billingGroupId).toBe("group-a");
  expect(initial?.config.backend?.imageCreditOverrides).toEqual(
    groupAImageCreditOverrides
  );

  // 模拟首次候选失败期间管理员将默认分组改为 B。固定重解析必须继续路由 A，
  // 而非把 A 当作用户手选分组重新授权。
  resetImageBackendInflightForTests();
  dbMock.state.leases = [];
  const [groupA, groupB] = dbMock.state.groups;
  if (!groupA || !groupB) throw new Error("缺少默认分组切换测试数据");
  dbMock.state.groups = [
    { ...groupB, isDefault: true },
    { ...groupA, isDefault: false },
  ];
  vi.clearAllMocks();
  vi.mocked(canUsePlanCapability).mockResolvedValue(false);

  const retried = await resolveImageBackendPoolConfig({
    userId: "user-a",
    requestKind: "image_generation",
    ...(apiKeyId ? { apiKeyId } : {}),
    pinnedImplicitGroupId: "group-a",
  });

  expect(retried?.groupId).toBe("group-a");
  expect(retried?.config.backend?.apiKeyId).toBe(apiKeyId);
  expect(retried?.config.backend?.billingGroupId).toBe("group-a");
  expect(retried?.config.backend?.imageCreditOverrides).toEqual(
    groupAImageCreditOverrides
  );
  expect(retried?.config.backend?.requestedBackendGroupId).toBeUndefined();
  expect(canUsePlanCapability).not.toHaveBeenCalled();
}

describe("image backend pool scheduler selection", () => {
  beforeEach(() => {
    resetImageBackendInflightForTests();
    dbMock.state.groups = [
      {
        id: "group-a",
        name: "Codex group",
        description: null,
        isEnabled: true,
        isDefault: true,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 1,
        metadata: { backendType: "responses" },
        createdAt: new Date(2026, 0, 1),
        updatedAt: new Date(2026, 0, 1),
      },
    ];
    dbMock.state.apis = [makeApi(1)];
    dbMock.state.adobes = [];
    dbMock.state.externalApiKeys = [];
    dbMock.state.stickyBindings = [];
    dbMock.state.schedulerMetrics = [];
    dbMock.state.leases = [];
    dbMock.state.filterGroupSelects = false;
    dbMock.state.lockedLastAcquiredAtById.clear();
    dbMock.state.limitCalls = [];
    dbMock.state.updates = [];
    dbMock.state.inserts = [];
    dbMock.state.executeCalls = [];
    vi.clearAllMocks();
    vi.mocked(isPlanAtLeast).mockReturnValue(true);
    vi.mocked(canUsePlanCapability).mockResolvedValue(true);
    vi.mocked(getRuntimeSettingBoolean).mockImplementation(
      async (_key: string, fallback = false) => fallback
    );
  });

  it("carries the selected billing group's model price overrides into config", async () => {
    const group = dbMock.state.groups[0];
    if (!group) throw new Error("缺少默认测试分组");
    group.metadata = {
      backendType: "responses",
      imageCreditOverrides: {
        version: 1,
        byModel: { "gpt-image-2": { base2kCredits: 6 } },
      },
      videoCreditOverrides: { sora2: 42 },
    };

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });

    expect(result?.config.backend?.imageCreditOverrides).toEqual({
      version: 1,
      byModel: { "gpt-image-2": { base2kCredits: 6 } },
    });
    expect(result?.config.backend?.videoCreditOverrides).toEqual({
      sora2: 42,
    });
  });

  it("默认组切换后，可信固定隐式分组仍保留原组与其图像计费覆盖", async () => {
    await expectPinnedImplicitDefaultGroupToSurviveDefaultSwitch();
  });

  it("未绑定分组的 API Key 在默认组切换后仍保留可信固定隐式分组", async () => {
    await expectPinnedImplicitDefaultGroupToSurviveDefaultSwitch("key-unbound");
  });

  it("respects the configured API concurrency instead of a hardcoded 1", async () => {
    dbMock.state.apis = [
      {
        id: "api-cc",
        groupId: "group-a",
        name: "Concurrent API",
        baseUrl: "https://api.example.test/v1",
        apiKey: "key",
        model: null,
        interfaceMode: "responses",
        chatCompletionsUpstreamMode: "responses",
        imageUpstreamMode: "responses",
        useStream: false,
        contentSafetyEnabled: true,
        alwaysActive: false,
        priority: 1,
        concurrency: 3,
        lastUsedAt: null,
        createdAt: new Date(2026, 0, 1),
      },
    ];

    // 并发数 3：前三次都能选中（租约不释放，累计在飞 1/2/3），第四次饱和返回 null。
    // 修复前 API 并发写死 1，第二次即 null。
    const picks: (string | undefined)[] = [];
    for (let index = 0; index < 4; index += 1) {
      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });
      picks.push(result?.memberId);
    }
    expect(picks).toEqual(["api-cc", "api-cc", "api-cc", undefined]);
  });

  it("重新授权显式选择的分组，并将其保留到解析配置", async () => {
    dbMock.state.groups = [
      {
        id: "group-selected",
        name: "Selected",
        description: null,
        isEnabled: true,
        isDefault: false,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 1,
        metadata: { backendType: "responses" },
        createdAt: new Date(2026, 0, 1),
        updatedAt: new Date(2026, 0, 1),
      },
      {
        id: "default-group",
        name: "Default",
        description: null,
        isEnabled: true,
        isDefault: true,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 2,
        metadata: { backendType: "responses" },
        createdAt: new Date(2026, 0, 2),
        updatedAt: new Date(2026, 0, 2),
      },
    ];
    dbMock.state.apis = [
      {
        ...makeApi(1),
        matchedGroupId: "group-selected",
        groupId: "group-selected",
      },
    ];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      backendGroupId: "group-selected",
      requestKind: "image_generation",
    });

    expect(result?.groupId).toBe("group-selected");
    expect(result?.config.backend?.requestedBackendGroupId).toBe(
      "group-selected"
    );
  });

  it("拒绝不可选择、禁用或当前套餐无权的显式分组", async () => {
    dbMock.state.groups[0] = {
      ...dbMock.state.groups[0],
      isUserSelectable: false,
    };

    await expect(
      resolveImageBackendPoolConfig({
        userId: "user-a",
        backendGroupId: "group-a",
        requestKind: "image_generation",
      })
    ).rejects.toThrow("所选生图分组不可用、不可手动选择或当前套餐不可用");

    dbMock.state.groups[0] = {
      ...dbMock.state.groups[0],
      isUserSelectable: true,
      isEnabled: false,
    };

    await expect(
      resolveImageBackendPoolConfig({
        userId: "user-a",
        backendGroupId: "group-a",
        requestKind: "image_generation",
      })
    ).rejects.toThrow("所选生图分组不可用、不可手动选择或当前套餐不可用");

    dbMock.state.groups[0] = {
      ...dbMock.state.groups[0],
      isEnabled: true,
    };
    vi.mocked(canUsePlanCapability).mockResolvedValueOnce(false);

    await expect(
      resolveImageBackendPoolConfig({
        userId: "user-a",
        backendGroupId: "group-a",
        requestKind: "image_generation",
      })
    ).rejects.toThrow("当前套餐不支持手动选择生图分组");

    vi.mocked(isPlanAtLeast).mockReturnValueOnce(false);

    await expect(
      resolveImageBackendPoolConfig({
        userId: "user-a",
        backendGroupId: "group-a",
        requestKind: "image_generation",
      })
    ).rejects.toThrow("所选生图分组不可用、不可手动选择或当前套餐不可用");
  });

  it("API Key 路由优先于页面显式分组，未绑定时仍使用平台默认组", async () => {
    dbMock.state.groups = [
      {
        id: "default-group",
        name: "Default",
        description: null,
        isEnabled: true,
        isDefault: true,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 1,
        metadata: { backendType: "responses" },
        createdAt: new Date(2026, 0, 1),
        updatedAt: new Date(2026, 0, 1),
      },
      {
        id: "api-group",
        name: "API",
        description: null,
        isEnabled: true,
        isDefault: false,
        isUserSelectable: false,
        contentSafetyEnabled: true,
        priority: 10,
        metadata: { backendType: "mixed" },
        createdAt: new Date(2026, 0, 2),
        updatedAt: new Date(2026, 0, 2),
      },
    ];
    dbMock.state.externalApiKeys = [{ id: "key-a", generationGroupId: null }];
    dbMock.state.apis = [
      {
        ...makeApi(1),
        matchedGroupId: "default-group",
        groupId: "default-group",
      },
    ];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      apiKeyId: "key-a",
      backendGroupId: "api-group",
      requestKind: "image_generation",
    });

    expect(result?.groupId).toBe("default-group");
    expect(result?.config.backend?.billingGroupId).toBe("default-group");
  });

  it("uses the images upstream switch for responses-only API image requests", async () => {
    const baseApi = {
      id: "api-1",
      groupId: "group-a",
      name: "External Responses",
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      model: "external-chat-model",
      interfaceMode: "responses",
      chatCompletionsUpstreamMode: "responses",
      useStream: false,
      contentSafetyEnabled: true,
      priority: 1,
      concurrency: 1,
      lastUsedAt: null,
      createdAt: new Date(2026, 0, 1),
    };
    dbMock.state.apis = [{ ...baseApi, imageUpstreamMode: "images" }];

    await expect(
      resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      })
    ).resolves.toBeNull();

    dbMock.state.apis = [{ ...baseApi, imageUpstreamMode: "responses" }];
    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });

    expect(result?.memberType).toBe("api");
    expect(result?.memberId).toBe("api-1");
    expect(result?.config.backend).toMatchObject({
      apiInterfaceMode: "responses",
      imagesUpstreamMode: "responses",
    });
  });

  it("reactivates limited API backends after a successful retry", async () => {
    dbMock.state.apis = [
      {
        id: "api-1",
        groupId: "group-a",
        status: "limited",
        cooldownUntil: new Date(2026, 0, 1),
      },
    ];

    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: true,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    expect(update?.values).toMatchObject({
      status: "active",
      cooldownUntil: null,
      lastError: null,
      lastErrorAt: null,
    });
  });

  it("does not cool down external API backends after transient failures by default", async () => {
    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: false,
      error: "HTTP 429 Too many requests",
      retryAfterSeconds: 60,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    expect(update?.values).toMatchObject({
      lastError: "HTTP 429 Too many requests",
      lastErrorAt: expect.any(Date),
    });
    expect(update?.values).not.toHaveProperty("status");
    expect(update?.values).not.toHaveProperty("cooldownUntil");
  });

  it("cools down external API backends when the per-backend toggle is on", async () => {
    // 每后端开关(failureCooldownEnabled)取代旧全局 flag。
    dbMock.state.apis = [
      { id: "api-1", groupId: "group-a", failureCooldownEnabled: true },
    ];

    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: false,
      error: "HTTP 429 Too many requests",
      retryAfterSeconds: 60,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    expect(update?.values).toMatchObject({
      status: "active",
      cooldownUntil: expect.any(Date),
      lastError: "HTTP 429 Too many requests",
      lastErrorAt: expect.any(Date),
    });
  });

  it("still marks external API backends as error for unrecoverable failures", async () => {
    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: false,
      error: "invalid api key authentication failed",
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    expect(update?.values).toMatchObject({
      status: "error",
      cooldownUntil: null,
      lastError: "invalid api key authentication failed",
      lastErrorAt: expect.any(Date),
    });
  });

  it.each([
    [
      "Upstream Responses API returned HTTP 500: 没有可用token | invalid_request_error",
    ],
    ["Upstream Responses API returned HTTP 502: HTML response body. Check ..."],
  ])("marks dead-relay errors as error (sticky out): %s", async (errText) => {
    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: false,
      error: errText,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    expect(update?.values).toMatchObject({
      status: "error",
      cooldownUntil: null,
    });
  });

  it("keeps an errored API out: a later success does not reactivate it", async () => {
    dbMock.state.apis = [
      { id: "api-1", groupId: "group-a", status: "error", alwaysActive: false },
    ];

    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: true,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    // 粘性：成功只记 successCount，不把 status 翻回 active、不清 error。
    expect(update?.values).not.toHaveProperty("status");
    expect(update?.values).not.toHaveProperty("lastError");
  });

  it("always_active errored API still reactivates on success", async () => {
    dbMock.state.apis = [
      { id: "api-1", groupId: "group-a", status: "error", alwaysActive: true },
    ];

    await reportImageBackendResult({
      memberType: "api",
      memberId: "api-1",
      success: true,
    });

    const update = dbMock.state.updates.find(
      (item) => item.tableName === "image_backend_api"
    );
    expect(update?.values).toMatchObject({ status: "active", lastError: null });
  });

  it("routes unscoped requests to the platform default group", async () => {
    // group-b 同样可用，但没有用户偏好这一持久化维度后，未显式指定分组的请求
    // 必须始终使用 group-a（平台默认）。
    dbMock.state.groups = [
      {
        id: "group-a",
        name: "Group A",
        description: null,
        isEnabled: true,
        isDefault: true,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 1,
        metadata: { backendType: "mixed" },
        createdAt: new Date(2026, 0, 1),
        updatedAt: new Date(2026, 0, 1),
      },
      {
        id: "group-b",
        name: "Group B",
        description: null,
        isEnabled: true,
        isDefault: false,
        isUserSelectable: true,
        contentSafetyEnabled: null,
        priority: 2,
        metadata: { backendType: "mixed" },
        createdAt: new Date(2026, 0, 2),
        updatedAt: new Date(2026, 0, 2),
      },
    ];
    const baseApi = {
      id: "api-default",
      groupId: "group-a",
      name: "Default-group API",
      baseUrl: "https://api.example.test/v1",
      apiKey: "key",
      model: null,
      interfaceMode: "mixed",
      chatCompletionsUpstreamMode: "responses",
      imageUpstreamMode: "images",
      useStream: false,
      contentSafetyEnabled: true,
      alwaysActive: false,
      priority: 1,
      concurrency: 10,
      lastUsedAt: null,
      lastAcquiredAt: null,
      createdAt: new Date(2026, 0, 1),
      metadata: null,
    };

    dbMock.state.apis = [{ ...baseApi, matchedGroupId: "group-a" }];
    const fromGroupA = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
    });
    expect(fromGroupA?.memberType).toBe("api");
    expect(fromGroupA?.memberId).toBe("api-default");
    expect(fromGroupA?.groupId).toBe("group-a");
  });

  it("仅把已声明支持请求模型的 API 后端纳入调度", async () => {
    dbMock.state.adobes = [];
    dbMock.state.apis = [
      makeApi(1, {
        priority: 1,
        supportedModelIds: ["nano-banana-pro"],
      }),
      makeApi(2, {
        priority: 2,
        supportedModelIds: ["grok-imagine-image"],
      }),
    ];

    const result = await resolveImageBackendPoolConfig({
      userId: "user-a",
      requestKind: "image_generation",
      requestedModel: "GROK-IMAGINE-IMAGE",
    });

    expect(result?.memberType).toBe("api");
    expect(result?.memberId).toBe("api-2");
  });

  // Adobe 与 API 成员参与分组调度的路由语义。
  describe("adobe firefly group-based routing", () => {
    beforeEach(() => {
      dbMock.state.apis = [makeApi(1)];
      dbMock.state.adobes = [makeAdobe(1)];
    });

    it("普通图像请求同组含 Adobe 与 API 时二者都是候选", async () => {
      const first = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });
      const second = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });

      const picked = [first, second].map(
        (r) => `${r?.memberType}:${r?.memberId}`
      );
      expect(picked).toContain("api:api-1");
      expect(picked).toContain("adobe:adobe-1");
    });

    it("低优先级 Adobe 仅在 API 饱和后兜底", async () => {
      dbMock.state.apis = [makeApi(1, { priority: 1, concurrency: 1 })];
      dbMock.state.adobes = [makeAdobe(1, { priority: 50 })];

      const first = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });
      const second = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });

      expect(first?.memberType).toBe("api");
      expect(first?.memberId).toBe("api-1");
      expect(second?.memberType).toBe("adobe");
      expect(second?.memberId).toBe("adobe-1");
    });

    it("带蒙版编辑排除 Adobe，只选择可传递蒙版的 API", async () => {
      const group = dbMock.state.groups[0];
      if (!group) throw new Error("缺少默认测试分组");
      group.metadata = { backendType: "mixed" };
      dbMock.state.apis = [makeApi(2, { priority: 3 })];
      dbMock.state.adobes = [makeAdobe(1, { priority: 1 })];

      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_edit",
        requiresMask: true,
      });

      expect(result?.memberType).toBe("api");
      expect(result?.memberId).toBe("api-2");
      expect(result?.config.backend?.requiresMask).toBe(true);
    });

    it("force_firefly 时只有 Adobe 语义后端是候选", async () => {
      dbMock.state.adobes = [makeAdobe(1, { priority: 50 })];

      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        forceFirefly: true,
      });

      expect(result?.memberType).toBe("adobe");
      expect(result?.memberId).toBe("adobe-1");
    });

    it("force_firefly 但同组无 Adobe 时无可用后端", async () => {
      dbMock.state.adobes = [];

      await expect(
        resolveImageBackendPoolConfig({
          userId: "user-a",
          requestKind: "image_generation",
          forceFirefly: true,
        })
      ).resolves.toBeNull();
    });

    it("firefly-* 模型仅保留 Adobe 语义候选", async () => {
      dbMock.state.adobes = [makeAdobe(1, { priority: 50 })];

      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        requestedModel: "firefly-nano-banana-pro",
      });

      expect(result?.memberType).toBe("adobe");
      expect(result?.memberId).toBe("adobe-1");
    });

    it("仅将请求模型已被开放的 Adobe 后端纳入候选", async () => {
      dbMock.state.adobes = [
        makeAdobe(1, {
          priority: 1,
          enabledModels: ["firefly-nano-banana-pro"],
        }),
        makeAdobe(2, {
          priority: 2,
          enabledModels: ["firefly-gpt-image-2"],
        }),
      ];

      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        requestedModel: "firefly-gpt-image-2",
      });

      expect(result?.memberType).toBe("adobe");
      expect(result?.memberId).toBe("adobe-2");
    });

    it("视频模型只会命中启用 supportsVideo 的 Adobe 直连后端", async () => {
      dbMock.state.adobes = [
        makeAdobe(1, {
          priority: 1,
          mode: "gateway",
          supportsVideo: true,
        }),
        makeAdobe(2, {
          priority: 2,
          mode: "direct",
          supportsVideo: true,
        }),
      ];

      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        requestedModel: "firefly-sora2-8s-16x9",
      });

      expect(result?.memberType).toBe("adobe");
      expect(result?.memberId).toBe("adobe-2");
    });

    it("裸 Veo/Kling 模型只进入 Adobe direct，普通 API 不会抢占视频租约", async () => {
      dbMock.state.apis = [makeApi(1, { priority: 1 })];
      dbMock.state.adobes = [
        makeAdobe(1, {
          priority: 10,
          mode: "direct",
          supportsVideo: true,
        }),
      ];

      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        requestedModel: "veo31-6s-16x9-1080p",
      });

      expect(result?.memberType).toBe("adobe");
      expect(result?.memberId).toBe("adobe-1");
      expect(result?.config.backend?.fireflyOnly).toBe(true);
    });

    it("firefly-* 排除普通 API，但 Adobe 来源 API 仍按优先级参与", async () => {
      dbMock.state.apis = [
        makeApi(1, {
          priority: 1,
          supportedModelIds: ["firefly-nano-banana-pro"],
        }),
        makeApi(2, {
          priority: 2,
          adobeSourced: true,
          supportedModelIds: ["firefly-nano-banana-pro"],
        }),
      ];
      dbMock.state.adobes = [makeAdobe(1, { priority: 50 })];

      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        requestedModel: "firefly-nano-banana-pro",
      });

      expect(result?.memberType).toBe("api");
      expect(result?.memberId).toBe("api-2");
    });

    it("裸 nano-banana* 让 pool-api 与 pool-adobe 按 priority 同池竞争", async () => {
      dbMock.state.apis = [
        makeApi(1, {
          priority: 20,
          supportedModelIds: ["firefly-nano-banana-pro"],
        }),
      ];
      dbMock.state.adobes = [
        makeAdobe(1, {
          priority: 10,
          enabledModels: ["firefly-nano-banana-pro"],
        }),
      ];

      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        requestedModel: "nano-banana-pro",
      });

      // Adobe 优先级更高，故先选 Adobe。
      expect(result?.memberType).toBe("adobe");
      expect(result?.memberId).toBe("adobe-1");
    });

    it("裸 nano-banana* 的 API priority 更高时优先选择 pool-api", async () => {
      dbMock.state.apis = [
        makeApi(1, {
          priority: 10,
          supportedModelIds: ["nano-banana-pro"],
        }),
      ];
      dbMock.state.adobes = [
        makeAdobe(1, {
          priority: 20,
          enabledModels: ["firefly-nano-banana-pro"],
        }),
      ];

      const result = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        requestedModel: "nano-banana-pro",
      });

      expect(result?.memberType).toBe("api");
      expect(result?.memberId).toBe("api-1");
    });

    it("把 fireflyOnly 盖在解析结果 config 上(供换号重试保持只走 Adobe)", async () => {
      dbMock.state.adobes = [makeAdobe(1, { priority: 50 })];

      // firefly-* 模型:fireflyOnly 盖 true,且只选到 adobe。
      const firefly = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        requestedModel: "firefly-nano-banana-pro",
      });
      expect(firefly?.memberType).toBe("adobe");
      expect(firefly?.config.backend?.fireflyOnly).toBe(true);

      // force_firefly 同样盖 true。
      const forced = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
        forceFirefly: true,
      });
      expect(forced?.config.backend?.fireflyOnly).toBe(true);

      // 普通请求不盖(undefined/false)。
      dbMock.state.apis = [makeApi(1)];
      dbMock.state.adobes = [];
      const normal = await resolveImageBackendPoolConfig({
        userId: "user-a",
        requestKind: "image_generation",
      });
      expect(normal?.config.backend?.fireflyOnly).toBeFalsy();
    });
  });
});
