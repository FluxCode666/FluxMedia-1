/**
 * 可索引优先级队列测试。
 *
 * 使用方：Vitest；验证最小堆顺序、稳定 FIFO、任意位置取消和清空语义。
 */

import { describe, expect, it } from "vitest";

import { IndexedPriorityQueue } from "./indexed-priority-queue";

type Item = { id: number; priority: number };

/** 创建按 priority、id 升序的稳定测试队列。 */
function createQueue(): IndexedPriorityQueue<Item> {
  return new IndexedPriorityQueue(
    (left, right) => left.priority - right.priority || left.id - right.id
  );
}

describe("IndexedPriorityQueue", () => {
  it("按 priority 升序并以 ID 保持同优先级 FIFO", () => {
    const queue = createQueue();
    queue.enqueue({ id: 1, priority: 20 });
    queue.enqueue({ id: 2, priority: 10 });
    queue.enqueue({ id: 3, priority: 10 });

    expect(queue.remove(queue.peek()?.id ?? -1)).toEqual({
      id: 2,
      priority: 10,
    });
    expect(queue.remove(queue.peek()?.id ?? -1)).toEqual({
      id: 3,
      priority: 10,
    });
    expect(queue.remove(queue.peek()?.id ?? -1)).toEqual({
      id: 1,
      priority: 20,
    });
  });

  it("可按 ID 删除中间元素且不破坏剩余堆顺序", () => {
    const queue = createQueue();
    queue.enqueue({ id: 1, priority: 30 });
    queue.enqueue({ id: 2, priority: 10 });
    queue.enqueue({ id: 3, priority: 20 });
    queue.enqueue({ id: 4, priority: 40 });

    expect(queue.remove(3)).toEqual({ id: 3, priority: 20 });
    expect(queue.get(3)).toBeUndefined();
    expect(queue.peek()).toEqual({ id: 2, priority: 10 });
    expect(queue.remove(2)).toEqual({ id: 2, priority: 10 });
    expect(queue.peek()).toEqual({ id: 1, priority: 30 });
  });

  it("拒绝重复 ID，避免位置索引静默损坏", () => {
    const queue = createQueue();
    queue.enqueue({ id: 1, priority: 10 });

    expect(() => queue.enqueue({ id: 1, priority: 20 })).toThrow(
      "Duplicate indexed priority queue id"
    );
  });

  it("drain 一次性清空元素与索引", () => {
    const queue = createQueue();
    queue.enqueue({ id: 1, priority: 20 });
    queue.enqueue({ id: 2, priority: 10 });

    expect(queue.drain()).toHaveLength(2);
    expect(queue.size).toBe(0);
    expect(queue.peek()).toBeUndefined();
    expect(queue.get(1)).toBeUndefined();
  });

  it("一万项入队和取消保持对数级比较次数", () => {
    let comparisons = 0;
    const queue = new IndexedPriorityQueue<Item>((left, right) => {
      comparisons += 1;
      return left.priority - right.priority || left.id - right.id;
    });
    const itemCount = 10_000;
    for (let id = 1; id <= itemCount; id += 1) {
      queue.enqueue({ id, priority: itemCount - id });
    }
    for (let id = 2; id <= itemCount; id += 2) {
      queue.remove(id);
    }
    while (queue.size > 0) {
      const id = queue.peek()?.id;
      if (id === undefined) throw new Error("expected queue head");
      queue.remove(id);
    }

    // WHY：宽松上界只约束复杂度量级，不对机器耗时做脆弱断言；若退化成全量排序
    // 或线性取消，一万项会显著超过这个 O(n log n) 比较预算。
    expect(comparisons).toBeLessThan(2_000_000);
  });
});
