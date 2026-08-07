/**
 * 顶部导航进度条的纯数值策略。
 *
 * 使用方：NavigationFeedback。未知服务端耗时不能映射为真实百分比，因此只在等待
 * 阶段渐近到上限，路由提交后再由组件明确推进到 100%。
 */

export const NAVIGATION_PROGRESS_INITIAL = 12;
export const NAVIGATION_PROGRESS_WAITING_MAX = 92;
export const NAVIGATION_PROGRESS_TICK_MS = 300;
export const NAVIGATION_PROGRESS_COMPLETE_DELAY_MS = 240;
export const NAVIGATION_PROGRESS_STALE_MS = 30_000;

/**
 * 将等待中的导航进度向上限推进一步。
 *
 * @param current 当前展示值；非有限数值安全重置到初始值。
 * @returns 单调递增且不超过等待上限的整数百分比。
 */
export function advanceNavigationProgress(current: number): number {
  if (!Number.isFinite(current)) return NAVIGATION_PROGRESS_INITIAL;
  const safeCurrent = Math.max(NAVIGATION_PROGRESS_INITIAL, current);
  if (safeCurrent >= NAVIGATION_PROGRESS_WAITING_MAX) {
    return NAVIGATION_PROGRESS_WAITING_MAX;
  }

  const remaining = NAVIGATION_PROGRESS_WAITING_MAX - safeCurrent;
  return Math.min(
    NAVIGATION_PROGRESS_WAITING_MAX,
    Math.ceil(safeCurrent + Math.max(1, remaining * 0.16))
  );
}
