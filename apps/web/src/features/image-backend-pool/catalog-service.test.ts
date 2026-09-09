/**
 * 站内媒体目录分组语义测试。
 *
 * 职责：验证分组可选性和默认组不再读取套餐门槛，也不按 priority 兜底选组。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listGroups: vi.fn(),
  listMembers: vi.fn(),
  getRuntimeSettingJson: vi.fn(),
  getMediaLimitDefaults: vi.fn(),
}));

vi.mock("./group-service", () => ({
  backendGroupService: {
    listGroups: mocks.listGroups,
  },
}));
vi.mock("./member-service", () => ({
  backendMemberService: {
    listMembers: mocks.listMembers,
  },
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeSettingJson: mocks.getRuntimeSettingJson,
}));
vi.mock("@repo/shared/image-generation/media-limit-service", () => ({
  getMediaLimitDefaults: mocks.getMediaLimitDefaults,
}));

import {
  getEffectiveDefaultImageBackendGroup,
  getImageGenerationModelCatalog,
  listSelectableImageBackendGroups,
} from "./catalog-service";

/** 构造可覆盖默认状态和 priority 的分组摘要。 */
const group = (overrides: Record<string, unknown> = {}) => ({
  id: "group-default",
  name: "默认组",
  description: null,
  isEnabled: true,
  isDefault: true,
  isUserSelectable: false,
  contentSafety: "inherit" as const,
  imageCreditOverrides: { version: 1 as const, byModel: {} },
  videoCreditOverrides: {},
  childGroupIds: [],
  priority: 100,
  ...overrides,
});

/** 构造不含凭据正文的最小 API 成员摘要。 */
const member = {
  id: "member-a",
  name: "API",
  type: "api" as const,
  groupIds: ["group-default"],
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
  createdAt: "2026-08-05T00:00:00.000Z",
  lastAcquiredAt: null,
  lastUsedAt: null,
  lastError: null,
  lastErrorAt: null,
  config: {
    baseUrl: "https://example.com",
    modelMappings: [],
  },
};

describe("image backend catalog group semantics", () => {
  beforeEach(() => {
    mocks.listGroups.mockReset();
    mocks.listMembers.mockReset();
    mocks.getRuntimeSettingJson.mockReset();
    mocks.getMediaLimitDefaults.mockReset();
    mocks.listMembers.mockResolvedValue([member]);
    mocks.getRuntimeSettingJson.mockResolvedValue(null);
    mocks.getMediaLimitDefaults.mockResolvedValue({
      maxEditReferenceImages: 16,
    });
  });

  it("可选分组只由启用和 isUserSelectable 决定", async () => {
    mocks.listGroups.mockResolvedValue([
      group({ id: "selectable", isDefault: false, isUserSelectable: true }),
      group({ id: "hidden", isDefault: false, isUserSelectable: false }),
      group({ id: "disabled", isEnabled: false, isUserSelectable: true }),
    ]);

    await expect(listSelectableImageBackendGroups()).resolves.toEqual([
      { id: "selectable", name: "默认组", isEnabled: true },
    ]);
  });

  it("不存在启用默认组时不按 priority 或列表顺序兜底", async () => {
    mocks.listGroups.mockResolvedValue([
      group({ id: "priority-first", isDefault: false, priority: 0 }),
    ]);

    await expect(getEffectiveDefaultImageBackendGroup()).resolves.toBe(null);
    await expect(getImageGenerationModelCatalog()).resolves.toEqual({
      groups: [],
    });
  });

  it("默认组快照保留 priority 供后续任务队列使用", async () => {
    mocks.listGroups.mockResolvedValue([group({ priority: 7 })]);

    await expect(getEffectiveDefaultImageBackendGroup()).resolves.toEqual(
      expect.objectContaining({ id: "group-default", priority: 7 })
    );
  });

  it("多个启用默认组时 fail closed，不选择 priority 更小的组", async () => {
    mocks.listGroups.mockResolvedValue([
      group({ id: "default-a", priority: 1 }),
      group({ id: "default-b", priority: 2 }),
    ]);

    await expect(getEffectiveDefaultImageBackendGroup()).resolves.toBe(null);
    await expect(getImageGenerationModelCatalog()).resolves.toEqual({
      groups: [],
    });
  });

  it("创作页图片目录不返回已停用模型", async () => {
    mocks.listGroups.mockResolvedValue([group()]);
    mocks.listMembers.mockResolvedValue([
      {
        ...member,
        supportedModelIds: ["firefly-gpt-image-2", "vendor-image"],
      },
    ]);
    mocks.getRuntimeSettingJson.mockResolvedValue({
      version: 2,
      imageByModel: {
        "gpt-image-2": {
          revision: 1,
          enabled: false,
          visible: false,
          homepageVisible: false,
          homepagePriority: 5,
          description: "",
          cover: null,
        },
      },
      videoByFamily: {},
      customModels: [],
      writeReceipts: {},
    });

    await expect(getImageGenerationModelCatalog()).resolves.toEqual({
      groups: [
        expect.objectContaining({
          models: [
            {
              id: "vendor-image",
              capabilities: { generate: true, edit: true, mask: true },
              maxReferenceImages: 16,
            },
          ],
        }),
      ],
    });
  });
});
