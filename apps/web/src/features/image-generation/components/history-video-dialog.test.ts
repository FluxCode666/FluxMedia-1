/**
 * 历史视频详情弹层输入加载测试。
 *
 * 覆盖打开弹层才调用 human-only 输入 Action，并证明任务切换后旧请求返回的签名 URL
 * 不会覆盖新任务详情；测试不连接数据库或对象存储。
 */
// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAdminHistoryRequestSnapshotAction, getVideoInputsAction } =
  vi.hoisted(() => ({
    getVideoInputsAction: vi.fn(),
    getAdminHistoryRequestSnapshotAction: vi.fn(),
  }));

vi.mock("../history-actions", () => ({
  getAdminHistoryRequestSnapshotAction,
  getVideoInputsAction,
}));
vi.mock("next-intl", () => ({ useLocale: () => "zh" }));

import {
  HistoryVideoDialog,
  type HistoryVideoDialogRecord,
} from "./history-video-dialog";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** 创建可覆盖任务身份的完整视频记录。 */
function createRecord(id: string): HistoryVideoDialogRecord {
  return {
    aspectRatio: "16x9",
    billing: {
      kind: "snapshot",
      mode: "per_second",
      unit: "second",
      unitPrice: 2.5,
      creditsPerSecond: 2.5,
      durationSeconds: 8,
      quotedCredits: 20,
      actualCredits: 20,
    },
    completedAt: "2026-07-22T12:01:00.000Z",
    createdAt: "2026-07-22T12:00:00.000Z",
    creditsConsumed: 20,
    duration: 8,
    error: null,
    generateAudio: true,
    id,
    input: { mode: "first-frame", count: 1 },
    kind: "video",
    model: "seedance2",
    prompt: "video prompt",
    resolution: "1080p",
    status: "completed",
    submissionAttempts: [
      {
        attemptNumber: 1,
        supplierName: "测试供应商",
        failureCode: "submission_timeout",
        failureReason: "生成服务请求超时，请稍后重试",
        operationsReason: "上游视频创建请求超时",
        failedAt: "2026-07-22T12:00:30.000Z",
      },
    ],
    videoUrl: "https://app.example.com/video.mp4",
  };
}

/** 挂载或更新打开状态的视频详情弹层。 */
function renderDialog(record: HistoryVideoDialogRecord): void {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(
      createElement(HistoryVideoDialog, {
        onClose: vi.fn(),
        open: true,
        record,
        timeZone: "UTC",
      })
    );
  });
}

