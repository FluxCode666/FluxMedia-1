/**
 * 控制台导航多语言文案契约测试。
 *
 * 使用方：apps/web Vitest。确保生成入口在所有已支持语言中使用动作名称，避免只同步
 * 单个 locale 后出现菜单语义不一致。
 */

import { describe, expect, it } from "vitest";

import enMessages from "../../../messages/en.json";
import zhMessages from "../../../messages/zh.json";

describe("控制台导航多语言契约", () => {
  it("在中英文菜单中使用对应的生成动作名称", () => {
    expect(enMessages.Dashboard.nav.generate).toBe("Generate");
    expect(zhMessages.Dashboard.nav.generate).toBe("生成");
  });
});
