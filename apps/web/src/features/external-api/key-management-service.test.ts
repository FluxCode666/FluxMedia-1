/**
 * API 密钥管理应用服务的 DB-free 单元测试。
 *
 * 职责：验证分组资格、额度归一、密钥散列/加密、所有权条件及生命周期竞态。
 * 使用方：UOL externalApi.*Key bindings 的业务回归门。
 * 关键依赖：Vitest；仓储、分组与密码学依赖均使用内存替身。
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  createExternalApiKeyManagementService,
  ExternalApiKeyManagementError,
  type ExternalApiKeyRecord,
  type ExternalApiKeyRepository,
} from "./key-management-service";

const now = new Date("2026-07-23T04:00:00.000Z");

const activeKey: ExternalApiKeyRecord = {
  id: "key-1",
  name: "Production",
  keyPrefix: "g2i_abc",
  encryptedKey: "encrypted:sk-stored-key",
  lastFour: "wxyz",
  generationGroupId: "group-1",
  creditLimit: 100,
  creditsUsed: 12.5,
  lastUsedAt: null,
  isActive: true,
  createdAt: new Date("2026-07-20T04:00:00.000Z"),
  updatedAt: new Date("2026-07-20T04:00:00.000Z"),
};

const disabledCurrentGroup = {
  id: "group-1",
  name: "Legacy Group",
  isEnabled: false,
};

const selectableGroup = {
  id: "group-2",
  name: "Selectable Group",
  isEnabled: true,
};

type RepositoryMocks = {
  [K in keyof ExternalApiKeyRepository]: Mock<ExternalApiKeyRepository[K]>;
};

let repository: RepositoryMocks;
let listSelectableGroups: Mock<() => Promise<(typeof selectableGroup)[]>>;
let getGroupById: Mock<
  (groupId: string) => Promise<typeof selectableGroup | null>
>;

/** 构造完全注入依赖的服务，确保测试不会加载数据库连接。 */
function createService() {
  return createExternalApiKeyManagementService({
    repository,
    listSelectableGroups,
    getGroupById,
    createId: () => "key-new",
    createSecret: () => "sk-plaintext",
    hashSecret: (secret) => `hash:${secret}`,
    encryptSecret: (secret) => `encrypted:${secret}`,
    decryptSecret: (ciphertext) => ciphertext.replace("encrypted:", ""),
    now: () => now,
  });
}

/** 断言领域服务以指定稳定错误码失败。 */
async function expectServiceError(
  promise: Promise<unknown>,
  code: ExternalApiKeyManagementError["code"]
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected service to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalApiKeyManagementError);
    expect((error as ExternalApiKeyManagementError).code).toBe(code);
  }
}

beforeEach(() => {
  repository = {
    listByUser: vi
      .fn()
      .mockResolvedValue([
        { key: activeKey, currentGroup: disabledCurrentGroup },
      ]),
    insert: vi.fn().mockResolvedValue({
      ...activeKey,
      id: "key-new",
      generationGroupId: "group-2",
      creditLimit: 12.35,
      creditsUsed: 0,
      createdAt: now,
      updatedAt: now,
    }),
    revokeActive: vi.fn().mockResolvedValue({
      ...activeKey,
      isActive: false,
      updatedAt: now,
    }),
    deleteRevoked: vi.fn().mockResolvedValue({ id: "key-1" }),
    updateActiveGroup: vi.fn().mockResolvedValue({
      ...activeKey,
      generationGroupId: "group-2",
      updatedAt: now,
    }),
    updateActiveQuota: vi.fn().mockResolvedValue({
      ...activeKey,
      creditLimit: 25.68,
      updatedAt: now,
    }),
    findState: vi.fn().mockResolvedValue({ isActive: true }),
  };
  listSelectableGroups = vi.fn().mockResolvedValue([selectableGroup]);
  getGroupById = vi
    .fn()
    .mockImplementation(async (groupId: string) =>
      groupId === disabledCurrentGroup.id
        ? disabledCurrentGroup
        : groupId === selectableGroup.id
          ? selectableGroup
          : null
    );
});

describe("list API keys", () => {
  it("keeps a disabled current group visible and returns separate editable candidates", async () => {
    const result = await createService().listKeys("user-1");

    expect(result).toEqual({
      keys: [
        {
          id: "key-1",
          name: "Production",
          keyPrefix: "g2i_abc",
          apiKey: "sk-stored-key",
          lastFour: "wxyz",
          generationGroupId: "group-1",
          creditLimit: 100,
          creditsUsed: 12.5,
          lastUsedAt: null,
          isActive: true,
          createdAt: activeKey.createdAt,
          updatedAt: activeKey.updatedAt,
          currentGroup: {
            id: "group-1",
            name: "Legacy Group",
            enabled: false,
            selectable: false,
          },
        },
      ],
      editableGroups: [
        {
          id: "group-2",
          name: "Selectable Group",
          enabled: true,
          selectable: true,
        },
      ],
    });
    expect(repository.listByUser).toHaveBeenCalledWith("user-1");
  });

  it("没有可选分组时仍保留当前禁用分组的只读状态", async () => {
    listSelectableGroups.mockResolvedValue([]);

    const result = await createService().listKeys("user-1");

    expect(result.editableGroups).toEqual([]);
    expect(result.keys[0]?.currentGroup?.selectable).toBe(false);
    expect(listSelectableGroups).toHaveBeenCalledOnce();
  });

  it("历史记录没有可恢复密文时明确返回 null", async () => {
    repository.listByUser.mockResolvedValue([
      {
        key: { ...activeKey, encryptedKey: null },
        currentGroup: disabledCurrentGroup,
      },
    ]);

    const result = await createService().listKeys("user-1");

    expect(result.keys[0]?.apiKey).toBeNull();
  });
});

