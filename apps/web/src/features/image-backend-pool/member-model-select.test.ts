/**
 * 账号池成员模型选择器的模态滚动回归测试。
 *
 * 使用方是 Vitest；挂载真实 Radix Dialog 与 Popover，验证 Portal 中的长模型列表不会
 * 被外层 Dialog 的滚动锁误判为背景滚动。测试不读取模型配置或数据库。
 */
// @vitest-environment jsdom

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BackendMemberModelOption } from "./member-model-options";
import { BackendMemberModelSelect } from "./member-model-select";

const MODEL_OPTIONS: BackendMemberModelOption[] = Array.from(
  { length: 20 },
  (_, index) => ({
    id: `video-model-${index + 1}`,
    label: `视频模型 ${index + 1}`,
    category: "video",
    source: "model_configuration",
  })
);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * 在打开的成员 Dialog 中挂载真实模型选择器。
 *
 * @returns 无返回值；组件通过 React Portal 向 document.body 写入弹层节点。
 * @sideEffects 创建 React 根节点并挂载 Dialog。
 * @failure 测试环境缺少 DOM 时由 jsdom 环境初始化失败。
 */
function mountModelSelect(): void {
  /**
   * 保存测试期间的已选模型并渲染成员模型选择器。
   *
   * @returns 测试用 Dialog 与受控模型选择器。
   * @sideEffects 仅更新当前测试根节点中的已选模型状态。
   * @failure 不抛错；选项来自本文件固定夹具。
   */
  function TestHarness() {
    const [value, setValue] = useState<string[]>([]);
    return createElement(
      Dialog,
      { open: true },
      createElement(
        DialogContent,
        null,
        createElement(DialogTitle, null, "编辑成员"),
        createElement(DialogDescription, null, "选择支持的模型"),
        createElement(BackendMemberModelSelect, {
          options: MODEL_OPTIONS,
          value,
          onChange: setValue,
          status: "ready",
        })
      )
    );
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(TestHarness)));
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("BackendMemberModelSelect", () => {
  it("允许在成员 Dialog 内用滚轮滚动长模型列表", async () => {
    mountModelSelect();

    const trigger = document.querySelector<HTMLButtonElement>("#member-models");
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());

    const list = document.querySelector<HTMLDivElement>(".max-h-72");
    expect(list).not.toBeNull();
    if (!list) return;

    list.style.overflowY = "auto";
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 288 },
      scrollHeight: { configurable: true, value: 960 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });

    act(() => list.dispatchEvent(wheelEvent));

    expect(wheelEvent.defaultPrevented).toBe(false);
  });
});
