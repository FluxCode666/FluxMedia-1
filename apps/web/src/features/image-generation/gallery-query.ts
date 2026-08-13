/**
 * 图库无限滚动的 DB-free 查询状态机。
 *
 * 使用方：图库客户端的 IntersectionObserver、键盘加载入口和详情返回重放流程。
 * 状态机统一请求锁、世代隔离、ID 去重和 no-progress 保护，不负责网络或 React 状态。
 */

/** 图库查询可感知的生命周期状态。 */
export type GalleryQueryPhase =
  | "initialLoading"
  | "initialError"
  | "ready"
  | "appending"
  | "appendError"
  | "end";

/** 状态机去重所需的最小卡片约束。 */
export interface GalleryQueryItem {
  id: string;
}

/** 一次服务端读取返回的有界卡片批次。 */
export interface GalleryQueryBatch<Item extends GalleryQueryItem> {
  items: readonly Item[];
  nextCursor: string | null;
}

/** 请求令牌用于拒绝 reset 后到达的慢响应。 */
export interface GalleryQueryRequest {
  cursor: string | null;
  generation: number;
  id: number;
  kind: "initial" | "append";
}

/** 与 React 解耦的图库查询状态。 */
export interface GalleryQueryState<Item extends GalleryQueryItem> {
  activeRequest: GalleryQueryRequest | null;
  cursorChain: string[];
  error: string | null;
  generation: number;
  items: Item[];
  nextCursor: string | null;
  nextRequestId: number;
  phase: GalleryQueryPhase;
}

/** 请求入口返回新状态；request 为 null 表示当前状态不允许重复发起。 */
export interface GalleryQueryStart<Item extends GalleryQueryItem> {
  request: GalleryQueryRequest | null;
  state: GalleryQueryState<Item>;
}

/** 按首次出现顺序去除重复 ID，保证卡片顺序稳定。 */
function deduplicateItems<Item extends GalleryQueryItem>(
  items: readonly Item[]
): Item[] {
  const seenIds = new Set<string>();
  const uniqueItems: Item[] = [];
  for (const item of items) {
    if (seenIds.has(item.id)) {
      continue;
    }
    seenIds.add(item.id);
    uniqueItems.push(item);
  }
  return uniqueItems;
}

/**
 * 创建首批查询状态。
 *
 * 未传批次时等待首次请求；传入批次时根据 nextCursor 进入 ready 或 end。
 */
export function createGalleryQueryState<Item extends GalleryQueryItem>(
  initialBatch?: GalleryQueryBatch<Item>
): GalleryQueryState<Item> {
  if (!initialBatch) {
    return {
      activeRequest: null,
      cursorChain: [],
      error: null,
      generation: 0,
      items: [],
      nextCursor: null,
      nextRequestId: 0,
      phase: "initialLoading",
    };
  }
  return {
    activeRequest: null,
    cursorChain: [],
    error: null,
    generation: 0,
    items: deduplicateItems(initialBatch.items),
    nextCursor: initialBatch.nextCursor,
    nextRequestId: 0,
    phase: initialBatch.nextCursor ? "ready" : "end",
  };
}

/** 创建并锁定一次请求，所有触发入口必须复用此函数。 */
function beginGalleryRequest<Item extends GalleryQueryItem>(
  state: GalleryQueryState<Item>,
  kind: GalleryQueryRequest["kind"],
  cursor: string | null
): GalleryQueryStart<Item> {
  if (state.activeRequest) {
    return { request: null, state };
  }
  const request: GalleryQueryRequest = {
    cursor,
    generation: state.generation,
    id: state.nextRequestId,
    kind,
  };
  return {
    request,
    state: {
      ...state,
      activeRequest: request,
      error: null,
      nextRequestId: state.nextRequestId + 1,
      phase: kind === "initial" ? "initialLoading" : "appending",
    },
  };
}

