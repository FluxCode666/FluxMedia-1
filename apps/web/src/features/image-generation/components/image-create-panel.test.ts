/**
 * 图片创作状态容器的生成结果与图库参考图回归测试。
 *
 * 通过模拟展示组件、生成响应与图片下载，验证新产物会进入近期列表，且初始图库引用会
 * 经过既有上传边界校验、转换为 File 并自动切换到图生图模式；测试不访问真实服务。
 */
// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";

type CapturedSimplePanelProps = {
  error?: string | null;
  mode?: string;
  onPromptChange?: (value: string) => void;
  onRemoveSourceImage?: (index: number) => void;
  onSourceImagesChange?: (files: FileList | null) => void;
  onSubmit?: () => Promise<void>;
  recent?: ReadonlyArray<{
    id: string;
    imageUrl: string | null;
    prompt: string;
  }>;
  referenceLoadingId?: string | null;
  resultUrls?: readonly string[];
  size?: string;
  sourceImages?: readonly File[];
};

const testHarness = vi.hoisted(() => ({
  panelProps: null as CapturedSimplePanelProps | null,
}));

vi.mock("./simple-image-create-panel", () => ({
  /**
   * 捕获状态容器交给展示层的 props，供测试断言异步交接结果。
   *
   * @param props 当前展示层输入与交互回调。
   * @returns 不渲染 DOM，仅返回 null。
   * @sideEffects 将最后一次 props 写入 testHarness。
   * @failure 不执行真实展示逻辑，不产生渲染失败路径。
   */
  SimpleImageCreatePanel(props: CapturedSimplePanelProps) {
    testHarness.panelProps = props;
    return null;
  },
}));

import { ImageCreatePanel } from "./image-create-panel";

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

const initialReference = {
  id: "handoff-1",
  imageUrl: "/api/storage/generations/user/image.png?sig=abc&exp=123",
  sourceId: "generation-1",
  sourceName: "gallery.png",
};

/**
 * 构造带可信图片 MIME 的响应，覆盖真实 fetch 的 Headers 与流式响应体语义。
 *
 * @param bytes 图片响应字节。
 * @param type 响应声明的图片 MIME。
 * @returns 可由参考图下载器消费的标准 Response。
 * @sideEffects 无。
 * @failure Response 构造失败时直接使测试失败。
 */
function createImageResponse(bytes: Uint8Array, type = "image/png"): Response {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return new Response(body.buffer, { headers: { "content-type": type } });
}

/**
 * 构造供来源图片回调消费的 FileList 形状。
 *
 * @param files 需要放入列表的浏览器 File。
 * @returns 带 item 方法的只读文件列表形状。
 * @sideEffects 无。
 * @failure 越界读取返回 null。
 */
function createFileList(...files: File[]): FileList {
  const fileArray = [...files];
  return Object.assign(fileArray, {
    item: (index: number) => fileArray[index] ?? null,
  });
}

/**
 * 在 Strict Mode 根节点挂载带初始图库交接的图片状态容器。
 *
 * @param onInitialReferenceConsumed 一次性交接完成回调。
 * @param options 可覆盖的上传限制与首屏近期图片。
 * @param reference 可选的一次性图库交接意图。
 * @returns 无；根节点与容器写入测试级变量供清理。
 * @sideEffects 向 document.body 添加容器并启动初始参考图 effect。
 * @failure React 渲染失败时由 act 传播并使测试失败。
 */
function mountImageCreatePanel(
  onInitialReferenceConsumed: () => void,
  options: {
    maxEditImages?: number;
    maxFileSizeBytes?: number;
    maxUploadBytes?: number;
    recent?: Array<{
      id: string;
      imageUrl: string | null;
      prompt: string;
    }>;
  } = {},
  reference: typeof initialReference | null = initialReference
): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(
        StrictMode,
        null,
        createElement(ImageCreatePanel, {
          balance: 100,
          catalog,
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
          maxFileSizeBytes: options.maxFileSizeBytes ?? 10 * 1024 * 1024,
          maxUploadBytes: options.maxUploadBytes ?? 20 * 1024 * 1024,
          maxEditImages: options.maxEditImages ?? 16,
          moderationEnabled: false,
          onCreditsConsumed: vi.fn(),
          recent: options.recent ?? [],
          selectedBackendGroupId: "group-1",
          initialReference: reference,
          onInitialReferenceConsumed,
        })
      )
    );
  });
}