describe("create API key", () => {
  it("校验分组、归一额度并同时保存哈希与密文", async () => {
    const result = await createService().createKey("user-1", {
      name: "Production",
      generationGroupId: "group-2",
      creditLimit: 12.345,
    });

    expect(repository.insert).toHaveBeenCalledWith({
      id: "key-new",
      userId: "user-1",
      name: "Production",
      keyPrefix: "sk-plai",
      keyHash: "hash:sk-plaintext",
      encryptedKey: "encrypted:sk-plaintext",
      lastFour: "text",
      generationGroupId: "group-2",
      creditLimit: 12.35,
      createdAt: now,
      updatedAt: now,
    });
    expect(result.apiKey).toBe("sk-plaintext");
    expect(result.key.currentGroup).toEqual({
      id: "group-2",
      name: "Selectable Group",
      enabled: true,
      selectable: true,
    });
    expect(result.key).not.toHaveProperty("keyHash");
  });

  it.each([
    undefined,
    null,
    "default",
  ])("分组输入为 %s 时使用默认分组", async (generationGroupId) => {
    await createService().createKey("user-1", {
      name: "Production",
      generationGroupId,
      creditLimit: null,
    });

    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        generationGroupId: null,
        creditLimit: null,
      })
    );
  });

  it("rejects a group outside the current editable candidates", async () => {
    await expectServiceError(
      createService().createKey("user-1", {
        name: "Production",
        generationGroupId: "group-missing",
        creditLimit: null,
      }),
      "validation_error"
    );
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it("额度为负数时在持久化前拒绝请求", async () => {
    await expect(
      createService().createKey("user-1", {
        name: "Production",
        generationGroupId: null,
        creditLimit: -0.01,
      })
    ).rejects.toThrow("API Key 额度必须是大于等于 0 的数字");
    expect(repository.insert).not.toHaveBeenCalled();
  });
});

describe("API key lifecycle mutations", () => {
  it("uses one conditional revoke and returns the actual updated row", async () => {
    const result = await createService().revokeKey("user-1", "key-1");

    expect(repository.revokeActive).toHaveBeenCalledWith(
      "user-1",
      "key-1",
      now
    );
    expect(result.isActive).toBe(false);
    expect(repository.findState).not.toHaveBeenCalled();
  });

  it("distinguishes a missing key from an already-revoked key", async () => {
    repository.revokeActive.mockResolvedValue(null);
    repository.findState.mockResolvedValueOnce(null);
    await expectServiceError(
      createService().revokeKey("user-1", "foreign-key"),
      "not_found"
    );
    expect(repository.findState).toHaveBeenNthCalledWith(
      1,
      "user-1",
      "foreign-key"
    );

    repository.findState.mockResolvedValueOnce({ isActive: false });
    await expectServiceError(
      createService().revokeKey("user-1", "key-1"),
      "state_conflict"
    );
    expect(repository.findState).toHaveBeenNthCalledWith(2, "user-1", "key-1");
  });

  it("deletes only a revoked owned key and reports active-state conflicts", async () => {
    expect(await createService().deleteKey("user-1", "key-1")).toEqual({
      id: "key-1",
    });

    repository.deleteRevoked.mockResolvedValue(null);
    repository.findState.mockResolvedValue({ isActive: true });
    await expectServiceError(
      createService().deleteKey("user-1", "key-1"),
      "state_conflict"
    );
  });

  it("updates group and quota only through active-row conditions", async () => {
    const service = createService();
    const groupResult = await service.updateKeyGroup(
      "user-1",
      "key-1",
      "group-2"
    );
    const quotaResult = await service.updateKeyQuota("user-1", "key-1", 25.678);

    expect(repository.updateActiveGroup).toHaveBeenCalledWith(
      "user-1",
      "key-1",
      "group-2",
      now
    );
    expect(repository.updateActiveQuota).toHaveBeenCalledWith(
      "user-1",
      "key-1",
      25.68,
      now
    );
    expect(groupResult.generationGroupId).toBe("group-2");
    expect(quotaResult.creditLimit).toBe(25.68);
  });

  it("reports inactive edit races as state conflicts", async () => {
    repository.updateActiveGroup.mockResolvedValue(null);
    repository.findState.mockResolvedValue({ isActive: false });

    await expectServiceError(
      createService().updateKeyGroup("user-1", "key-1", "group-2"),
      "state_conflict"
    );
  });
});
