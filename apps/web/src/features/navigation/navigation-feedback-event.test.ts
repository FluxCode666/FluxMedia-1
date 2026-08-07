/**
 * 程序式导航反馈事件桥测试。
 *
 * 验证生成式入口不会为当前 URL 或外部地址启动全站进度条。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NAVIGATION_FEEDBACK_START_EVENT,
  requestNavigationFeedback,
} from "./navigation-feedback-event";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 安装最小浏览器桩并返回事件派发观察器。 */
function installWindowStub(
  currentHref = "https://fluxmedia.example/zh/dashboard"
) {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", {
    dispatchEvent,
    location: {
      href: currentHref,
    },
  });
  return dispatchEvent;
}

describe("requestNavigationFeedback", () => {
  it("只为新的同源目标派发导航开始事件", () => {
    const dispatchEvent = installWindowStub();

    requestNavigationFeedback("/zh/dashboard");
    requestNavigationFeedback("https://example.com/docs");
    expect(dispatchEvent).not.toHaveBeenCalled();

    requestNavigationFeedback("/zh/dashboard/gallery");
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: NAVIGATION_FEEDBACK_START_EVENT,
    });
  });

  it("无目标地址时支持无法预先解析的国际化导航", () => {
    const dispatchEvent = installWindowStub();
    requestNavigationFeedback();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("识别 next-intl 无语言前缀目标与当前本地化 URL 是同一页", () => {
    const dispatchEvent = installWindowStub(
      "https://fluxmedia.example/zh/dashboard/history?status=succeeded"
    );

    requestNavigationFeedback("/dashboard/history?status=succeeded");
    expect(dispatchEvent).not.toHaveBeenCalled();

    requestNavigationFeedback("/en/dashboard/history?status=succeeded");
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
