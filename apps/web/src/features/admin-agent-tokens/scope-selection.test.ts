/**
 * agent 令牌授权范围勾选规则测试。
 */
import type { AdminAgentScope } from "@repo/shared/uol/operations/admin-agent";
import { describe, expect, it } from "vitest";

import { groupScopes, toggleScope } from "./scope-selection";

const scope = (
  id: string,
  group: string,
  requires: string[] = []
): AdminAgentScope => ({
  id,
  group,
  label: id,
  description: id,
  risky: false,
  riskNote: "",
  requires,
});

const scopes = [
  scope("suppliers:read", "供应商"),
  scope("suppliers:write", "供应商", ["suppliers:read"]),
  scope("users:read", "用户"),
];

describe("toggleScope", () => {
  it("勾选时补齐前置 scope", () => {
    const next = toggleScope(new Set(), "suppliers:write", true, scopes);
    expect([...next].sort()).toEqual(["suppliers:read", "suppliers:write"]);
  });

  it("取消前置 scope 时连带取消依赖它的 scope", () => {
    const next = toggleScope(
      new Set(["suppliers:read", "suppliers:write", "users:read"]),
      "suppliers:read",
      false,
      scopes
    );
    expect([...next]).toEqual(["users:read"]);
  });

  it("不修改传入的集合", () => {
    const current = new Set(["users:read"]);
    toggleScope(current, "suppliers:read", true, scopes);
    expect([...current]).toEqual(["users:read"]);
  });
});

describe("groupScopes", () => {
  it("按注册表顺序分组", () => {
    expect(
      groupScopes(scopes).map(([group, items]) => [
        group,
        items.map((item) => item.id),
      ])
    ).toEqual([
      ["供应商", ["suppliers:read", "suppliers:write"]],
      ["用户", ["users:read"]],
    ]);
  });
});
