/**
 * 程序式导航反馈事件桥。
 *
 * 使用方：无法直接改成 `Link` 的客户端入口，例如表单成功回跳、筛选器和图片参考图
 * 跳转。事件只在浏览器内存中传播，不持久化导航状态，也不改变路由行为。
 */

export const NAVIGATION_FEEDBACK_START_EVENT =
  "fluxmedia:navigation-feedback-start";

/** 请求根布局中的导航反馈组件立即显示进度条。 */
export function requestNavigationFeedback(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NAVIGATION_FEEDBACK_START_EVENT));
}
