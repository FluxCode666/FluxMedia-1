/**
 * 全局分页配置纯契约测试。
 *
 * 职责：锁定默认值、管理员白名单约束与公开 URL 的 fail-safe 回退行为。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_PAGE_SIZE_OPTIONS,
  paginationPageSizeOptionsSchema,
  parseConfiguredPageSize,
  parsePaginationConfig,
} from "./config";

describe("pagination config", () => {
  it("uses the required defaults when configuration is missing", () => {
    expect(parsePaginationConfig(undefined)).toEqual({
      defaultPageSize: DEFAULT_PAGE_SIZE,
      pageSizeOptions: DEFAULT_PAGE_SIZE_OPTIONS,
    });
  });

  it("sorts a valid configured option list", () => {
    expect(parsePaginationConfig([50, 20, 10]).pageSizeOptions).toEqual([
      10, 20, 50,
    ]);
  });

  it("rejects invalid option lists", () => {
    for (const options of [[10, 10, 20], [10, 50], [10, 20, 101], []]) {
      expect(paginationPageSizeOptionsSchema.safeParse(options).success).toBe(
        false
      );
      expect(parsePaginationConfig(options).pageSizeOptions).toEqual([
        10, 20, 50,
      ]);
    }
  });

  it("only accepts a scalar option present in the current whitelist", () => {
    const config = parsePaginationConfig([10, 20, 40]);
    expect(parseConfiguredPageSize("40", config)).toBe(40);
    expect(parseConfiguredPageSize("50", config)).toBe(20);
    expect(parseConfiguredPageSize(["40"], config)).toBe(20);
    expect(parseConfiguredPageSize("20.0", config)).toBe(20);
  });
});
