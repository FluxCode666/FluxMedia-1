/**
 * API 上游脚本运行配置测试。
 *
 * 职责：锁定部署环境的默认值、安全上下界和严格整数语义，避免非法配置被静默
 * 降级为资源边界不同的 Worker Pool。
 */
import { describe, expect, it } from "vitest";

import {
  API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS,
  parseApiUpstreamScriptRuntimeConfig,
} from "./api-upstream-script-runtime-config";

describe("API upstream script runtime config", () => {
  it("使用计划确认的安全默认值", () => {
    expect(parseApiUpstreamScriptRuntimeConfig({})).toEqual({
      workerCount: 1,
      memoryLimitBytes: 32 * 1024 * 1024,
      stackLimitBytes: 512 * 1024,
    });
  });

  it("接受三个配置的闭区间边界", () => {
    expect(
      parseApiUpstreamScriptRuntimeConfig({
        [API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.workerCount]: "8",
        [API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.memoryLimitMb]: "128",
        [API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.stackLimitKb]: "2048",
      })
    ).toEqual({
      workerCount: 8,
      memoryLimitBytes: 128 * 1024 * 1024,
      stackLimitBytes: 2_048 * 1024,
    });
    expect(
      parseApiUpstreamScriptRuntimeConfig({
        [API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.workerCount]: "1",
        [API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.memoryLimitMb]: "16",
        [API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.stackLimitKb]: "256",
      })
    ).toEqual({
      workerCount: 1,
      memoryLimitBytes: 16 * 1024 * 1024,
      stackLimitBytes: 256 * 1024,
    });
  });

  it.each([
    "",
    " ",
    "-1",
    "1.5",
    "NaN",
    "9",
  ])("拒绝非法 Worker 数：%j", (value) => {
    expect(() =>
      parseApiUpstreamScriptRuntimeConfig({
        [API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.workerCount]: value,
      })
    ).toThrow(RangeError);
  });

  it.each([
    [API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.memoryLimitMb, "15"],
    [API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.memoryLimitMb, "129"],
    [API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.stackLimitKb, "255"],
    [API_UPSTREAM_SCRIPT_RUNTIME_ENV_KEYS.stackLimitKb, "2049"],
  ])("拒绝越界资源配置 %s=%s", (key, value) => {
    expect(() => parseApiUpstreamScriptRuntimeConfig({ [key]: value })).toThrow(
      RangeError
    );
  });
});
