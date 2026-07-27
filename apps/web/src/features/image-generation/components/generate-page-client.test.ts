/**
 * 简易生图页参考图接线的组件级回归测试。
 *
 * 通过模拟 Next.js 查询参数与图片面板，验证图库交接被传入状态容器，并且仅在状态
 * 容器完成消费后清理 URL，防止再次刷新重复添加。
 */
// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";

type CapturedImageCreatePanelProps = {
  initialReference?: unknown;
  onInitialReferenceConsumed?: () => void;
};

const testHarness = vi.hoisted(() => ({
  panelProps: null as CapturedImageCreatePanelProps | null,
  replace: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: testHarness.replace }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("./image-create-panel", () => ({
  /**
   * 捕获创作页交给图片状态容器的初始交接 props。
   *
   * @param props 初始参考图与消费回调。
   * @returns 不渲染 DOM，仅返回 null。
   * @sideEffects 将最后一次 props 写入 testHarness。
   * @failure 不执行真实图片状态逻辑，不产生渲染失败路径。
   */
  ImageCreatePanel(props: CapturedImageCreatePanelProps) {
    testHarness.panelProps = props;
    return null;
  },
}));

vi.mock("sonner", () => ({
  toast: { error: testHarness.toastError },
}));

import { GeneratePageClient } from "./generate-page-client";

const catalog: ImageGenerationModelCatalog = {
  groups: [
    {
      id: "group-1",
      name: "默认分组",
      isDefault: true,
      models: [
        {
          id: "gpt-image-2",
          capabilities: { generate: true, edit: true, mask: false },
        },
      ],
    },
  ],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * 在真实 React 根节点挂载创作页客户端容器。
 *
 * @returns 当前 React 根节点。
 * @sideEffects 向 document.body 添加测试容器并执行组件 effect。
 * @failure React 渲染失败时由 act 直接使测试失败。
 */
function mountGeneratePageClient(): Root {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(
        StrictMode,
        null,
        createElement(GeneratePageClient, {
          balance: 100,
          recentGenerations: [],
          uploadLimits: {
            maxFileSizeBytes: 10 * 1024 * 1024,
            maxUploadBytes: 20 * 1024 * 1024,
          },
          selectedBackendGroupId: "group-1",
          imageGenerationModelCatalog: catalog,
          moderationEnabled: false,
          imageModelPricing: {
            version: 1,
            byModel: {
              "gpt-image-2": {
                base1024Credits: 1,
                base1kCredits: 1,
                base2kCredits: 2,
                base4kCredits: 4,
              },
            },
          },
          imageModerationPricing: {
            imageModerationCredits: 0,
            textModerationCredits: 0,
          },
        })
      )
    );
  });
  return root;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  testHarness.panelProps = null;
  testHarness.replace.mockReset();
  testHarness.toastError.mockReset();
  window.history.replaceState(
    {},
    "",
    "/zh/dashboard/generate?tab=advanced&mode=image&ref=%2Fapi%2Fstorage%2Fgenerations%2Fuser%2Fimage.png%3Fsig%3Dabc%26exp%3D123&sourceId=generation-1&sourceName=gallery.png&intent=handoff-1&sendRef=handoff-1#workspace"
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("GeneratePageClient reference handoff", () => {
  it("把图库参考图传给图片面板并在消费后清理一次性参数", () => {
    mountGeneratePageClient();

    expect(testHarness.panelProps?.initialReference).toEqual({
      id: "handoff-1",
      imageUrl: "/api/storage/generations/user/image.png?sig=abc&exp=123",
      sourceId: "generation-1",
      sourceName: "gallery.png",
    });

    const consume = testHarness.panelProps?.onInitialReferenceConsumed;
    expect(consume).toBeTypeOf("function");
    act(() => consume?.());

    expect(testHarness.replace).toHaveBeenCalledWith(
      "/zh/dashboard/generate?tab=advanced#workspace",
      { scroll: false }
    );
  });

  it("拒绝外站参考图并一次性清理无效交接参数", () => {
    window.history.replaceState(
      {},
      "",
      "/zh/dashboard/generate?tab=advanced&mode=image&ref=https%3A%2F%2Fevil.example%2Fimage.png&sourceId=generation-1&sourceName=gallery.png&intent=handoff-1&sendRef=handoff-1#workspace"
    );
    mountGeneratePageClient();

    expect(testHarness.panelProps?.initialReference).toBeNull();
    expect(testHarness.toastError).toHaveBeenCalledWith(
      "图库参考图参数无效，请返回图库后重试"
    );
    expect(testHarness.replace).toHaveBeenCalledWith(
      "/zh/dashboard/generate?tab=advanced#workspace",
      { scroll: false }
    );
  });
});
