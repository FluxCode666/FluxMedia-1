/**
 * 统一媒体运行时分组信任边界测试。
 *
 * 职责：验证站内显式选择与 API Key 服务端绑定的优先级，覆盖未绑定默认组、
 * 错误 owner/停用 Key、固定分组漂移和外部覆盖尝试的 fail-closed 行为。
 * 使用方：apps/web DB-free Vitest 门禁；数据库查询本身由参数化 SQL 实现。
 */
import { describe, expect, it } from "vitest";

import {
  type RuntimeGroupSelectionInput,
  selectTrustedRuntimeGroupTarget,
} from "./runtime-group-selection";

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
      selectTrustedRuntimeGroupTarget(
        runtimeInput({ apiKeyId: "key-1" }),
        { groupId: "group-bound" }
      )
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
