/**
 * 模型广场中英文文案契约测试。
 *
 * 使用方是 Vitest；保证客户端与服务端共享命名空间的键结构完全一致且叶子均为非空文本。
 */

import { describe, expect, it } from "vitest";
import enMessages from "../../../messages/en.json";
import zhMessages from "../../../messages/zh.json";

/** 递归收集对象的点分叶子路径，数组不属于模型广场文案契约。 */
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

describe("ModelMarketplace i18n contract", () => {
  it("英文与中文键结构一致且没有空叶子", () => {
    const enLeaves = collectLeafPaths(enMessages.ModelMarketplace);
    const zhLeaves = collectLeafPaths(zhMessages.ModelMarketplace);

    expect(enLeaves.map((leaf) => leaf.path).sort()).toEqual(
      zhLeaves.map((leaf) => leaf.path).sort()
    );
    for (const leaf of [...enLeaves, ...zhLeaves]) {
      expect(typeof leaf.value, leaf.path).toBe("string");
      expect(String(leaf.value).trim().length, leaf.path).toBeGreaterThan(0);
    }
  });

  it("视频按秒与按条单位都有明确的双语文案", () => {
    expect(zhMessages.ModelMarketplace.price.perSecond).toBe("每秒");
    expect(zhMessages.ModelMarketplace.price.perItem).toBe("每条");
    expect(enMessages.ModelMarketplace.price.perSecond).toBe("per second");
    expect(enMessages.ModelMarketplace.price.perItem).toBe("per item");
  });
});
