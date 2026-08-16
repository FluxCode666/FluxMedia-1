/**
 * 分组视频双价格编辑器测试。
 *
 * 职责：锁定模型分辨率矩阵、全局继承提示、只读模式展示，以及清空单元格后压缩为
 * 稀疏覆盖；不调用 Server Action 或数据库。
 */
// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createVideoCreditPricingDraft,
  updateVideoCreditPricingDraft,
  VideoCreditPricingEditor,
  type VideoCreditPricingModel,
  videoCreditPricingDraftToOverrides,
} from "./video-credit-pricing-editor";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const models: VideoCreditPricingModel[] = [
  {
    modelId: "sora-2",
    displayName: "Sora 2",
    billingMode: "per_item",
    supportedResolutions: ["720p", "1080p"],
    globalCreditsPerSecondByResolution: { "720p": 30, "1080p": 45 },
    globalCreditsPerItemByResolution: { "720p": 3, "1080p": 5 },
  },
  {
    modelId: "veo-3.1",
    displayName: "Veo 3.1",
    billingMode: "per_second",
    supportedResolutions: ["1080p"],
    globalCreditsPerSecondByResolution: { "1080p": 60 },
    globalCreditsPerItemByResolution: { "1080p": 8 },
  },
];

/** 挂载指定 React 节点并同步刷新 DOM。 */
function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("video credit pricing editor", () => {
  it("展示每个模型的全局模式、全部分辨率和双价格继承值", () => {
    mount(
      createElement(VideoCreditPricingEditor, {
        models,
        draft: createVideoCreditPricingDraft(models, {}, {}),
        onChange: vi.fn(),
      })
    );

    expect(container?.textContent).toContain("Sora 2");
    expect(container?.textContent).toContain("当前全局模式：按条");
    expect(container?.textContent).toContain("当前全局模式：按秒");
    expect(container?.textContent).toContain("720p");
    expect(container?.textContent).toContain("1080p");
    expect(
      container?.querySelector<HTMLInputElement>(
        'input[aria-label="Sora 2 1080p 按秒积分覆盖"]'
      )?.placeholder
    ).toBe("45");
    expect(
      container?.querySelector<HTMLInputElement>(
        'input[aria-label="Sora 2 1080p 按条积分覆盖"]'
      )?.placeholder
    ).toBe("5");
    expect(container?.querySelector("select")).toBeNull();
  });

  it("把旧模型级按秒覆盖展开到分辨率且清空单元格表示继承", () => {
    const initial = createVideoCreditPricingDraft(
      models,
      { "sora-2": 40 },
      { "sora-2@1080p": 6 }
    );
    expect(initial).toEqual({
      perSecond: {
        "sora-2@720p": "40",
        "sora-2@1080p": "40",
      },
      perItem: { "sora-2@1080p": "6" },
    });

    const cleared = updateVideoCreditPricingDraft(
      initial,
      "per_item",
      "sora-2",
      "1080p",
      ""
    );
    expect(videoCreditPricingDraftToOverrides(cleared)).toEqual({
      perSecond: {
        "sora-2@720p": 40,
        "sora-2@1080p": 40,
      },
      perItem: {},
    });
  });

  it("保留两种模式和不同模型的独立稀疏草稿", () => {
    const initial = createVideoCreditPricingDraft(models, {}, {});
    const withSecond = updateVideoCreditPricingDraft(
      initial,
      "per_second",
      "veo-3.1",
      "1080p",
      "70"
    );
    const withItem = updateVideoCreditPricingDraft(
      withSecond,
      "per_item",
      "sora-2",
      "720p",
      "4.5"
    );

    expect(videoCreditPricingDraftToOverrides(withItem)).toEqual({
      perSecond: { "veo-3.1@1080p": 70 },
      perItem: { "sora-2@720p": 4.5 },
    });
  });
});
