"use client";

/**
 * 用户图库的自动追加、预览、批量操作与短期恢复容器。
 *
 * 使用方：图库 Server Component。首批由 UOL 服务端读取；后续批次通过同一 operation
 * 追加。客户端统一处理请求锁、慢响应隔离、ID 去重、键盘入口和 sessionStorage 重放。
 */

import { formatAdobeModelIdForDisplay } from "@repo/shared/adobe";
import type {
  GalleryItem,
  GalleryListOutput,
  GalleryTab,
} from "@repo/shared/image-generation/gallery-contract";
import { Button } from "@repo/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import {
  Download,
  ImagePlus,
  Loader2,
  MousePointerClick,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useLocale } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  batchDeleteGenerationAction,
  getMyGalleryItemsAction,
} from "@/features/image-generation/actions";
import { ImageCard } from "@/features/image-generation/components/image-card";
import type {
  LightboxGeneration,
  LightboxReferenceImage,
} from "@/features/image-generation/components/image-lightbox";
import {
  beginGalleryAppend,
  createGalleryQueryState,
  failGalleryRequest,
  type GalleryQueryState,
  resolveGalleryRequest,
} from "@/features/image-generation/gallery-query";
import {
  createGalleryRecoverySnapshot,
  readGalleryRecoverySnapshot,
  saveGalleryRecoverySnapshot,
} from "@/features/image-generation/gallery-recovery";
import { generateDownloadFilename } from "@/lib/download-filename";

const GALLERY_BATCH_SIZE = 20;
const GALLERY_RECOVERY_STORAGE_KEY = "fluxmedia:gallery-recovery";

// Lightbox 仅在打开图片时加载，避免把详情交互放进图库首屏 bundle。
const ImageLightbox = dynamic(
  () =>
    import("@/features/image-generation/components/image-lightbox").then(
      (module) => module.ImageLightbox
    ),
  { ssr: false }
);

export interface GalleryClientProps {
  initialBatch: GalleryListOutput;
  activeTab: GalleryTab;
  principalFingerprint: string;
  timeZone: string;
}

/** 从 safe-action 结果中提取严格图库批次，失败保留服务端安全文案。 */
async function requestGalleryBatch(input: {
  cursor: string;
  tab: GalleryTab;
}): Promise<GalleryListOutput> {
  const result = await getMyGalleryItemsAction({
    cursor: input.cursor,
    limit: GALLERY_BATCH_SIZE,
    tab: input.tab,
  });
  if (result?.data) return result.data;
  throw new Error(
    typeof result?.serverError === "string"
      ? result.serverError
      : "Unable to load gallery items"
  );
}

/** 把共享图库图片卡片收窄为 lightbox 所需的安全详情。 */
function toLightboxGeneration(
  item: Extract<GalleryItem, { outputRole: "final" | "upload" }>
): LightboxGeneration {
  return {
    id: item.id,
    prompt: item.prompt,
    revisedPrompt: item.revisedPrompt,
    promptRepairNotice: item.promptRepairNotice,
    model: item.model,
    size: item.size,
    creditsConsumed: item.creditsConsumed,
    status: item.status,
    createdAt: item.createdAt,
    outputRole: item.outputRole,
    referenceImages: item.referenceImages as LightboxReferenceImage[],
  };
}

