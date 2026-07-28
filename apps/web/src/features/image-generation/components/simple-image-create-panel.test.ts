/**
 * 简易生图表单参考图拖拽测试。
 *
 * 覆盖文件拖入反馈、投放后复用来源图回调，以及忙碌状态下拒绝投放；测试不执行
 * 文件上传或真实图片生成请求。
 */
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";

import { SimpleImageCreatePanel } from "./simple-image-create-panel";

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

/** 构造供浏览器拖拽事件消费的只读 FileList 形状。 */
function createFileList(...files: File[]): FileList {
  const fileArray = [...files];
  return Object.assign(fileArray, {
    item: (index: number) => fileArray[index] ?? null,
  });
}

/** 构造带文件传输数据的可取消拖拽事件。 */
function createFileDragEvent(type: string, files: FileList): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      files,
      types: ["Files"],
      dropEffect: "none",
    },
  });
  return event;
}

/** 挂载最小可用生图表单并返回参考图拖拽区域。 */
function mountPanel(input: {
  busy?: boolean;
  onSourceImagesChange: (files: FileList | null) => void;
}): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(SimpleImageCreatePanel, {
        balance: 100,
        background: "auto",
        busy: input.busy ?? false,
        catalog,
        error: null,
        estimatedCredits: 1,
        groupId: "group-1",
        hasAvailableModel: true,
        mask: null,
        maskAvailable: false,
        maxEditImages: 16,
        maxUploadBytes: 20 * 1024 * 1024,
        mode: "generate",
        model: "gpt-image-2",
        onBackgroundChange: vi.fn(),
        onMaskChange: vi.fn(),
        onModelSelectionChange: vi.fn(),
        onPromptChange: vi.fn(),
        onQualityChange: vi.fn(),
        onRecentReferenceSelect: vi.fn().mockResolvedValue(true),
        onRemoveReference: vi.fn(),
        onRemoveSourceImage: vi.fn(),
        onSizeChange: vi.fn(),
        onSourceImagesChange: input.onSourceImagesChange,
        onSubmit: vi.fn().mockResolvedValue(undefined),
        prompt: "生成一张测试图片",
        quality: "auto",
        recent: [],
        referenceLoadingId: null,
        resultUrls: [],
        size: "auto",
        sourceImages: [],
      })
    );
  });
  const dropZone = container.querySelector<HTMLElement>(
    '[aria-label="参考图拖拽上传区域"]'
  );
  if (!dropZone) throw new Error("参考图拖拽区域未渲染");
  return dropZone;
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

describe("SimpleImageCreatePanel reference drag and drop", () => {
  it("显示拖入反馈并把投放文件交给既有来源图回调", () => {
    const onSourceImagesChange = vi.fn();
    const dropZone = mountPanel({ onSourceImagesChange });
    const file = new File([new Uint8Array([1, 2, 3])], "reference.png", {
      type: "image/png",
    });
    const files = createFileList(file);

    act(() => dropZone.dispatchEvent(createFileDragEvent("dragenter", files)));
    expect(container?.textContent).toContain("松开即可添加参考图");

    act(() => dropZone.dispatchEvent(createFileDragEvent("drop", files)));
    expect(onSourceImagesChange).toHaveBeenCalledOnce();
    expect(onSourceImagesChange).toHaveBeenCalledWith(files);
    expect(container?.textContent).not.toContain("松开即可添加参考图");
  });

  it("生成忙碌时阻止拖拽替换参考图", () => {
    const onSourceImagesChange = vi.fn();
    const dropZone = mountPanel({ busy: true, onSourceImagesChange });
    const files = createFileList(
      new File([new Uint8Array([1])], "reference.webp", {
        type: "image/webp",
      })
    );

    act(() => dropZone.dispatchEvent(createFileDragEvent("dragenter", files)));
    expect(container?.textContent).not.toContain("松开即可添加参考图");

    act(() => dropZone.dispatchEvent(createFileDragEvent("drop", files)));
    expect(onSourceImagesChange).not.toHaveBeenCalled();
  });
});
