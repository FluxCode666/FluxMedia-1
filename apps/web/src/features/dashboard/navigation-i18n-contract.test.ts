/**
 * 控制台生成入口多语言文案契约测试。
 *
 * 使用方：apps/web Vitest。确保生成入口的菜单和顶部标题在所有已支持语言中使用动作
 * 名称，避免不同位置或 locale 的文案不同步。
 */

import { describe, expect, it } from "vitest";

import enMessages from "../../../messages/en.json";
import zhMessages from "../../../messages/zh.json";

describe("控制台生成入口多语言契约", () => {
  it("在中英文菜单和顶部标题中使用对应的生成动作名称", () => {
    expect(enMessages.Dashboard.nav.generate).toBe("Generate");
    expect(zhMessages.Dashboard.nav.generate).toBe("生成");
    expect(enMessages.Dashboard.pages.generate).toBe("Generate");
    expect(zhMessages.Dashboard.pages.generate).toBe("生成");
  });
});
