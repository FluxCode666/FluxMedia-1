/**
 * API 上游脚本真实 Worker 回归测试。
 *
 * 职责：通过生产 Pool 入口证明 QuickJS 在独立 Worker 中执行，并锁定同步函数、
 * 禁用宿主能力、CPU 截止及故障后补建行为。
 */
import { afterAll, describe, expect, it } from "vitest";
import { shutdownApiUpstreamScriptPool } from "./api-upstream-script-pool";
import {
  ApiUpstreamScriptRuntimeError,
  runApiUpstreamScript,
} from "./api-upstream-script-runtime";

describe("API upstream script worker", () => {
  afterAll(async () => {
    await shutdownApiUpstreamScriptPool();
  });

  it("在隔离运行时支持同步函数声明和箭头函数", async () => {
    await expect(
      runApiUpstreamScript(
        { value: 3 },
        `function double(value) { return value * 2; }
const increment = (value) => value + 1;
input.value = increment(double(input.value));
return input;`,
        { operation: "videos.generate" },
        {
          operation: "videos.generate",
          stage: "request",
          priority: "request",
        }
      )
    ).resolves.toEqual({ value: 7 });
  });

  it("禁止异步、宿主、时间、随机数和动态代码能力", async () => {
    await expect(
      runApiUpstreamScript(
        {},
        `input.capabilities = [
  typeof process,
  typeof require,
  typeof fetch,
  typeof Date,
  typeof Math.random,
  typeof eval,
  typeof Function
];
return input;`,
        {},
        {
          operation: "images.generate",
          stage: "request",
          priority: "request",
        }
      )
    ).resolves.toEqual({
      capabilities: [
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
      ],
    });

    await expect(
      runApiUpstreamScript(
        {},
        "return (async () => input)();",
        {},
        {
          operation: "images.generate",
          stage: "request",
          priority: "request",
        }
      )
    ).rejects.toBeInstanceOf(ApiUpstreamScriptRuntimeError);
  });

  it("中断死循环且后续作业仍由可用 Worker 完成", async () => {
    await expect(
      runApiUpstreamScript(
        {},
        "while (true) {}",
        {},
        {
          operation: "videos.generate",
          stage: "request",
          priority: "request",
        }
      )
    ).rejects.toMatchObject({ code: "execution_failed" });
    await expect(
      runApiUpstreamScript(
        { healthy: true },
        "return input;",
        {},
        {
          operation: "videos.generate",
          stage: "request",
          priority: "request",
        }
      )
    ).resolves.toEqual({ healthy: true });
  });
});
