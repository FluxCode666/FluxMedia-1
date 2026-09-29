/**
 * 站内系统更新中英文消息契约测试。
 *
 * 使用方：apps/web Vitest。保证两个 locale 的 SystemUpdates 键树一致、叶子非空，
 * 覆盖按错误码/阶段动态拼接的键，以及组件里所有字面量 t("...") 键。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import enMessages from "../../../messages/en.json";
import zhMessages from "../../../messages/zh.json";
import {
  SYSTEM_UPDATE_BLOCKED_REASONS,
  SYSTEM_UPDATE_ERROR_CODES,
  SYSTEM_UPDATE_RELEASE_ERRORS,
  SYSTEM_UPDATE_STEPS,
} from "./system-update-model";

/** 递归收集点分叶子路径。 */
function collectLeafPaths(
  value: unknown,
  prefix = ""
): Array<{ path: string; value: unknown }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [{ path: prefix, value }];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    collectLeafPaths(child, prefix ? `${prefix}.${key}` : key)
  );
}

/** 从未知消息对象安全读取点分路径；缺失路径返回 undefined。 */
function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

describe("SystemUpdates i18n contract", () => {
  it("中英文键结构一致且所有叶子都是非空字符串", () => {
    const enLeaves = collectLeafPaths(enMessages.SystemUpdates);
    const zhLeaves = collectLeafPaths(zhMessages.SystemUpdates);

    expect(enLeaves.map((leaf) => leaf.path).sort()).toEqual(
      zhLeaves.map((leaf) => leaf.path).sort()
    );
    for (const leaf of [...enLeaves, ...zhLeaves]) {
      expect(typeof leaf.value, leaf.path).toBe("string");
      expect(String(leaf.value).trim().length, leaf.path).toBeGreaterThan(0);
    }
  });

  it("覆盖步骤、错误码、阻塞原因与 GitHub 错误的动态键", () => {
    const dynamicPaths = [
      ...SYSTEM_UPDATE_STEPS.map((step) => `steps.${step}`),
      ...SYSTEM_UPDATE_ERROR_CODES.map((code) => `errors.${code}`),
      "errors.unknown",
      ...SYSTEM_UPDATE_BLOCKED_REASONS.map((reason) => `blocked.${reason}`),
      ...SYSTEM_UPDATE_RELEASE_ERRORS.map((code) => `releaseErrors.${code}`),
      "warnings.dashboard_backfill_failed",
    ];
    for (const path of dynamicPaths) {
      expect(readPath(enMessages.SystemUpdates, path), `en ${path}`).toBeTypeOf(
        "string"
      );
      expect(readPath(zhMessages.SystemUpdates, path), `zh ${path}`).toBeTypeOf(
        "string"
      );
    }
  });

  it("组件使用的字面量键都存在", () => {
    const source = readFileSync(
      new URL("./system-version-control.tsx", import.meta.url),
      "utf8"
    );
    const keys = [...source.matchAll(/\bt\("([^"]+)"/g)].map(
      (match) => match[1] ?? ""
    );
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(readPath(zhMessages.SystemUpdates, key), key).toBeTypeOf("string");
    }
  });
});
