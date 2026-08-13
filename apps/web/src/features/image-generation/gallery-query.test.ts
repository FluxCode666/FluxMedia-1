/**
 * 图库客户端查询状态机测试。
 *
 * 覆盖请求锁、尾部追加、ID 去重、同游标重试、no-progress 停止与世代隔离，
 * 为 IntersectionObserver 和键盘入口提供同一套 DB-free 行为基础。
 */

import { describe, expect, it } from "vitest";
import {
  beginGalleryAppend,
  beginGalleryInitial,
  createGalleryQueryState,
  failGalleryRequest,
  resetGalleryQueryState,
  resolveGalleryRequest,
} from "./gallery-query";

interface TestItem {
  id: string;
  label: string;
}

/** 构造带稳定 ID 的最小图库测试卡片。 */
function item(id: string): TestItem {
  return { id, label: `item-${id}` };
}

describe("gallery query state", () => {
  /** 首批有后续边界时进入 ready，没有边界时直接进入 end。 */
  it("derives the initial phase from the first batch", () => {
    expect(
      createGalleryQueryState({ items: [item("1")], nextCursor: "cursor-2" })
        .phase
    ).toBe("ready");
    expect(
      createGalleryQueryState({ items: [item("1")], nextCursor: null }).phase
    ).toBe("end");
  });

  /** 首批失败保持显式 initialError，并允许无 cursor 重试而不伪装为空列表。 */
  it("keeps an initial failure retryable", () => {
    const started = beginGalleryInitial(createGalleryQueryState<TestItem>());
    if (!started.request) {
      throw new Error("Expected initial request");
    }
    const failed = failGalleryRequest(
      started.state,
      started.request,
      "initial failure"
    );
    const retry = beginGalleryInitial(failed);

    expect(failed).toMatchObject({
      error: "initial failure",
      items: [],
      phase: "initialError",
    });
    expect(retry.request).toMatchObject({ cursor: null, kind: "initial" });
  });

  /** 重复触底共享同一活动请求，防止相同边界被并发读取。 */
  it("locks an active append request", () => {
    const initial = createGalleryQueryState({
      items: [item("1")],
      nextCursor: "cursor-2",
    });
    const first = beginGalleryAppend(initial);
    expect(first.request).toMatchObject({ cursor: "cursor-2", generation: 0 });
    expect(first.state.phase).toBe("appending");
    expect(beginGalleryAppend(first.state)).toEqual({
      request: null,
      state: first.state,
    });
  });

  /** 新批次仅将新 ID 按响应顺序追加在旧卡片尾部。 */
  it("appends unique cards without replacing or reordering existing cards", () => {
    const started = beginGalleryAppend(
      createGalleryQueryState({
        items: [item("1"), item("2")],
        nextCursor: "cursor-2",
      })
    );
    if (!started.request) {
      throw new Error("Expected append request");
    }
    const resolved = resolveGalleryRequest(started.state, started.request, {
      items: [item("2"), item("3"), item("3"), item("4")],
      nextCursor: "cursor-3",
    });

    expect(resolved.items.map((entry) => entry.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(resolved.phase).toBe("ready");
    expect(resolved.nextCursor).toBe("cursor-3");
  });

  /** 追加失败保留旧卡和原游标，重试仍读取同一边界。 */
  it("keeps the same cursor and cards after an append failure", () => {
    const started = beginGalleryAppend(
      createGalleryQueryState({
        items: [item("1")],
        nextCursor: "cursor-2",
      })
    );
    if (!started.request) {
      throw new Error("Expected append request");
    }
    const failed = failGalleryRequest(
      started.state,
      started.request,
      "temporary failure"
    );
    const retry = beginGalleryAppend(failed);

    expect(failed.items).toEqual([item("1")]);
    expect(failed.phase).toBe("appendError");
    expect(retry.request?.cursor).toBe("cursor-2");
  });

  /** 无新卡或服务端返回同一游标时收敛到末尾，避免自动加载死循环。 */
  it("stops on zero progress or a repeated cursor", () => {
    const started = beginGalleryAppend(
      createGalleryQueryState({
        items: [item("1")],
        nextCursor: "cursor-2",
      })
    );
    if (!started.request) {
      throw new Error("Expected append request");
    }
    const noProgress = resolveGalleryRequest(started.state, started.request, {
      items: [item("1")],
      nextCursor: "cursor-3",
    });
    const repeatedCursor = resolveGalleryRequest(
      started.state,
      started.request,
      {
        items: [item("2")],
        nextCursor: "cursor-2",
      }
    );

    expect(noProgress).toMatchObject({ nextCursor: null, phase: "end" });
    expect(repeatedCursor).toMatchObject({ nextCursor: null, phase: "end" });
  });

  /** 标签或筛选切换后的旧世代响应不能污染新列表。 */
  it("ignores a slow response from an obsolete generation", () => {
    const started = beginGalleryAppend(
      createGalleryQueryState({
        items: [item("1")],
        nextCursor: "cursor-2",
      })
    );
    if (!started.request) {
      throw new Error("Expected append request");
    }
    const reset = resetGalleryQueryState(started.state);
    const resolved = resolveGalleryRequest(reset, started.request, {
      items: [item("2")],
      nextCursor: null,
    });

    expect(resolved).toBe(reset);
    expect(resolved.generation).toBe(1);
    expect(resolved.items).toEqual([]);
  });
});
