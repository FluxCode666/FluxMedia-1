/**
 * 顶部导航进度数值策略测试。
 *
 * 验证未知耗时下的进度始终单调、有限并停留在等待上限以内。
 */
import { describe, expect, it } from "vitest";
import {
  advanceNavigationProgress,
  NAVIGATION_PROGRESS_INITIAL,
  NAVIGATION_PROGRESS_WAITING_MAX,
} from "./navigation-progress";

describe("advanceNavigationProgress", () => {
  it("从初始值单调推进但不会提前到达完成态", () => {
    let current = NAVIGATION_PROGRESS_INITIAL;
    for (let index = 0; index < 100; index += 1) {
      const next = advanceNavigationProgress(current);
      expect(next).toBeGreaterThanOrEqual(current);
      expect(next).toBeLessThanOrEqual(NAVIGATION_PROGRESS_WAITING_MAX);
      current = next;
    }
    expect(current).toBe(NAVIGATION_PROGRESS_WAITING_MAX);
  });

  it("规范化越界和非有限输入", () => {
    expect(advanceNavigationProgress(-10)).toBeGreaterThan(
      NAVIGATION_PROGRESS_INITIAL
    );
    expect(advanceNavigationProgress(Number.NaN)).toBe(
      NAVIGATION_PROGRESS_INITIAL
    );
    expect(advanceNavigationProgress(100)).toBe(
      NAVIGATION_PROGRESS_WAITING_MAX
    );
  });
});
