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
    expect(container?.querySelector("pre")?.textContent).toBe(
      '{\n  "reference_mode": "media",\n  "duration": 4\n}'
    );

    await act(async () => {
      trigger?.click();
      trigger?.click();
    });
    expect(getSnapshot).toHaveBeenCalledTimes(1);
  });
});
