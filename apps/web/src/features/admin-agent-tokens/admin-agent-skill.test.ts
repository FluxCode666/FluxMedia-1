/**
 * 项目内管理员 agent 通用 Skill 回归测试。
 *
 * 职责：锁定 Skill 元数据与 UI 配置，并校验 Go scope 注册表中的每个 scope 都写进了
 * Skill，防止新增管理功能接入 agent 后文档遗漏；同时确保供应商 Skill 指向通用 Skill，
 * 不再引用已废弃的只读/可写令牌字段。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(process.cwd(), "../..");
const SKILL_DIRECTORY = resolve(REPO_ROOT, "skills/fluxmedia-admin-agent");
const SUPPLIER_SKILL_DIRECTORY = resolve(
  REPO_ROOT,
  "skills/write-api-upstream-adapter"
);
const SCOPE_REGISTRY_PATH = resolve(
  REPO_ROOT,
  "services/api-gateway/admin_agent_scopes.go"
);

/**
 * 从 Go 源码提取 scope 常量值。
 *
 * @param source admin_agent_scopes.go 源码。
 * @returns 形如 suppliers:read 的 scope ID 列表。
 */
function extractScopeIds(source: string): string[] {
  return Array.from(
    source.matchAll(
      /adminAgentScope\w+\s*=\s*"([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)"/gu
    ),
    (match) => match[1] ?? ""
  ).filter(Boolean);
}

describe("fluxmedia-admin-agent skill", () => {
  it("包含有效元数据和 UI 配置", async () => {
    const skill = await readFile(resolve(SKILL_DIRECTORY, "SKILL.md"), "utf8");
    expect(skill).toMatch(
      /^---\nname: fluxmedia-admin-agent\ndescription: .+\n---/u
    );
    expect(skill).toContain("/dashboard/admin/agent-tokens");
    expect(skill).toContain("INSUFFICIENT_SCOPE");
    // 只允许 bash/json 代码块；```js 块会被供应商 Skill 测试当作 QuickJS 脚本编译。
    expect(skill).not.toMatch(/```js\s/u);

    const openai = await readFile(
      resolve(SKILL_DIRECTORY, "agents/openai.yaml"),
      "utf8"
    );
    expect(openai).toContain("$fluxmedia-admin-agent");
  });

  it("覆盖 Go 注册表中的全部 scope", async () => {
    const [skill, registry] = await Promise.all([
      readFile(resolve(SKILL_DIRECTORY, "SKILL.md"), "utf8"),
      readFile(SCOPE_REGISTRY_PATH, "utf8"),
    ]);
    const scopeIds = extractScopeIds(registry);
    expect(scopeIds.length).toBeGreaterThan(0);
    for (const scopeId of scopeIds) {
      expect(skill, `缺少 scope ${scopeId}`).toContain(`\`${scopeId}\``);
    }
  });

  it("供应商 Skill 引用通用 Skill 并使用 scope 描述权限", async () => {
    const files = await Promise.all(
      ["SKILL.md", "references/online-api.md"].map((path) =>
        readFile(resolve(SUPPLIER_SKILL_DIRECTORY, path), "utf8")
      )
    );
    for (const content of files) {
      expect(content).toContain("fluxmedia-admin-agent");
      expect(content).toContain("suppliers:write");
      expect(content).not.toMatch(/canWrite|READ_ONLY_TOKEN/u);
    }
  });
});
