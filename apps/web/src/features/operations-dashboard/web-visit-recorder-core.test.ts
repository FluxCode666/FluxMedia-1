/**
 * Dashboard 跨自然日访问判断的 DB-free 测试。
 *
 * 使用方：Vitest；确保同日导航不重复触发，跨日或首次失败后会补试。
 */
import { describe, expect, it } from "vitest";

import { shouldRecordVisibleVisit } from "./web-visit-recorder-core";

describe("dashboard web visit recorder core", () => {
  it("同日不重复，跨日或首次失败后重新可见会补试", () => {
    expect(shouldRecordVisibleVisit("2026-08-13", "2026-08-13")).toBe(false);
    expect(shouldRecordVisibleVisit("2026-08-14", "2026-08-13")).toBe(true);
    expect(shouldRecordVisibleVisit("2026-08-13", null)).toBe(true);
  });
});
