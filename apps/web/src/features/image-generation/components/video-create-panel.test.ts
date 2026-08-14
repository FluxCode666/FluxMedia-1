/**
 * 视频创作面板组件级回归测试。
 *
 * 使用真实 React 根节点验证能力查询未完成时 fail closed，以及参考图模型在动态
 * 能力返回后直接进入 references 模式；测试不连接数据库或真实视频供应商。
 */
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  parseVideoTaskResponse,
  resolveNextVideoPollDelay,
  VIDEO_STATUS_INITIAL_POLL_MS,
  VideoCreatePanel,
} from "./video-create-panel";

const veoReferenceCapabilities = {
  items: [
    {
      model: "veo31-ref",
      displayName: "Veo 3.1 Reference",
      durations: [4, 6, 8],
      aspectRatios: ["16:9", "9:16"],
      resolutions: ["1080p", "720p"],
      input: {
        frames: "none",
        referenceImages: { maxCount: 3, configurable: false },
        framesAndReferencesMutuallyExclusive: true,
      },
      audio: { supported: false, defaultEnabled: false },
      configuredReachable: true,
    },
  ],
  limits: {
    maxMediaInputCount: 256,
    maxMediaInputBytes: 536_870_912,
  },
} as const;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** 在 jsdom 中挂载真实视频面板。 */
function mountVideoCreatePanel(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(VideoCreatePanel, {
        initialSelection: {
          modelId: "veo31-ref",
          duration: 4,
          aspectRatio: "16:9",
          resolution: "1080p",
        },
        pricing: {
          creditsPerSecond: {
            "veo31-ref": 45,
            "veo31-ref@1080p": 45,
            "veo31-ref@720p": 30,
          },
        },
      })
    );
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("VideoCreatePanel capabilities", () => {
  it("只接受视频四态并继续轮询 queued/in_progress", () => {
    expect(
      parseVideoTaskResponse({ taskId: "video-1", status: "queued" })
    ).toEqual({ taskId: "video-1", status: "queued" });
    expect(
      parseVideoTaskResponse({ taskId: "video-1", status: "in_progress" })
    ).toEqual({ taskId: "video-1", status: "in_progress" });
    for (const status of [
      "pending",
      "submitting",
      "processing",
      "needs_attention",
    ]) {
      expect(() =>
        parseVideoTaskResponse({ taskId: "video-1", status })
      ).toThrow("视频任务响应格式无效");
    }
  });

  it("BullMQ 模式首轮 3 秒查询并有界退避到 2 分钟", () => {
    expect(VIDEO_STATUS_INITIAL_POLL_MS).toBe(3_000);
    expect(resolveNextVideoPollDelay(3_000)).toBe(4_500);
    expect(resolveNextVideoPollDelay(100_000)).toBe(120_000);
    expect(resolveNextVideoPollDelay(120_000)).toBe(120_000);
  });

  it("能力请求未完成时禁用生成与输入控件", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined))
    );

    mountVideoCreatePanel();

    const generateButton = Array.from(
      container?.querySelectorAll("button") ?? []
    ).find((button) => button.textContent?.trim() === "生成视频");
    expect(generateButton?.disabled).toBe(true);
    expect(
      container?.querySelector<HTMLTextAreaElement>("textarea")?.disabled
    ).toBe(true);
    expect(container?.textContent).toContain("正在同步当前分组的视频模型能力");
  });

  it("纯参考图模型能力就绪后默认显示 references 输入", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(veoReferenceCapabilities, { status: 200 })
        )
    );

    mountVideoCreatePanel();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain(
      "参考图（可选，模型上限 3 张；单次最多 3 张）"
    );
    expect(container?.textContent).toContain(
      "基础设施限制：所有媒体输入合计最多256 张、512 MB"
    );
    expect(container?.textContent).not.toContain("首尾帧（可选");
    expect(
      container?.querySelector<HTMLTextAreaElement>("textarea")?.disabled
    ).toBe(false);
  });
});
