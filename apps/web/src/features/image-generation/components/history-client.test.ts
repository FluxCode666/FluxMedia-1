/**
 * 使用记录管理员账号身份展示测试。
 *
 * 使用方：apps/web Vitest。通过最小 DOM 挂载证明全局模式同时展示供应商账号名称与
 * ID，而个人模式不会因记录对象携带管理员字段而扩大可见范围。
 */
// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useLocale: () => "zh" }));
vi.mock("./history-filters", () => ({
  HistoryFilters: () => createElement("div", { "data-testid": "filters" }),
}));
vi.mock("./history-video-dialog", () => ({ HistoryVideoDialog: () => null }));
vi.mock("@/i18n/routing", () => ({
  Link: ({ children }: { children: ReactNode }) =>
    createElement("a", null, children),
  usePathname: () => "/dashboard/history",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

import { HistoryClient, type HistoryClientProps } from "./history-client";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** 构造包含管理员供应商账号字段的一页视频记录。 */
function createProps(showUserColumns: boolean): HistoryClientProps {
  return {
    modelOptions: [],
    nextCursor: null,
    page: 1,
    pageSizeOptions: [10, 20, 50],
    previousCursor: null,
    queryState: {
      createdFrom: null,
      createdTo: null,
      cursor: null,
      model: null,
      page: 1,
      pageSize: 20,
      status: null,
      type: null,
      userEmail: null,
    },
    records: [
      {
        aspectRatio: "16x9",
        backendAccount: {
          id: "backend-video-1",
          name: "视频供应商主账号",
        },
        completedAt: "2026-07-22T12:01:00.000Z",
        createdAt: "2026-07-22T12:00:00.000Z",
        creditsConsumed: 20,
        duration: 8,
        error: null,
        generateAudio: false,
        id: "video-1",
        input: { mode: "none", count: 0 },
        kind: "video",
        model: "seedance2",
        processingDurationSeconds: 60,
        prompt: "video prompt",
        resolution: "1080p",
        status: "completed",
        userEmail: "member@example.com",
        userId: "user-1",
        videoUrl: null,
      },
    ],
    showUserColumns,
    timeZone: "UTC",
    totalCount: 1,
  };
}

/** 挂载指定可见范围的使用记录列表。 */
function renderHistory(showUserColumns: boolean): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(HistoryClient, createProps(showUserColumns)));
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
  document.body.innerHTML = "";
});

describe("HistoryClient supplier account identity", () => {
  it("shows supplier account name and ID in global usage records", () => {
    renderHistory(true);

    expect(document.body.textContent).toContain("供应商账号（名称 / ID）");
    expect(document.body.textContent).toContain("视频供应商主账号");
    expect(document.body.textContent).toContain("backend-video-1");
  });

  it("keeps supplier account identity hidden in personal usage records", () => {
    renderHistory(false);

    expect(document.body.textContent).not.toContain("供应商账号");
    expect(document.body.textContent).not.toContain("视频供应商主账号");
    expect(document.body.textContent).not.toContain("backend-video-1");
  });

  it("shows processing duration in seconds in both responsive layouts", () => {
    renderHistory(false);

    expect(document.body.textContent).toContain("处理时长（秒）");
    expect(document.body.textContent).toContain("处理时长: 60s");
  });
});