/** 初次加载或 initialError 重试时发起无 cursor 请求。 */
export function beginGalleryInitial<Item extends GalleryQueryItem>(
  state: GalleryQueryState<Item>
): GalleryQueryStart<Item> {
  if (state.phase !== "initialLoading" && state.phase !== "initialError") {
    return { request: null, state };
  }
  return beginGalleryRequest(state, "initial", null);
}

/** ready 或 appendError 状态发起下一批；重复触发返回 null 请求。 */
export function beginGalleryAppend<Item extends GalleryQueryItem>(
  state: GalleryQueryState<Item>
): GalleryQueryStart<Item> {
  if (
    (state.phase !== "ready" && state.phase !== "appendError") ||
    !state.nextCursor
  ) {
    return { request: null, state };
  }
  return beginGalleryRequest(state, "append", state.nextCursor);
}

/** 比较完整请求令牌，避免同世代的旧请求或切换页签后的响应落入新状态。 */
function isActiveRequest<Item extends GalleryQueryItem>(
  state: GalleryQueryState<Item>,
  request: GalleryQueryRequest
): boolean {
  const activeRequest = state.activeRequest;
  return (
    state.generation === request.generation &&
    activeRequest?.cursor === request.cursor &&
    activeRequest.generation === request.generation &&
    activeRequest.id === request.id &&
    activeRequest.kind === request.kind
  );
}

/** 将成功批次应用到当前活动请求；旧请求直接返回原状态引用。 */
export function resolveGalleryRequest<Item extends GalleryQueryItem>(
  state: GalleryQueryState<Item>,
  request: GalleryQueryRequest,
  batch: GalleryQueryBatch<Item>
): GalleryQueryState<Item> {
  if (!isActiveRequest(state, request)) {
    return state;
  }
  if (request.kind === "initial") {
    return {
      ...state,
      activeRequest: null,
      cursorChain: [],
      error: null,
      items: deduplicateItems(batch.items),
      nextCursor: batch.nextCursor,
      phase: batch.nextCursor ? "ready" : "end",
    };
  }

  const existingIds = new Set(state.items.map((item) => item.id));
  const appendedItems = deduplicateItems(batch.items).filter(
    (item) => !existingIds.has(item.id)
  );
  const madeProgress = appendedItems.length > 0;
  const repeatedCursor = batch.nextCursor === request.cursor;
  const nextCursor = madeProgress && !repeatedCursor ? batch.nextCursor : null;
  const cursorChain =
    madeProgress && request.cursor
      ? [...state.cursorChain, request.cursor]
      : state.cursorChain;

  return {
    ...state,
    activeRequest: null,
    cursorChain,
    error: null,
    items: madeProgress ? [...state.items, ...appendedItems] : state.items,
    nextCursor,
    phase: nextCursor ? "ready" : "end",
  };
}

/** 将当前活动请求标记为可重试错误，并保留已有卡片与原分页边界。 */
export function failGalleryRequest<Item extends GalleryQueryItem>(
  state: GalleryQueryState<Item>,
  request: GalleryQueryRequest,
  error: string
): GalleryQueryState<Item> {
  if (!isActiveRequest(state, request)) {
    return state;
  }
  return {
    ...state,
    activeRequest: null,
    error,
    phase: request.kind === "initial" ? "initialError" : "appendError",
  };
}

/**
 * 切换页签或筛选时废弃旧世代并回到首批加载。
 *
 * 调用方仍应主动 Abort 网络请求；世代令牌负责兜底拒绝无法及时中止的慢响应。
 */
export function resetGalleryQueryState<Item extends GalleryQueryItem>(
  state: GalleryQueryState<Item>
): GalleryQueryState<Item> {
  return {
    activeRequest: null,
    cursorChain: [],
    error: null,
    generation: state.generation + 1,
    items: [],
    nextCursor: null,
    nextRequestId: state.nextRequestId,
    phase: "initialLoading",
  };
}
