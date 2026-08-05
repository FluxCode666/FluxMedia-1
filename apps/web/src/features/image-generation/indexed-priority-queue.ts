/**
 * 可按 ID 删除的进程内最小堆。
 *
 * 使用方：同步生图队列。入队、取队头和取消均保持 O(log n) 或更好，避免全站繁忙
 * 轮询期间反复全量排序；本模块不执行 Redis、计费或媒体副作用。
 */

export interface IndexedPriorityQueueItem {
  id: number;
}

/** 以调用方比较器维护稳定顺序，并用位置索引支持按 ID 删除。 */
export class IndexedPriorityQueue<T extends IndexedPriorityQueueItem> {
  private readonly heap: T[] = [];
  private readonly positions = new Map<number, number>();

  /**
   * @param compare 返回负数时 left 应排在 right 前面；比较器必须稳定且无副作用。
   */
  constructor(private readonly compare: (left: T, right: T) => number) {}

  /** 返回当前队列长度。 */
  get size(): number {
    return this.heap.length;
  }

  /** 查看最高优先级元素但不删除。 */
  peek(): T | undefined {
    return this.heap[0];
  }

  /** 按 ID 读取元素，供异步获槽返回后确认任务仍在队列。 */
  get(id: number): T | undefined {
    const index = this.positions.get(id);
    return index === undefined ? undefined : this.heap[index];
  }

  /** 插入一个 ID 唯一的元素；重复 ID 表示调用方状态损坏并显式失败。 */
  enqueue(item: T): void {
    if (this.positions.has(item.id)) {
      throw new Error(`Duplicate indexed priority queue id: ${item.id}`);
    }
    const index = this.heap.length;
    this.heap.push(item);
    this.positions.set(item.id, index);
    this.bubbleUp(index);
  }

  /** 删除指定 ID 并返回元素；不存在时无副作用。 */
  remove(id: number): T | undefined {
    const index = this.positions.get(id);
    if (index === undefined) return undefined;

    const removed = this.heap[index];
    const last = this.heap.pop();
    this.positions.delete(id);
    if (index < this.heap.length && last) {
      this.heap[index] = last;
      this.positions.set(last.id, index);
      const parentIndex = Math.floor((index - 1) / 2);
      if (index > 0 && this.compare(last, this.heap[parentIndex] as T) < 0) {
        this.bubbleUp(index);
      } else {
        this.bubbleDown(index);
      }
    }
    return removed;
  }

  /** 一次性取出全部元素并清空索引；调用方不依赖返回顺序。 */
  drain(): T[] {
    const items = [...this.heap];
    this.heap.length = 0;
    this.positions.clear();
    return items;
  }

  /** 从叶子向根修复最小堆。 */
  private bubbleUp(startIndex: number): void {
    let index = startIndex;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const item = this.heap[index];
      const parent = this.heap[parentIndex];
      if (!item || !parent || this.compare(item, parent) >= 0) return;
      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }

  /** 从根向叶子修复最小堆。 */
  private bubbleDown(startIndex: number): void {
    let index = startIndex;
    while (index < this.heap.length) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      let bestIndex = index;
      const best = this.heap[bestIndex];
      const left = this.heap[leftIndex];
      const right = this.heap[rightIndex];
      if (left && best && this.compare(left, best) < 0) bestIndex = leftIndex;
      const currentBest = this.heap[bestIndex];
      if (right && currentBest && this.compare(right, currentBest) < 0) {
        bestIndex = rightIndex;
      }
      if (bestIndex === index) return;
      this.swap(index, bestIndex);
      index = bestIndex;
    }
  }

  /** 交换两个堆位置并同步 ID 索引。 */
  private swap(leftIndex: number, rightIndex: number): void {
    const left = this.heap[leftIndex];
    const right = this.heap[rightIndex];
    if (!left || !right) {
      throw new Error("Indexed priority queue position is missing");
    }
    this.heap[leftIndex] = right;
    this.heap[rightIndex] = left;
    this.positions.set(right.id, leftIndex);
    this.positions.set(left.id, rightIndex);
  }
}
