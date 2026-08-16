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

import { parseReachableVideoCreateModels } from "../video-create-capabilities";
import {
  parseVideoQuoteConflictResponse,
  parseVideoTaskResponse,
  replaceVideoCreateModelQuote,
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
      billing: [
        {
          kind: "current_quote",
          resolution: "1080p",
          mode: "per_item",
          unit: "item",
          unitPrice: 3,
          quoteToken: "quote-veo31-ref-1080p",
        },
        {
          kind: "current_quote",
          resolution: "720p",
          mode: "per_item",
          unit: "item",
          unitPrice: 3,
          quoteToken: "quote-veo31-ref-720p",
        },
      ],
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
  it("陈旧报价冲突只接受严格 current_quote 并替换所选分辨率", () => {
    const parsed = parseVideoQuoteConflictResponse({
      error: "视频报价已更新，请确认最新价格后重试",
      code: "conflict",
      reason: "stale_video_quote",
      currentQuote: {
        kind: "current_quote",
        resolution: "1080p",
        mode: "per_second",
        unit: "second",
        unitPrice: 4,
        creditsPerSecond: 4,
        quoteToken: "fresh-token",
      },
    });

    expect(parsed?.currentQuote.quoteToken).toBe("fresh-token");
    const updated = replaceVideoCreateModelQuote(
      parseReachableVideoCreateModels(veoReferenceCapabilities),
      "veo31-ref",
      parsed?.currentQuote ?? veoReferenceCapabilities.items[0].billing[0]
    );
    expect(updated[0]?.billing).toEqual([
      parsed?.currentQuote,
      veoReferenceCapabilities.items[0].billing[1],
    ]);
    expect(
      parseVideoQuoteConflictResponse({
        error: "invalid",
        code: "conflict",
        reason: "stale_video_quote",
        currentQuote: {
          ...parsed?.currentQuote,
          billingGroupId: "internal-group",
        },
      })
    ).toBeNull();
  });

  it("只接受视频四态并继续轮询 queued/in_progress", () => {
    const billing = {
      kind: "snapshot" as const,
      mode: "per_item" as const,
      unit: "item" as const,
      unitPrice: 3,
      durationSeconds: 4,
      quotedCredits: 3,
      actualCredits: 0,
    };
    expect(
      parseVideoTaskResponse({ taskId: "video-1", status: "queued", billing })
    ).toEqual({ taskId: "video-1", status: "queued", billing });
    expect(
      parseVideoTaskResponse({
        taskId: "video-1",
        status: "in_progress",
        billing,
      })
    ).toEqual({ taskId: "video-1", status: "in_progress", billing });
    const legacyBilling = {
      kind: "legacy" as const,
      mode: "per_second" as const,
      unit: "second" as const,
      unitPrice: null,
      creditsPerSecond: null,
      quotedCredits: null,
      actualCredits: 12,
    };
    expect(
      parseVideoTaskResponse({
        taskId: "legacy-video-1",
        status: "completed",
        billing: legacyBilling,
      })
    ).toEqual({
      taskId: "legacy-video-1",
      status: "completed",
      billing: legacyBilling,
    });
    for (const status of [
      "pending",
      "submitting",
      "processing",
      "needs_attention",
    ]) {
      expect(() =>
        parseVideoTaskResponse({ taskId: "video-1", status, billing })
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
