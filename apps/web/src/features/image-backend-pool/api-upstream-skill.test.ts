/**
 * 项目内 API 上游适配 Skill 回归测试。
 *
 * 职责：锁定 Skill 元数据、直接引用和 JavaScript 示例可被生产 QuickJS 编译；
 * 防止运行时契约演进后文档仍静态存在但示例已不可执行。
 */
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validateApiUpstreamScript } from "./api-upstream-script-runtime";

const SKILL_DIRECTORY = resolve(
  process.cwd(),
  "../../skills/write-api-upstream-adapter"
);
const SKILL_PATH = resolve(SKILL_DIRECTORY, "SKILL.md");
const REFERENCE_PATHS = [
  "references/runtime-contract.md",
  "references/text-to-image.md",
  "references/image-to-image.md",
  "references/video.md",
] as const;

/** 提取 Markdown 中所有 JavaScript 函数体代码块。 */
function extractJavaScriptBlocks(markdown: string): string[] {
  return Array.from(markdown.matchAll(/```js\s+([\s\S]*?)```/gu), (match) =>
    (match[1] ?? "").trim()
  ).filter(Boolean);
}

describe("write-api-upstream-adapter skill", () => {
  it("包含有效元数据、UI 配置和四个直接参考文件", async () => {
    const skill = await readFile(SKILL_PATH, "utf8");
    expect(skill).toMatch(
      /^---\nname: write-api-upstream-adapter\ndescription: .+\n---/u
    );
    for (const referencePath of REFERENCE_PATHS) {
      expect(skill).toContain(`](${referencePath})`);
      await expect(
        access(resolve(SKILL_DIRECTORY, referencePath))
      ).resolves.toBeUndefined();
    }
    const agentMetadata = await readFile(
      resolve(SKILL_DIRECTORY, "agents/openai.yaml"),
      "utf8"
    );
    expect(agentMetadata).toContain("$write-api-upstream-adapter");
    expect(skill).not.toContain("write-api-request-transform");
  });

  it("所有 JavaScript 示例均通过生产 QuickJS 编译", async () => {
    const markdownFiles = [
      SKILL_PATH,
      ...REFERENCE_PATHS.map((path) => resolve(SKILL_DIRECTORY, path)),
    ];
    let exampleCount = 0;
    for (const markdownPath of markdownFiles) {
      const markdown = await readFile(markdownPath, "utf8");
      for (const script of extractJavaScriptBlocks(markdown)) {
        exampleCount += 1;
        await validateApiUpstreamScript(script, "images.generate", "request");
      }
    }
    expect(exampleCount).toBeGreaterThanOrEqual(15);
  });
});
