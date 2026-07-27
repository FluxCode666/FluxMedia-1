/**
 * 统一媒体后端分组服务测试。
 *
 * 职责：以 DB-free 仓储锁定保存、层级环检测、唯一默认组错误映射和安全删除；
 * PostgreSQL 事务与锁细节由仓储集成验证承担。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type BackendGroupRepository,
  BackendGroupServiceError,
  createBackendGroupService,
  validateBackendGroupTopology,
} from "./group-service";

const NOW = new Date("2026-07-26T00:00:00.000Z");

/** 构造只记录调用的仓储，单个测试按需覆盖返回值。 */
function createRepository(): BackendGroupRepository & {
  saveGroup: ReturnType<typeof vi.fn>;
  listGroups: ReturnType<typeof vi.fn>;
  listGroupOptions: ReturnType<typeof vi.fn>;
  deleteGroup: ReturnType<typeof vi.fn>;
} {
  return {
    saveGroup: vi.fn(async (input) => ({
      status: "saved" as const,
      id: input.id,
    })),
    listGroups: vi.fn(async () => []),
    listGroupOptions: vi.fn(async () => []),
    deleteGroup: vi.fn(async () => "deleted" as const),
  };
}

/** 构造默认合法的统一分组输入。 */
function groupInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "默认组",
    isEnabled: true,
    isDefault: true,
    isUserSelectable: true,
    contentSafety: "inherit",
    minPlan: "free",
    imageCreditOverrides: { version: 1, byModel: {} },
    videoCreditOverrides: {},
    childGroupIds: [],
    priority: 50,
    ...overrides,
  };
}

describe("backend group service", () => {
  let repository: ReturnType<typeof createRepository>;

  beforeEach(() => {
    repository = createRepository();
  });

  it("新增分组补齐服务端 ID 并保留统一字段", async () => {
    const service = createBackendGroupService({
      repository,
      createId: () => "group-new",
      now: () => NOW,
    });

    await expect(service.saveGroup(groupInput())).resolves.toEqual({
      id: "group-new",
    });
    expect(repository.saveGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "group-new",
        isCreate: true,
        minPlan: "free",
        childGroupIds: [],
      }),
      NOW
    );
  });

  it("拒绝重复子分组且不进入仓储事务", async () => {
    const service = createBackendGroupService({ repository });

    await expect(
      service.saveGroup(groupInput({ childGroupIds: ["group-a", "group-a"] }))
    ).rejects.toBeTruthy();
    expect(repository.saveGroup).not.toHaveBeenCalled();
  });

  it("检测直接自引用、未知子组和跨层循环", () => {
    const groups = [
      { id: "group-a", childGroupIds: ["group-b"] },
      { id: "group-b", childGroupIds: [] },
    ];

    expect(
      validateBackendGroupTopology(
        { id: "group-a", childGroupIds: ["group-a"] },
        groups
      )
    ).toBe("self_reference");
    expect(
      validateBackendGroupTopology(
        { id: "group-a", childGroupIds: ["missing"] },
        groups
      )
    ).toBe("unknown_child");
    expect(
      validateBackendGroupTopology(
        { id: "group-b", childGroupIds: ["group-a"] },
        groups
      )
    ).toBe("cycle");
  });

  it("默认组和仍被使用的分组均返回稳定冲突", async () => {
    const service = createBackendGroupService({ repository });
    repository.deleteGroup.mockResolvedValueOnce("default_group");

    const defaultError = await service
      .deleteGroup("group-default")
      .catch((cause: unknown) => cause);
    expect(defaultError).toBeInstanceOf(BackendGroupServiceError);
    expect(defaultError).toMatchObject({ code: "conflict" });

    repository.deleteGroup.mockResolvedValueOnce("in_use");
    const inUseError = await service
      .deleteGroup("group-used")
      .catch((cause: unknown) => cause);
    expect(inUseError).toMatchObject({
      code: "conflict",
      message: "分组仍有关联成员或层级关系，不能删除",
    });
  });

  it("读取管理摘要和可选项时不在领域层改变仓储结果", async () => {
    const service = createBackendGroupService({ repository });
    const options = [{ id: "group-a", name: "A" }];
    repository.listGroupOptions.mockResolvedValue(options);

    await expect(service.listGroups()).resolves.toEqual([]);
    await expect(service.listGroupOptions()).resolves.toEqual(options);
  });
});
