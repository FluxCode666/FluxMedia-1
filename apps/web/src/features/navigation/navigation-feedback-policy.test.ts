/**
 * 全站导航反馈纯策略测试。
 *
 * 覆盖会真正替换页面内容的内部跳转，以及不应劫持的浏览器原生链接行为。
 */
import { describe, expect, it } from "vitest";
import {
  decideNavigationFeedback,
  type NavigationClickIntent,
} from "./navigation-feedback-policy";

const baseIntent: NavigationClickIntent = {
  button: 0,
  currentHref: "https://fluxmedia.example/zh/dashboard",
  download: false,
  feedbackPreference: null,
  href: "https://fluxmedia.example/zh/dashboard/gallery",
  modifierKey: false,
  target: null,
};

/** 合并单个场景差异，避免测试夹具掩盖判定输入。 */
function decide(overrides: Partial<NavigationClickIntent> = {}) {
  return decideNavigationFeedback({ ...baseIntent, ...overrides });
}

describe("decideNavigationFeedback", () => {
  it("为同源页面和查询参数跳转启动反馈", () => {
    expect(decide()).toBe("start");
    expect(
      decide({ href: "https://fluxmedia.example/zh/dashboard?page=2" })
    ).toBe("start");
  });

  it("当前页面和页内锚点点击会撤销遗留反馈", () => {
    expect(decide({ href: baseIntent.currentHref })).toBe("cancel");
    expect(decide({ href: `${baseIntent.currentHref}#usage` })).toBe("cancel");
  });

  it.each([
    ["跨域链接", { href: "https://example.com/docs" }],
    ["非 HTTP 协议", { href: "mailto:support@example.com" }],
    ["新窗口", { target: "_blank" }],
    ["下载", { download: true }],
    ["修饰键", { modifierKey: true }],
    ["非主键点击", { button: 1 }],
    ["显式忽略", { feedbackPreference: "ignore" }],
    ["非法当前 URL", { currentHref: "not a valid absolute URL" }],
  ] as const)("忽略%s", (_label, overrides) => {
    expect(decide(overrides)).toBe("ignore");
  });
});