/** 渲染图库，并在每次成功追加后把短期恢复元数据同步到 sessionStorage。 */
export function GalleryClient({
  initialBatch,
  activeTab,
  principalFingerprint,
  timeZone,
}: GalleryClientProps) {
  const locale = useLocale();
  const copy = useCallback(
    (en: string, zh: string) => (locale === "zh" ? zh : en),
    [locale]
  );
  const initialState = useMemo(
    () => createGalleryQueryState<GalleryItem>(initialBatch),
    [initialBatch]
  );
  const [queryState, setQueryState] =
    useState<GalleryQueryState<GalleryItem>>(initialState);
  const queryStateRef = useRef(queryState);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastSelectedIndexRef = useRef(-1);
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const filterFingerprint = `tab:${activeTab}`;

  /** 同步 React 状态与请求入口 ref，阻止同一事件循环内重复触底并发。 */
  const commitQueryState = useCallback(
    (nextState: GalleryQueryState<GalleryItem>) => {
      queryStateRef.current = nextState;
      setQueryState(nextState);
    },
    []
  );

  const items = queryState.items;
  const selected = items.find((item) => item.id === selectedId) ?? null;

  /** 保存有界恢复元数据；不写入卡片 DTO、存储坐标或短期资源 URL。 */
  const saveRecovery = useCallback(() => {
    if (typeof window === "undefined") return;
    const state = queryStateRef.current;
    const anchor = state.items.find((item) => {
      const element = document.getElementById(`gallery-item-${item.id}`);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    });
    const anchorElement = anchor
      ? document.getElementById(`gallery-item-${anchor.id}`)
      : null;
    const snapshot = createGalleryRecoverySnapshot({
      cursorChain: state.cursorChain,
      filterFingerprint,
      nextCursor: state.nextCursor,
      principalFingerprint,
      savedAt: Date.now(),
      scroll: {
        anchorItemId: anchor?.id ?? null,
        anchorOffset: anchorElement?.getBoundingClientRect().top ?? 0,
        scrollY: window.scrollY,
      },
      tab: activeTab,
    });
    saveGalleryRecoverySnapshot(
      window.sessionStorage,
      GALLERY_RECOVERY_STORAGE_KEY,
      snapshot
    );
  }, [activeTab, filterFingerprint, principalFingerprint]);

  /** 从当前 nextCursor 发起一次追加；状态机负责请求锁、去重和重复 cursor 停止。 */
  const appendNextBatch = useCallback(async () => {
    const started = beginGalleryAppend(queryStateRef.current);
    if (!started.request) return;
    commitQueryState(started.state);
    activeAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;
    try {
      const batch = await requestGalleryBatch({
        cursor: started.request.cursor ?? "",
        tab: activeTab,
      });
      if (abortController.signal.aborted) return;
      commitQueryState(
        resolveGalleryRequest(queryStateRef.current, started.request, batch)
      );
    } catch (error) {
      if (abortController.signal.aborted) return;
      commitQueryState(
        failGalleryRequest(
          queryStateRef.current,
          started.request,
          error instanceof Error
            ? error.message
            : copy("Unable to load more", "加载更多失败")
        )
      );
    } finally {
      if (activeAbortControllerRef.current === abortController) {
        activeAbortControllerRef.current = null;
      }
    }
  }, [activeTab, commitQueryState, copy]);

  /** 首次挂载时有界重放已验证 cursor 链；任一不匹配即保留安全首批。 */
  useEffect(() => {
    const recovery = readGalleryRecoverySnapshot(
      window.sessionStorage,
      GALLERY_RECOVERY_STORAGE_KEY,
      {
        filterFingerprint,
        now: Date.now(),
        principalFingerprint,
        tab: activeTab,
      }
    );
    if (recovery.status !== "valid") return;
    let cancelled = false;
    const replay = async () => {
      let state = initialState;
      for (const expectedCursor of recovery.snapshot.cursorChain) {
        const started = beginGalleryAppend(state);
        if (!started.request || started.request.cursor !== expectedCursor) {
          return;
        }
        try {
          const batch = await requestGalleryBatch({
            cursor: expectedCursor,
            tab: activeTab,
          });
          if (cancelled) return;
          state = resolveGalleryRequest(started.state, started.request, batch);
        } catch {
          return;
        }
      }
      if (cancelled || state.nextCursor !== recovery.snapshot.nextCursor) {
        return;
      }
      commitQueryState(state);
      window.requestAnimationFrame(() => {
        const anchorId = recovery.snapshot.scroll.anchorItemId;
        const anchorElement = anchorId
          ? document.getElementById(`gallery-item-${anchorId}`)
          : null;
        if (anchorElement) {
          const delta =
            anchorElement.getBoundingClientRect().top -
            recovery.snapshot.scroll.anchorOffset;
          window.scrollBy({ top: delta, behavior: "instant" });
          return;
        }
        window.scrollTo({
          top: recovery.snapshot.scroll.scrollY,
          behavior: "instant",
        });
      });
    };
    void replay();
    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    commitQueryState,
    filterFingerprint,
    initialState,
    principalFingerprint,
  ]);

  /** 离开页面时保存恢复元数据并中止仍在飞行的追加请求。 */
  useEffect(() => {
    const handlePageHide = () => saveRecovery();
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      activeAbortControllerRef.current?.abort();
    };
  }, [saveRecovery]);

  /** 接近列表底部自动追加；键盘按钮与观察器复用同一受锁请求入口。 */
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || queryState.phase !== "ready") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void appendNextBatch();
        }
      },
      { rootMargin: "480px 0px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [appendNextBatch, queryState.phase]);

  /** 稳定阶段更新恢复链；`saveRecovery` 从 ref 读取最新 cursor 链和卡片。 */
  useEffect(() => {
    if (
      queryState.phase === "ready" ||
      queryState.phase === "appendError" ||
      queryState.phase === "end"
    ) {
      saveRecovery();
    }
  }, [queryState.phase, saveRecovery]);

  /** 退出多选模式并清空所有短期选择状态。 */
  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setConfirmBatchDelete(false);
    lastSelectedIndexRef.current = -1;
  }, []);

  /** 切换单卡选择；Shift 点击按当前已加载顺序选择连续范围。 */
  const handleSelect = useCallback(
    (id: string, event: React.MouseEvent) => {
      const currentIndex = items.findIndex((item) => item.id === id);
      setSelectedIds((previous) => {
        const next = new Set(previous);
        if (
          event.shiftKey &&
          lastSelectedIndexRef.current >= 0 &&
          lastSelectedIndexRef.current !== currentIndex
        ) {
          const start = Math.min(lastSelectedIndexRef.current, currentIndex);
          const end = Math.max(lastSelectedIndexRef.current, currentIndex);
          for (let index = start; index <= end; index += 1) {
            const item = items[index];
            if (item) next.add(item.id);
          }
        } else if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      lastSelectedIndexRef.current = currentIndex;
      setConfirmBatchDelete(false);
    },
    [items]
  );

  /** 逐个触发已选图片下载；视频和无资源项不进入批量下载。 */
  const handleBatchDownload = useCallback(() => {
    const toDownload = items.filter(
      (item) =>
        selectedIds.has(item.id) && item.outputRole !== "video" && item.imageUrl
    );
    for (const [index, item] of toDownload.entries()) {
      if (item.outputRole === "video" || !item.imageUrl) continue;
      window.setTimeout(() => {
        const anchor = document.createElement("a");
        anchor.href = item.imageUrl ?? "";
        anchor.download = generateDownloadFilename(item.prompt, item.createdAt);
        anchor.style.display = "none";
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
      }, index * 100);
    }
    if (toDownload.length > 0) {
      toast.success(
        copy(
          `Downloading ${toDownload.length} images`,
          `正在下载 ${toDownload.length} 张图片`
        )
      );
    }
  }, [copy, items, selectedIds]);

  /** 二次确认后按父任务去重删除；上传图卡片不能把合成 ID 传给服务端。 */
  const handleBatchDelete = useCallback(async () => {
    if (!confirmBatchDelete) {
      setConfirmBatchDelete(true);
      return;
    }
    setBatchDeleting(true);
    try {
      const parentIds = Array.from(
        new Set(
          items
            .filter((item) => selectedIds.has(item.id))
            .map((item) => item.parentId)
        )
      );
      const result = await batchDeleteGenerationAction({
        generationIds: parentIds,
      });
      if (!result?.data?.success) {
        throw new Error(
          typeof result?.serverError === "string"
            ? result.serverError
            : copy("Failed to delete", "删除失败")
        );
      }
      const deletedParents = new Set(parentIds);
      const nextState = {
        ...queryStateRef.current,
        items: queryStateRef.current.items.filter(
          (item) => !deletedParents.has(item.parentId)
        ),
      };
      commitQueryState(nextState);
      setSelectedIds(new Set());
      setConfirmBatchDelete(false);
      toast.success(
        copy(
          `Deleted ${result.data.deletedCount} items`,
          `已删除 ${result.data.deletedCount} 项`
        )
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : copy("Failed to delete", "删除失败")
      );
    } finally {
      setBatchDeleting(false);
    }
  }, [commitQueryState, confirmBatchDelete, copy, items, selectedIds]);

  /** 全选仅作用于当前已经加载的卡片，不触发额外网络读取。 */
  const handleSelectAll = useCallback(() => {
    setSelectedIds((previous) =>
      previous.size === items.length
        ? new Set()
        : new Set(items.map((item) => item.id))
    );
    setConfirmBatchDelete(false);
  }, [items]);

  /** 删除 lightbox 当前成品后同步本地列表；上传图不提供单项任务删除。 */
  const handleDelete = useCallback(
    (id: string) => {
      const nextState = {
        ...queryStateRef.current,
        items: queryStateRef.current.items.filter((item) => item.id !== id),
      };
      commitQueryState(nextState);
    },
    [commitQueryState]
  );

  const createHref = `/${locale}/dashboard/generate`;
  const galleryHref = (tab: GalleryTab) =>
    `/${locale}/dashboard/gallery?tab=${tab}`;
  const tabs = (
    <div className="flex items-center gap-3">
      <Tabs value={activeTab} className="flex-1">
        <TabsList className="h-auto flex-wrap justify-start border border-border bg-muted/40">
          <TabsTrigger value="final" asChild>
            <Link href={galleryHref("final")}>
              {copy("Final images", "成品")}
            </Link>
          </TabsTrigger>
          <TabsTrigger value="uploads" asChild>
            <Link href={galleryHref("uploads")}>
              {copy("User uploads", "用户上传图")}
            </Link>
          </TabsTrigger>
          <TabsTrigger value="videos" asChild>
            <Link href={galleryHref("videos")}>{copy("Videos", "视频")}</Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {activeTab !== "videos" && (
        <Button
          variant={selectMode ? "secondary" : "outline"}
          size="sm"
          onClick={selectMode ? exitSelectMode : () => setSelectMode(true)}
          className="shrink-0"
        >
          {selectMode ? (
            <>
              <X className="mr-1.5 h-3.5 w-3.5" />
              {copy("Cancel", "取消")}
            </>
          ) : (
            <>
              <MousePointerClick className="mr-1.5 h-3.5 w-3.5" />
              {copy("Select", "选择")}
            </>
          )}
        </Button>
      )}
    </div>
  );

  return (
    <>
      <div className="mb-5">{tabs}</div>
      {items.length === 0 ? (
        <div className="flex animate-in fade-in flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background px-6 py-24 text-center duration-400 motion-reduce:animate-none">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <ImagePlus
              className="h-7 w-7 text-muted-foreground"
              strokeWidth={1.2}
            />
          </div>
          <h3 className="mt-5 font-serif text-lg font-medium text-foreground">
            {activeTab === "uploads"
              ? copy("No user uploads yet", "还没有用户上传图")
              : activeTab === "videos"
                ? copy("No videos yet", "还没有视频")
                : copy("No images yet", "还没有图片")}
          </h3>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            {activeTab === "uploads"
              ? copy(
                  "Reference images uploaded for image edits will appear here.",
                  "图生图上传的参考图会显示在这里。"
                )
              : activeTab === "videos"
                ? copy(
                    "Videos you generate will appear here.",
                    "你生成的视频会显示在这里。"
                  )
                : copy(
                    "Your generated images will appear here.",
                    "你生成的图片会显示在这里。"
                  )}
          </p>
          <Button asChild variant="outline" className="mt-8">
            <Link href={createHref}>{copy("Create media", "开始创作")}</Link>
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {items.map((item, index) => (
            <div
              id={`gallery-item-${item.id}`}
              key={item.id}
              className="animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none"
              style={{
                animationDelay: `${(index % 12) * 50}ms`,
                animationFillMode: "backwards",
              }}
            >
              {item.outputRole === "video" ? (
                <div className="group overflow-hidden rounded-lg border border-border bg-background transition-[translate,box-shadow] duration-250 hover:-translate-y-1 hover:shadow-whisper motion-reduce:transition-none">
                  <div className="relative">
                    {item.videoUrl ? (
                      <video
                        src={item.videoUrl}
                        controls
                        preload="metadata"
                        className="aspect-square w-full bg-black object-contain"
                      >
                        <track kind="captions" />
                      </video>
                    ) : (
                      <div className="flex aspect-square items-center justify-center bg-muted text-xs text-muted-foreground">
                        {copy("Video unavailable", "视频不可用")}
                      </div>
                    )}
                    {item.videoUrl && (
                      <span className="pointer-events-none absolute left-2.5 top-2.5 rounded-[5px] bg-black/55 px-2 py-0.5 text-xs text-white/70 backdrop-blur-sm">
                        {item.size}
                      </span>
                    )}
                  </div>
                  <div className="space-y-2 p-3">
                    <p className="line-clamp-2 text-sm leading-snug text-foreground">
                      {item.prompt}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatAdobeModelIdForDisplay(item.model)}
                    </p>
                  </div>
                </div>
              ) : (
                <ImageCard
                  id={item.id}
                  prompt={item.prompt}
                  imageUrl={item.imageUrl}
                  model={item.model}
                  size={item.size}
                  creditsConsumed={item.creditsConsumed}
                  createdAt={item.createdAt}
                  status={item.status}
                  timeZone={timeZone}
                  selectable={selectMode}
                  selected={selectedIds.has(item.id)}
                  onSelect={selectMode ? handleSelect : undefined}
                  onClick={
                    selectMode ? undefined : () => setSelectedId(item.id)
                  }
                  badge={
                    item.outputRole === "upload"
                      ? copy("Upload", "上传")
                      : undefined
                  }
                />
              )}
            </div>
          ))}
        </div>
      )}

      <div
        ref={sentinelRef}
        className="flex min-h-20 items-center justify-center pt-5"
      >
        <div aria-live="polite" className="text-center">
          {queryState.phase === "ready" && (
            <Button variant="outline" onClick={() => void appendNextBatch()}>
              {copy("Load more", "加载更多")}
            </Button>
          )}
          {queryState.phase === "appending" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {copy("Loading more items", "正在加载更多内容")}
            </div>
          )}
          {queryState.phase === "appendError" && (
            <div className="space-y-3">
              <p className="text-sm text-destructive">
                {copy("Unable to load more items", "加载更多内容失败")}
              </p>
              <Button variant="outline" onClick={() => void appendNextBatch()}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {copy("Retry", "重试")}
              </Button>
            </div>
          )}
          {queryState.phase === "end" && items.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {copy("You have reached the end", "已经到底了")}
            </p>
          )}
        </div>
      </div>

      {selectMode && selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-2.5 shadow-modal animate-in fade-in slide-in-from-bottom-4 duration-250 motion-reduce:animate-none">
            <span className="text-sm text-muted-foreground">
              {copy(
                `Selected ${selectedIds.size} items`,
                `已选择 ${selectedIds.size} 项`
              )}
            </span>
            <div className="h-4 w-px bg-border" />
            <Button variant="outline" size="sm" onClick={handleSelectAll}>
              {selectedIds.size === items.length
                ? copy("Deselect all", "取消全选")
                : copy("Select all", "全选")}
            </Button>
            <Button variant="outline" size="sm" onClick={handleBatchDownload}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {copy("Download", "下载")}
            </Button>
            <Button
              variant={confirmBatchDelete ? "destructive" : "outline"}
              size="sm"
              disabled={batchDeleting}
              onClick={() => void handleBatchDelete()}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {confirmBatchDelete
                ? copy(
                    `Confirm delete ${selectedIds.size} items`,
                    `确认删除 ${selectedIds.size} 项`
                  )
                : copy("Delete", "删除")}
            </Button>
          </div>
        </div>
      )}

      {selected && selected.outputRole !== "video" && (
        <ImageLightbox
          generation={toLightboxGeneration(selected)}
          imageUrl={selected.imageUrl}
          open={selectedId !== null}
          timeZone={timeZone}
          onClose={() => setSelectedId(null)}
          onDelete={selected.outputRole === "upload" ? undefined : handleDelete}
        />
      )}
    </>
  );
}
