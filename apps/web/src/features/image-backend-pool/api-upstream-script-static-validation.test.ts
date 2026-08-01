/**
 * API 上游脚本保存期静态校验测试。
 *
 * 职责：锁定异步与模块语法的失败关闭行为，并证明字符串、注释、正则及普通同步
 * 函数不会被词法扫描误报。
 */
import { describe, expect, it } from "vitest";

import {
  ApiUpstreamScriptStaticValidationError,
  assertApiUpstreamScriptStaticContract,
} from "./api-upstream-script-static-validation";

/** 构造包含模板插值的脚本文本，避免测试源码自身执行插值。 */
function createTemplateExpressionScript(expression: string): string {
  const interpolationStart = "$" + "{";
  return `return \`${interpolationStart}${expression}}\`;`;
}

describe("API upstream script static validation", () => {
  it.each([
    "return (async () => input)();",
    "async function transform() { return input; }",
    "return Promise.resolve(input);",
    "return import('vendor-sdk');",
    createTemplateExpressionScript("import('vendor-sdk')"),
    createTemplateExpressionScript("{ value: Promise.resolve(input) }.value"),
    "export const transform = () => input;",
  ])("拒绝异步、Promise 与模块代码：%s", (script) => {
    expect(() => assertApiUpstreamScriptStaticContract(script)).toThrow(
      ApiUpstreamScriptStaticValidationError
    );
  });

  it.each([
    "function normalize(value) { return value; } return normalize(input);",
    "const normalize = (value) => value; return normalize(input);",
    "// async import Promise\nreturn input;",
    "return { note: 'async import Promise' };",
    "return { note: `async import Promise` };",
    "return { matched: /async import Promise/.test('other') };",
  ])("允许同步代码及非代码文本：%s", (script) => {
    expect(() => assertApiUpstreamScriptStaticContract(script)).not.toThrow();
  });
});
