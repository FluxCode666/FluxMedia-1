/**
 * Dashboard 跨自然日访问判断的 DB-free 测试。
 *
 * 使用方：Vitest；锁定应用时区日期而非浏览器本地日期，并确保同日导航不重复触发。
 */
import { describe, expect, it } from "vitest";

import {
  formatClientAppDate,
  shouldRecordVisibleVisit,
} from "./web-visit-recorder-core";

describe("dashboard web visit recorder core", () => {
  it("按应用时区而非运行环境时区判断自然日", () => {
    const now = new Date("2026-08-12T16:30:00.000Z");
    expect(formatClientAppDate(now, "Asia/Shanghai")).toBe("2026-08-13");
    expect(formatClientAppDate(now, "UTC")).toBe("2026-08-12");
  });

  it("同日不重复，跨日或首次失败后重新可见会补试", () => {
    expect(shouldRecordVisibleVisit("2026-08-13", "2026-08-13")).toBe(false);
    expect(shouldRecordVisibleVisit("2026-08-14", "2026-08-13")).toBe(true);
    expect(shouldRecordVisibleVisit("2026-08-13", null)).toBe(true);
  });
});
