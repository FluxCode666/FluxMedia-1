/**
 * 图像尺寸弹窗的模型能力回归测试。
 *
 * 确保站内生图在模型不支持 auto 时，即使上层已将尺寸回退为 1024x1024，打开
 * “画面比例”仍默认停在按比例标签，而非自定义宽高。
 */
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImageSizePicker } from "./image-size-picker";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button")
  ).find((button) => button.textContent?.trim() === label);
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("ImageSizePicker", () => {
  it("不支持 auto 时以按比例标签打开 1024x1024 的回退尺寸", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(ImageSizePicker, {
          disabled: false,
          onChange: vi.fn(),
          size: "1024x1024",
          supportsAutoSize: false,
        })
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="设置画面比例，当前为1024 × 1024"]'
    );
    if (!trigger) throw new Error("画面比例按钮未渲染");
    act(() => trigger.click());

    expect(findButton("按比例")?.getAttribute("aria-pressed")).toBe("true");
    expect(findButton("自定义宽高")?.getAttribute("aria-pressed")).toBe(
      "false"
    );
    expect(document.querySelector("#generate-custom-width")).toBeNull();
  });
});