/**
 * 等待当前图片下载 Promise 与 React 状态更新完成。
 *
 * @returns 所有已排队微任务完成后的 Promise。
 * @sideEffects 推进组件异步 effect。
 * @failure effect 抛错时由 act 传播并使测试失败。
 */
async function flushReferenceLoad(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  testHarness.panelProps = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ImageCreatePanel", () => {
  it("生成成功后立即把新图片加入最近图片首位", async () => {
    const generationId = "generation-new";
    const imageUrl = "/api/storage/generations/user/new.png?sig=abc&exp=123";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          generationId,
          imageUrl,
          creditsConsumed: 2,
        })
      )
    );
    mountImageCreatePanel(
      vi.fn(),
      {
        recent: [
          {
            id: "generation-old",
            imageUrl: "/api/storage/generations/user/old.png?sig=abc&exp=123",
            prompt: "旧图片",
          },
        ],
      },
      null
    );

    act(() => testHarness.panelProps?.onPromptChange?.("新图片"));
    await act(async () => testHarness.panelProps?.onSubmit?.());

    expect(testHarness.panelProps?.resultUrls).toEqual([imageUrl]);
    expect(testHarness.panelProps?.recent).toEqual([
      {
        id: generationId,
        imageUrl,
        prompt: "新图片",
      },
      {
        id: "generation-old",
        imageUrl: "/api/storage/generations/user/old.png?sig=abc&exp=123",
        prompt: "旧图片",
      },
    ]);
  });

  it("首屏默认使用 auto 尺寸", () => {
    mountImageCreatePanel(vi.fn(), {}, null);

    expect(testHarness.panelProps?.size).toBe("auto");
  });

  it("只下载一次图库图片并将其设为图生图来源", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(createImageResponse(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    const onInitialReferenceConsumed = vi.fn();
    mountImageCreatePanel(onInitialReferenceConsumed);
    await flushReferenceLoad();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/storage/generations/user/image.png?sig=abc&exp=123",
      {
        credentials: "same-origin",
        signal: expect.any(AbortSignal),
      }
    );
    expect(testHarness.panelProps?.mode).toBe("edit");
    expect(testHarness.panelProps?.sourceImages).toHaveLength(1);
    const sourceImage = testHarness.panelProps?.sourceImages?.[0];
    expect(sourceImage?.name).toBe("gallery.png");
    expect(sourceImage?.type).toBe("image/png");
    expect(sourceImage?.size).toBe(3);
    expect(onInitialReferenceConsumed).toHaveBeenCalledTimes(1);
  });

  it("支持分批追加参考图并逐张移除", () => {
    mountImageCreatePanel(vi.fn(), {}, null);
    const first = new File([new Uint8Array([1])], "first.png", {
      type: "image/png",
    });
    const second = new File([new Uint8Array([2])], "second.webp", {
      type: "image/webp",
    });

    act(() =>
      testHarness.panelProps?.onSourceImagesChange?.(createFileList(first))
    );
    act(() =>
      testHarness.panelProps?.onSourceImagesChange?.(createFileList(second))
    );

    expect(testHarness.panelProps?.sourceImages).toEqual([first, second]);
    expect(testHarness.panelProps?.mode).toBe("edit");

    act(() => testHarness.panelProps?.onRemoveSourceImage?.(0));
    expect(testHarness.panelProps?.sourceImages).toEqual([second]);
    expect(testHarness.panelProps?.mode).toBe("edit");
  });

  it("超过系统图片数量时保留已经选择的参考图", () => {
    mountImageCreatePanel(vi.fn(), { maxEditImages: 1 }, null);
    const first = new File([new Uint8Array([1])], "first.png", {
      type: "image/png",
    });
    const second = new File([new Uint8Array([2])], "second.png", {
      type: "image/png",
    });

    act(() =>
      testHarness.panelProps?.onSourceImagesChange?.(createFileList(first))
    );
    act(() =>
      testHarness.panelProps?.onSourceImagesChange?.(createFileList(second))
    );

    expect(testHarness.panelProps?.sourceImages).toEqual([first]);
    expect(testHarness.panelProps?.error).toBe("参考图最多可添加 1 张");
  });

  it("下载失败时给出可执行恢复提示并结束一次性交接", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    );
    const onInitialReferenceConsumed = vi.fn();
    mountImageCreatePanel(onInitialReferenceConsumed);
    await flushReferenceLoad();

    expect(testHarness.panelProps?.error).toBe(
      "参考图片读取失败，请返回图库后重试"
    );
    expect(testHarness.panelProps?.referenceLoadingId).toBeNull();
    expect(onInitialReferenceConsumed).toHaveBeenCalledTimes(1);
  });

  it("用户手动选图后不会被迟到的图库下载覆盖", async () => {
    let resolveDownload: ((response: Response) => void) | undefined;
    const pendingDownload = new Promise<Response>((resolve) => {
      resolveDownload = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pendingDownload));
    const onInitialReferenceConsumed = vi.fn();
    mountImageCreatePanel(onInitialReferenceConsumed);

    const localFile = new File([new Uint8Array([9])], "local.png", {
      type: "image/png",
    });
    act(() =>
      testHarness.panelProps?.onSourceImagesChange?.(createFileList(localFile))
    );
    expect(testHarness.panelProps?.sourceImages?.[0]).toBe(localFile);
    expect(onInitialReferenceConsumed).toHaveBeenCalledTimes(1);

    resolveDownload?.(createImageResponse(new Uint8Array([1, 2, 3])));
    await flushReferenceLoad();

    expect(testHarness.panelProps?.sourceImages?.[0]).toBe(localFile);
    expect(onInitialReferenceConsumed).toHaveBeenCalledTimes(1);
  });

  it("参考图加载完成前阻止提交文生图请求", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    mountImageCreatePanel(vi.fn());
    act(() => testHarness.panelProps?.onPromptChange?.("保留参考图构图"));

    await act(async () => testHarness.panelProps?.onSubmit?.());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const localFile = new File([new Uint8Array([9])], "local.png", {
      type: "image/png",
    });
    act(() =>
      testHarness.panelProps?.onSourceImagesChange?.(createFileList(localFile))
    );
    await flushReferenceLoad();
  });

  it("拒绝非图片响应并结束一次性交接", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          createImageResponse(new Uint8Array([1, 2, 3]), "text/plain")
        )
    );
    const onInitialReferenceConsumed = vi.fn();
    mountImageCreatePanel(onInitialReferenceConsumed);
    await flushReferenceLoad();

    expect(testHarness.panelProps?.error).toBe(
      "参考图片不是可用的 PNG、JPEG 或 WebP 文件"
    );
    expect(testHarness.panelProps?.referenceLoadingId).toBeNull();
    expect(onInitialReferenceConsumed).toHaveBeenCalledTimes(1);
  });

  it("流式响应超限时取消读取并显示上传限制", async () => {
    let streamCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { headers: { "content-type": "image/png" } })
        )
    );
    const onInitialReferenceConsumed = vi.fn();
    mountImageCreatePanel(onInitialReferenceConsumed, {
      maxFileSizeBytes: 2,
      maxUploadBytes: 2,
    });
    await flushReferenceLoad();

    expect(streamCancelled).toBe(true);
    expect(testHarness.panelProps?.error).toBe("参考图片超过系统上传限制");
    expect(onInitialReferenceConsumed).toHaveBeenCalledTimes(1);
  });

  it("下载超时后中止请求并清理加载状态", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const onInitialReferenceConsumed = vi.fn();
    mountImageCreatePanel(onInitialReferenceConsumed);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await flushReferenceLoad();

    expect(testHarness.panelProps?.error).toBe(
      "参考图片读取超时，请返回图库后重试"
    );
    expect(testHarness.panelProps?.referenceLoadingId).toBeNull();
    expect(onInitialReferenceConsumed).toHaveBeenCalledTimes(1);
  });
});
