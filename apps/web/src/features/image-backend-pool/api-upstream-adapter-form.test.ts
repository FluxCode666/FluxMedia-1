/**
 * API 上游适配管理表单的 DOM 契约测试。
 *
 * 职责：验证默认收起的三个媒体折叠区、六个固定 Method、内置路径提示与无网络测试入口；
 * Server Action 在本测试中被替换，不启动 Worker 或访问网络。
 */
// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ execute: vi.fn(), isPending: false }),
}));
vi.mock("./actions", () => ({
  saveImageBackendMemberAction: vi.fn(),
  testApiUpstreamAdapterAction: vi.fn(),
}));

import {
  createDefaultApiUpstreamAdapterFormDraft,
  getApiUpstreamBuiltInPathHint,
  getApiUpstreamOperationMethod,
  getDefaultApiUpstreamScriptSample,
} from "./api-upstream-adapter-draft";
import { ApiUpstreamAdapterForm } from "./api-upstream-adapter-form";
import { BackendMemberFormDialog } from "./member-form";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** 挂载受控适配表单，使输入事件能真实更新 React 草稿。 */
function mountAdapterForm(): void {
  /** 保存测试草稿并渲染真实六操作表单。 */
  function TestHarness() {
    const [draft, setDraft] = useState(() =>
      createDefaultApiUpstreamAdapterFormDraft()
    );
    return createElement(ApiUpstreamAdapterForm, {
      value: draft,
      onChange: setDraft,
    });
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(TestHarness)));
}

/** 挂载 Adobe Gateway 编辑弹窗，验证 API 适配区不会跨类型泄漏。 */
function mountAdobeMemberForm(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      createElement(BackendMemberFormDialog, {
        open: true,
        onOpenChange: vi.fn(),
        onSaved: vi.fn(),
        groups: [
          {
            id: "group-a",
            name: "默认组",
            description: null,
            isEnabled: true,
            isDefault: true,
            isUserSelectable: true,
            contentSafety: "inherit",
            imageCreditOverrides: { version: 1, byModel: {} },
            videoCreditOverrides: {},
            videoCreditsPerItemOverrides: {},
            childGroupIds: [],
            priority: 0,
          },
        ],
        member: {
          id: "adobe-1",
          name: "Adobe Gateway",
          type: "adobe",
          groupIds: ["group-a"],
          supportedModelIds: ["gpt-image-2"],
          contentSafetyEnabled: true,
          isEnabled: true,
          alwaysActive: false,
          failureCooldownEnabled: true,
          priority: 10,
          concurrency: 2,
          status: "active",
          healthStatus: "healthy",
          inflightCount: 0,
          leaseAcquiredCount: 0,
          createdAt: "2026-07-26T00:00:00.000Z",
          lastAcquiredAt: null,
          lastUsedAt: null,
          lastError: null,
          lastErrorAt: null,
          config: {
            mode: "gateway",
            baseUrl: "https://adobe.example.com",
            hasApiKey: true,
            defaultRatio: "1x1",
            defaultResolution: "2k",
            gptImageQuality: "high",
          },
        },
        modelOptions: [
          {
            id: "gpt-image-2",
            label: "GPT Image 2",
            category: "image",
            source: "model_configuration",
          },
        ],
        modelOptionStatus: "ready",
      })
    )
  );
}

/** 返回正文完全匹配的按钮，避免把内层请求/响应 Tabs 混入操作 Tabs。 */
function findButtons(label: string): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button")
  ).filter((button) => button.textContent?.trim() === label);
}

/** 返回三个媒体配置折叠区的触发按钮。 */
function findMediaSectionTriggers(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      'button[data-slot="accordion-trigger"]'
    )
  );
}

/** 展开全部媒体配置折叠区，使后续断言可访问操作字段。 */
function expandAllMediaSections(): void {
  for (const trigger of findMediaSectionTriggers()) {
    act(() => trigger.click());
  }
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as typeof ResizeObserver;
  }
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("ApiUpstreamAdapterForm", () => {
  it("请求默认样例与生产信封和真实视频字段一致", () => {
    expect(
      getDefaultApiUpstreamScriptSample("videos.generate", "request")
    ).toMatchObject({
      query: {},
      body: {
        model: "seedance2",
        duration: 8,
        aspect_ratio: "16:9",
      },
    });
    expect(
      getDefaultApiUpstreamScriptSample("images.generate.query", "request")
    ).toEqual({ query: {} });
  });

  it("按文生图、图生图和生视频展示三个默认收起的折叠区", () => {
    mountAdapterForm();

    expect(document.body.textContent).toContain("文生图");
    expect(document.body.textContent).toContain("图生图");
    expect(document.body.textContent).toContain("生视频");
    expect(findMediaSectionTriggers()).toHaveLength(3);
    expect(
      findMediaSectionTriggers().every(
        (trigger) => trigger.getAttribute("aria-expanded") === "false"
      )
    ).toBe(true);

    expandAllMediaSections();
    expect(findButtons("生成")).toHaveLength(3);
    expect(findButtons("查询进度")).toHaveLength(3);
  });

  it("生成固定为 POST，查询固定为 GET 并展示内置路径提示", () => {
    mountAdapterForm();
    expandAllMediaSections();

    expect(document.body.textContent?.match(/POST/g)).toHaveLength(3);
    const generationPlaceholders = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'input[placeholder^="留空使用"]'
      )
    ).map((input) => input.placeholder);
    expect(generationPlaceholders).toContain("留空使用：/images/generations");
    expect(generationPlaceholders).toContain("留空使用：/images/edits");
    expect(generationPlaceholders).toContain("留空使用：/videos/generations");

    expect(getApiUpstreamOperationMethod("images.generate.query")).toBe("GET");
    expect(getApiUpstreamOperationMethod("images.edit.query")).toBe("GET");
    expect(getApiUpstreamOperationMethod("videos.query")).toBe("GET");
  });

  it("所有脚本区域都带无网络测试入口", () => {
    mountAdapterForm();
    expandAllMediaSections();

    expect(findButtons("测试脚本")).toHaveLength(3);
    expect(findButtons("测试脚本").every((button) => button.disabled)).toBe(
      true
    );
    expect(document.body.textContent).toContain(
      "空脚本使用系统内置行为，无需执行 QuickJS 测试"
    );
    for (const button of findButtons("响应脚本")) {
      act(() => button.click());
    }
    expect(findButtons("测试脚本")).toHaveLength(3);
  });

  it("图片查询空路径与视频查询空路径使用不同内置行为", () => {
    expect(getApiUpstreamBuiltInPathHint("images.generate.query")).toBe(
      "无内置查询路径"
    );
    expect(getApiUpstreamBuiltInPathHint("videos.query")).toBe(
      "/videos/{task_id}"
    );
  });

  it("非 API 成员不渲染六操作适配配置", () => {
    mountAdobeMemberForm();

    expect(document.body.textContent).toContain("Adobe 配置");
    expect(document.body.textContent).not.toContain("认证模式");
    expect(document.body.textContent).not.toContain("无网络测试样例");
  });
});