/** 以管理员全局使用记录权限挂载视频详情。 */
function renderAdminDialog(record: HistoryVideoDialogRecord): void {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => {
    root?.render(
      createElement(HistoryVideoDialog, {
        onClose: vi.fn(),
        open: true,
        record,
        showAdminSubmissionAttempts: true,
        timeZone: "UTC",
      })
    );
  });
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  getVideoInputsAction.mockReset();
  getAdminHistoryRequestSnapshotAction.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("HistoryVideoDialog", () => {
  it("loads actual inputs on open and renders independent video facts", async () => {
    getVideoInputsAction.mockResolvedValue({
      data: {
        taskId: "video-1",
        summary: { mode: "first-frame", count: 1 },
        firstFrame: {
          url: "https://app.example.com/signed/video-1-first",
          mimeType: "image/png",
        },
      },
    });

    renderDialog(createRecord("video-1"));
    await act(async () => undefined);

    expect(getVideoInputsAction).toHaveBeenCalledWith({ taskId: "video-1" });
    expect(document.body.textContent).toContain("seedance2");
    expect(document.body.textContent).toContain("8 秒");
    expect(document.body.textContent).toContain("已启用");
    expect(document.body.textContent).toContain("首帧");
    expect(
      document.body.querySelector<HTMLImageElement>(
        'img[src="https://app.example.com/signed/video-1-first"]'
      )
    ).not.toBeNull();
  });

  it("keeps the JSON code block inside the fixed dialog width", async () => {
    getVideoInputsAction.mockResolvedValue({
      data: { taskId: "video-json", summary: { mode: "none", count: 0 } },
    });
    getAdminHistoryRequestSnapshotAction.mockResolvedValue({
      data: {
        id: "video-json",
        kind: "video",
        snapshot: {
          operation: "videos.generate",
          contentType: "application/json",
          body: { prompt: "x".repeat(12_000) },
        },
      },
    });

    renderDialog(createRecord("video-json"));
    await act(async () => undefined);

    // The admin-only section is mounted explicitly here to exercise the same
    // long-line layout used by the global history page.
    act(() => {
      root?.render(
        createElement(HistoryVideoDialog, {
          onClose: vi.fn(),
          open: true,
          record: createRecord("video-json"),
          showAdminRequestJson: true,
          timeZone: "UTC",
        })
      );
    });
    await act(async () => undefined);

    const dialog = document.querySelector('[role="dialog"]');
    const layout = Array.from(dialog?.children ?? []).find((child) =>
      child.className.includes("grid")
    );
    expect(layout?.className).toContain("min-w-0");

    const trigger = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.includes("实际请求 JSON")
    );
    expect(trigger).not.toBeUndefined();
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    expect(dialog?.querySelector("pre")).not.toBeNull();
  });

  it("only reveals submission failure details in global usage records", async () => {
    getVideoInputsAction.mockResolvedValue({
      data: { taskId: "video-admin", summary: { mode: "none", count: 0 } },
    });
    renderDialog(createRecord("video-admin"));
    await act(async () => undefined);

    expect(document.body.textContent).not.toContain("提交失败记录");
    renderAdminDialog(createRecord("video-admin"));
    await act(async () => undefined);

    expect(document.body.textContent).toContain("提交失败记录");
    expect(document.body.textContent).toContain("测试供应商");
    expect(document.body.textContent).toContain("submission_timeout");
    expect(document.body.textContent).toContain("生成服务请求超时，请稍后重试");
  });

  it("退款后同时展示按条原报价和实际消费零", async () => {
    getVideoInputsAction.mockResolvedValue({
      data: { taskId: "video-refunded", summary: { mode: "none", count: 0 } },
    });
    renderDialog({
      ...createRecord("video-refunded"),
      creditsConsumed: 0,
      billing: {
        kind: "snapshot",
        mode: "per_item",
        unit: "item",
        unitPrice: 3,
        durationSeconds: 8,
        quotedCredits: 3,
        actualCredits: 0,
      },
    });
    await act(async () => undefined);

    expect(document.body.textContent).toContain("按条");
    expect(document.body.textContent).toContain("3 积分/条");
    expect(document.body.textContent).toContain("原报价积分");
    expect(document.body.textContent).toContain("实际积分");
  });

  it("legacy 历史明确显示未知创建单价", async () => {
    getVideoInputsAction.mockResolvedValue({
      data: { taskId: "video-legacy", summary: { mode: "none", count: 0 } },
    });
    renderDialog({
      ...createRecord("video-legacy"),
      billing: {
        kind: "legacy",
        mode: "per_second",
        unit: "second",
        unitPrice: null,
        creditsPerSecond: null,
        quotedCredits: null,
        actualCredits: 20,
      },
    });
    await act(async () => undefined);

    expect(document.body.textContent).toContain("按秒（旧任务）");
    expect(document.body.textContent).toContain("未知");
  });

  it("does not reuse a previous task signed URL after switching records", async () => {
    let resolveFirst:
      | ((value: {
          data: {
            taskId: string;
            summary: { mode: "first-frame"; count: number };
            firstFrame: { url: string; mimeType: string };
          };
        }) => void)
      | undefined;
    getVideoInputsAction
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({
        data: {
          taskId: "video-2",
          summary: { mode: "first-frame", count: 1 },
          firstFrame: {
            url: "https://app.example.com/signed/video-2-first",
            mimeType: "image/png",
          },
        },
      });

    renderDialog(createRecord("video-1"));
    renderDialog(createRecord("video-2"));
    await act(async () => undefined);
    await act(async () => {
      resolveFirst?.({
        data: {
          taskId: "video-1",
          summary: { mode: "first-frame", count: 1 },
          firstFrame: {
            url: "https://app.example.com/signed/video-1-first",
            mimeType: "image/png",
          },
        },
      });
    });

    expect(
      document.body.querySelector<HTMLImageElement>(
        'img[src="https://app.example.com/signed/video-2-first"]'
      )
    ).not.toBeNull();
    expect(document.body.innerHTML).not.toContain("video-1-first");
  });
});
