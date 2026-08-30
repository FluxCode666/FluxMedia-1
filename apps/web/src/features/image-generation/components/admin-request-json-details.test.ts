/**
 * 管理端真实请求 JSON 折叠区测试。
 *
 * 证明组件默认关闭、首次展开才读取管理员 Action，并使用两个空格格式化最终 Body。
 */
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSnapshot } = vi.hoisted(() => ({ getSnapshot: vi.fn() }));
const writeClipboardText = vi.fn<(text: string) => Promise<void>>();

vi.mock("next-intl", () => ({ useLocale: () => "zh" }));
vi.mock("../history-actions", () => ({
  getAdminHistoryRequestSnapshotAction: getSnapshot,
}));

import { AdminRequestJsonDetails } from "./admin-request-json-details";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  getSnapshot.mockReset();
  writeClipboardText.mockReset();
  writeClipboardText.mockResolvedValue();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: writeClipboardText },
  });
  getSnapshot.mockResolvedValue({
    data: {
      id: "video-1",
      kind: "video",
      snapshot: {
        operation: "videos.generate",
        contentType: "application/json",
        body: { reference_mode: "media", duration: 4 },
      },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("AdminRequestJsonDetails", () => {
  it("defaults collapsed and lazily renders formatted request JSON", async () => {
    await act(async () => {
      root?.render(
        createElement(AdminRequestJsonDetails, {
          id: "video-1",
          kind: "video",
        })
      );
    });

    const trigger = container?.querySelector("button");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(container?.textContent).not.toContain("reference_mode");

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(getSnapshot).toHaveBeenCalledWith({
      id: "video-1",
      kind: "video",
    });
    expect(
      Array.from(container?.querySelectorAll("pre code > span") ?? []).map(
        (line) => line.textContent
      )
    ).toEqual(["{", '  "reference_mode": "media",', '  "duration": 4', "}"]);

    const copyButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="复制"]'
    );
    expect(copyButton).not.toBeNull();

    await act(async () => {
      copyButton?.click();
      await Promise.resolve();
    });
    expect(writeClipboardText).toHaveBeenCalledWith(
      '{\n  "reference_mode": "media",\n  "duration": 4\n}'
    );
    expect(copyButton?.getAttribute("aria-label")).toBe("已复制");

    await act(async () => {
      trigger?.click();
      trigger?.click();
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps the details visible when a legacy body cannot be serialized", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    getSnapshot.mockResolvedValue({
      data: {
        id: "video-1",
        kind: "video",
        snapshot: {
          operation: "videos.generate",
          contentType: "application/json",
          body: circular,
        },
      },
    });

    await act(async () => {
      root?.render(
        createElement(AdminRequestJsonDetails, {
          id: "video-1",
          kind: "video",
        })
      );
    });

    const trigger = container?.querySelector<HTMLButtonElement>("button");
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("实际请求 JSON");
    expect(container?.textContent).toContain(
      "已保存的请求正文无法格式化显示。"
    );
    expect(container?.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("unwraps a legacy JSON-encoded body before formatting it", async () => {
    getSnapshot.mockResolvedValue({
      data: {
        id: "video-1",
        kind: "video",
        snapshot: {
          operation: "videos.generate",
          contentType: "application/json",
          body: '{"prompt":"hello","duration":4}',
        },
      },
    });

    await act(async () => {
      root?.render(
        createElement(AdminRequestJsonDetails, {
          id: "video-1",
          kind: "video",
        })
      );
    });

    const trigger = container?.querySelector<HTMLButtonElement>("button");
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    expect(
      Array.from(container?.querySelectorAll("pre code > span") ?? []).map(
        (line) => line.textContent
      )
    ).toEqual(["{", '  "prompt": "hello",', '  "duration": 4', "}"]);
  });

  it("does not mount one DOM node per line for a large request body", async () => {
    getSnapshot.mockResolvedValue({
      data: {
        id: "video-1",
        kind: "video",
        snapshot: {
          operation: "videos.generate",
          contentType: "application/json",
          body: { items: Array.from({ length: 2_100 }, (_, index) => index) },
        },
      },
    });

    await act(async () => {
      root?.render(
        createElement(AdminRequestJsonDetails, {
          id: "video-1",
          kind: "video",
        })
      );
    });

    const trigger = container?.querySelector<HTMLButtonElement>("button");
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    const code = container?.querySelector("pre code");
    expect(code?.querySelectorAll(":scope > span")).toHaveLength(1);
    expect(code?.textContent).toContain('"items"');
  });

  it("rejects an unexpectedly large legacy body before mounting it", async () => {
    getSnapshot.mockResolvedValue({
      data: {
        id: "video-1",
        kind: "video",
        snapshot: {
          operation: "videos.generate",
          contentType: "application/json",
          body: { prompt: "x".repeat(300_000) },
        },
      },
    });

    await act(async () => {
      root?.render(
        createElement(AdminRequestJsonDetails, {
          id: "video-1",
          kind: "video",
        })
      );
    });

    const trigger = container?.querySelector<HTMLButtonElement>("button");
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain(
      "已保存的请求正文无法格式化显示。"
    );
    expect(container?.querySelector("pre")).toBeNull();
  });
});
