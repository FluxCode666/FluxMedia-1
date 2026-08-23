"use client";

/**
 * 图片与视频使用记录的响应式列表容器。
 *
 * 使用方：使用记录服务端页面。组件负责筛选、稳定 keyset 导航和详情弹层；
 * 数据读取与用户归属校验由服务端 UOL 查询完成。
 */

import { formatAdobeModelIdForDisplay } from "@repo/shared/adobe";
import { formatCredits } from "@repo/shared/credits/format";
import { calculateTotalPages } from "@repo/shared/pagination/state";
import { buildStorageThumbnailUrl } from "@repo/shared/storage/image-url";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Clock, Film, ImageIcon, ImagePlus } from "lucide-react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { useLocale } from "next-intl";
import { useEffect, useState } from "react";
import { UrlCursorPaginationControls } from "@/features/pagination/cursor-pagination-controls";
import { createPaginationUrlParamNames } from "@/features/pagination/url-adapter";
import { UrlPageSizeSelect } from "@/features/pagination/url-page-size-select";
import { Link } from "@/i18n/routing";

import type { GenerationCreditDetails } from "../credit-calculation-details";
import { formatHistoryError } from "./history-error-copy";
import { HistoryFilters } from "./history-filters";
import {
  buildHistoryHref,
  type HistoryQueryState,
  hasActiveHistoryFilters,
} from "./history-query";
import {
  HistoryVideoDialog,
  type HistoryVideoDialogRecord,
} from "./history-video-dialog";
import type {
  LightboxGeneration,
  LightboxReferenceImage,
} from "./image-lightbox";

// 图片灯箱和视频详情都只在用户点开记录后才需要，避免进入历史页时加载大弹层代码。
const ImageLightbox = dynamic(
  () => import("./image-lightbox").then((module) => module.ImageLightbox),
  { ssr: false }
);

export type HistoryRecordStatus =
  | "processing"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed";

type HistoryRecordBase = {
  backendAccount?: {
    id: string;
    name: string | null;
  } | null;
  completedAt: string | null;
  createdAt: string;
  creditsConsumed: number;
  error: string | null;
  id: string;
  model: string;
  processingDurationSeconds: number | null;
  prompt: string;
  status: HistoryRecordStatus;
  userEmail?: string;
  userId?: string;
};

export type HistoryImageRecord = HistoryRecordBase & {
  creditDetails: GenerationCreditDetails | null;
  imageUrl: string | null;
  kind: "image";
  promptRepairNotice?: string | null;
  referenceImages?: LightboxReferenceImage[];
  revisedPrompt: string | null;
  size: string;
  status: "processing" | "completed" | "failed";
};

export type HistoryVideoRecord = HistoryRecordBase &
  Omit<
    HistoryVideoDialogRecord,
    keyof HistoryRecordBase | "kind" | "status"
  > & {
    kind: "video";
    status: "queued" | "in_progress" | "completed" | "failed";
  };

export type HistoryRecord = HistoryImageRecord | HistoryVideoRecord;

export type HistoryClientProps = {
  canDeleteImages?: boolean;
  historyPath?: string;
  modelOptions: string[];
  nextCursor: string | null;
  page: number;
  pageSizeOptions: number[];
  previousCursor: string | null;
  queryState: HistoryQueryState;
  records: HistoryRecord[];
  showUserColumns?: boolean;
  timeZone: string;
  totalCount: number;
  userOptions?: Array<{ id: string; email: string }>;
};

/** 返回与可见状态文字配套的语义徽标样式。 */
function statusClasses(status: HistoryRecordStatus): string {
  if (status === "completed") return "bg-foreground/10 text-foreground";
  if (status === "failed") return "bg-destructive/10 text-destructive";
  return "bg-muted text-muted-foreground";
}

/** 格式化用户时区中的完整创建日期；异常输入回退原字符串。 */
function formatDate(iso: string, locale: string, timeZone: string): string {
  try {
    return formatDateInTimeZone(
      iso,
      locale,
      {
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
        timeZoneName: "short",
        year: "numeric",
      },
      timeZone
    );
  } catch {
    return iso;
  }
}

/** 生成图片积分列的简短组成说明；视频记录只展示最终积分。 */
function creditSummary(
  item: HistoryRecord,
  copy: (en: string, zh: string) => string
): string | null {
  if (item.kind !== "image" || !item.creditDetails) return null;
  const details = item.creditDetails;
  const parts: string[] = [];
  if (details.actualImageCredits !== null) {
    parts.push(
      `${copy("image", "图片")} ${formatCredits(details.actualImageCredits)}`
    );
  }
  if (details.chatCredits !== null && details.chatCredits > 0) {
    parts.push(
      `${copy("conversation", "对话")} ${formatCredits(details.chatCredits)}`
    );
  }
  return parts.length ? parts.join(" · ") : null;
}

/** 返回列表规格文字；视频直接展示独立参数、声音和输入摘要。 */
function formatRecordSpecification(
  record: HistoryRecord,
  copy: (en: string, zh: string) => string
): string {
  if (record.kind === "image") return record.size;
  const inputMode = {
    none: copy("no image input", "无图片输入"),
    "first-frame": copy("first frame", "首帧"),
    "first-last-frames": copy("first/last frames", "首尾帧"),
    references: copy("references", "参考图"),
    "reference-videos": copy("reference videos", "参考视频"),
    "reference-audio": copy("reference audio", "参考音频"),
    mixed: copy("mixed inputs", "混合输入"),
  }[record.input.mode];
  const inputSummary =
    record.input.count > 0 ? `${inputMode} ${record.input.count}` : inputMode;
  return [
    record.resolution,
    `${record.duration}s`,
    record.aspectRatio,
    record.generateAudio ? copy("audio", "声音") : copy("no audio", "无声音"),
    inputSummary,
  ].join(" · ");
}

/** 将统一列表状态映射回图片灯箱的历史状态类型。 */
function toLightboxGeneration(record: HistoryImageRecord): LightboxGeneration {
  return {
    creditDetails: record.creditDetails,
    createdAt: record.createdAt,
    creditsConsumed: record.creditsConsumed,
    error: record.error,
    id: record.id,
    model: record.model,
    prompt: record.prompt,
    promptRepairNotice: record.promptRepairNotice,
    referenceImages: record.referenceImages,
    resolution: record.creditDetails?.settledResolution ?? null,
    revisedPrompt: record.revisedPrompt,
    size: record.size,
    status: record.status === "processing" ? "pending" : record.status,
  };
}

/**
 * 渲染筛选、图片/视频混合记录和对应详情。
 *
 * @param props 已在服务端校验并序列化的一页使用记录与 keyset 状态。
 * @returns 日期优先、移动端完整显示时间的混合记录列表。
 * @sideEffects 删除图片成功后仅从当前客户端页移除对应记录。
 */
export function HistoryClient({
  canDeleteImages = true,
  historyPath,
  modelOptions,
  nextCursor,
  page,
  pageSizeOptions,
  previousCursor,
  queryState,
  records,
  showUserColumns = false,
  timeZone,
  totalCount,
  userOptions = [],
}: HistoryClientProps) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const statusLabel = (status: HistoryRecordStatus) =>
    ({
      completed: copy("Completed", "已完成"),
      failed: copy("Failed", "失败"),
      queued: copy("Queued", "排队中"),
      in_progress: copy("In progress", "生成中"),
      processing: copy("Processing", "处理中"),
    })[status];
  const [items, setItems] = useState<HistoryRecord[]>(records);
  const [selectedKey, setSelectedKey] = useState<{
    id: string;
    kind: HistoryRecord["kind"];
  } | null>(null);
  const selected =
    items.find(
      (item) => item.id === selectedKey?.id && item.kind === selectedKey.kind
    ) ?? null;
  const totalPages = calculateTotalPages(totalCount, queryState.pageSize);
  const desktopGridColumns = showUserColumns
    ? "lg:grid-cols-[minmax(200px,1fr)_minmax(160px,0.8fr)_minmax(220px,1fr)_228px_64px_minmax(220px,1fr)_76px_160px_124px_112px_104px_96px]"
    : "lg:grid-cols-[228px_64px_minmax(220px,1fr)_76px_160px_124px_112px_104px_96px]";

  useEffect(() => {
    setItems(records);
    setSelectedKey(null);
  }, [records]);

  /** 图片删除成功后同步当前页；视频详情本次不提供删除操作。 */
  function handleDelete(id: string): void {
    setItems((previous) =>
      previous.filter((item) => item.kind !== "image" || item.id !== id)
    );
    setSelectedKey(null);
  }

  return (
    <div className="space-y-4">
      <HistoryFilters
        historyPath={historyPath}
        modelOptions={modelOptions}
        showUserEmailFilter={showUserColumns}
        state={queryState}
        userOptions={userOptions}
      />

      {items.length === 0 ? (
        <div
          aria-live="polite"
          className="flex animate-in fade-in flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background px-6 py-20 text-center duration-400 motion-reduce:animate-none"
        >
          <div className="flex size-16 items-center justify-center rounded-full bg-muted">
            <ImagePlus
              className="size-7 text-muted-foreground"
              strokeWidth={1.2}
            />
          </div>
          <h2 className="mt-5 font-serif text-lg font-medium text-foreground">
            {hasActiveHistoryFilters(queryState)
              ? copy("No matching records", "没有匹配的记录")
              : copy("No usage records yet", "还没有使用记录")}
          </h2>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            {hasActiveHistoryFilters(queryState)
              ? copy(
                  "Try changing or clearing the current filters.",
                  "请调整或清空当前筛选条件。"
                )
              : copy(
                  "Your image and video generations will appear here.",
                  "你生成的图片和视频会显示在这里。"
                )}
          </p>
          {!hasActiveHistoryFilters(queryState) ? (
            <Button asChild className="mt-8" variant="outline">
              <Link href="/dashboard/generate">
                {copy("Start creating", "开始创作")}
              </Link>
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-background">
          <div className="overflow-x-auto">
            <div
              className={
                showUserColumns ? "lg:min-w-[1920px]" : "lg:min-w-[1320px]"
              }
            >
              <div
                className={`hidden items-center gap-3 border-b border-border bg-muted/30 px-4 py-3 text-[11px] font-medium uppercase tracking-widest text-muted-foreground lg:grid ${desktopGridColumns}`}
              >
                {showUserColumns ? (
                  <>
                    <div>{copy("User email", "用户邮箱")}</div>
                    <div>{copy("User ID", "用户 ID")}</div>
                    <div>
                      {copy(
                        "Supplier account (name / ID)",
                        "供应商账号（名称 / ID）"
                      )}
                    </div>
                  </>
                ) : null}
                <div>{copy("Date", "日期")}</div>
                <div>{copy("Preview", "预览")}</div>
                <div>{copy("Prompt", "提示词")}</div>
                <div>{copy("Type", "类型")}</div>
                <div>{copy("Model", "模型")}</div>
                <div>{copy("Specification", "规格")}</div>
                <div>{copy("Processing time (s)", "处理时长（秒）")}</div>
                <div>{copy("Credits", "积分")}</div>
                <div>{copy("Status", "状态")}</div>
              </div>

              <ul className="divide-y divide-border">
                {items.map((item) => {
                  const summary = creditSummary(item, copy);
                  const errorMessage = formatHistoryError(item.error, copy);
                  return (
                    <li key={`${item.kind}-${item.id}`}>
                      <button
                        className={`grid w-full grid-cols-[56px_minmax(0,1fr)] items-start gap-3 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${desktopGridColumns} lg:items-center`}
                        onClick={() =>
                          setSelectedKey({ id: item.id, kind: item.kind })
                        }
                        type="button"
                      >
                        {showUserColumns ? (
                          <>
                            <div
                              className="hidden min-w-0 truncate text-xs text-foreground lg:block"
                              title={item.userEmail}
                            >
                              {item.userEmail ?? "—"}
                            </div>
                            <div
                              className="hidden min-w-0 truncate font-mono text-xs text-foreground lg:block"
                              title={item.userId}
                            >
                              {item.userId ?? "—"}
                            </div>
                            <div className="hidden min-w-0 lg:block">
                              <p
                                className="truncate text-xs text-foreground"
                                title={item.backendAccount?.name ?? undefined}
                              >
                                {item.backendAccount?.name ?? "—"}
                              </p>
                              <p
                                className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
                                title={item.backendAccount?.id}
                              >
                                {item.backendAccount?.id ?? "—"}
                              </p>
                            </div>
                          </>
                        ) : null}
                        <div className="col-span-2 flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground lg:col-span-1">
                          <Clock className="size-3 shrink-0" />
                          <time dateTime={item.createdAt}>
                            {formatDate(item.createdAt, locale, timeZone)}
                          </time>
                        </div>

                        <div className="relative size-12 shrink-0 overflow-hidden rounded-sm border border-border bg-muted lg:size-14">
                          {item.kind === "image" &&
                          item.imageUrl &&
                          item.status === "completed" ? (
                            <Image
                              alt={item.prompt}
                              className="object-contain"
                              fetchPriority="low"
                              fill
                              sizes="64px"
                              src={
                                buildStorageThumbnailUrl(item.imageUrl, 128) ??
                                item.imageUrl
                              }
                              unoptimized
                            />
                          ) : (
                            <div className="flex size-full items-center justify-center text-muted-foreground">
                              {item.kind === "video" ? (
                                <Film className="size-5" strokeWidth={1.2} />
                              ) : (
                                <ImageIcon
                                  className="size-5"
                                  strokeWidth={1.2}
                                />
                              )}
                            </div>
                          )}
                        </div>

                        <div className="min-w-0">
                          <p className="line-clamp-2 break-words text-sm leading-snug text-foreground">
                            {item.prompt}
                          </p>
                          {errorMessage ? (
                            <p className="mt-1 line-clamp-2 break-words text-xs leading-snug text-destructive">
                              {errorMessage}
                            </p>
                          ) : null}
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground lg:hidden">
                            {showUserColumns && item.userEmail ? (
                              <>
                                <span className="max-w-full truncate">
                                  {item.userEmail}
                                </span>
                                <span>·</span>
                              </>
                            ) : null}
                            <span>
                              {item.kind === "image"
                                ? copy("Image", "图片")
                                : copy("Video", "视频")}
                            </span>
                            <span>·</span>
                            <span className="break-all font-mono">
                              {formatAdobeModelIdForDisplay(item.model)}
                            </span>
                            <span>·</span>
                            <span>{formatRecordSpecification(item, copy)}</span>
                            <span>·</span>
                            <span>
                              {copy("Processing time", "处理时长")}:{" "}
                              {item.processingDurationSeconds === null
                                ? "—"
                                : `${item.processingDurationSeconds}s`}
                            </span>
                            <Badge
                              className={`rounded-full border-transparent px-2 py-0 font-normal text-[10px] uppercase ${statusClasses(item.status)}`}
                              variant="outline"
                            >
                              {statusLabel(item.status)}
                            </Badge>
                          </div>
                          {showUserColumns && item.userId ? (
                            <p className="mt-1 break-all font-mono text-[10px] leading-tight text-muted-foreground lg:hidden">
                              {copy("User ID", "用户 ID")}: {item.userId}
                            </p>
                          ) : null}
                          {showUserColumns ? (
                            <div className="mt-1 space-y-0.5 text-[10px] leading-tight text-muted-foreground lg:hidden">
                              <p className="break-words">
                                {copy("Supplier account", "供应商账号")}:{" "}
                                {item.backendAccount?.name ?? "—"}
                              </p>
                              <p className="break-all font-mono">
                                {copy("Account ID", "账号 ID")}:{" "}
                                {item.backendAccount?.id ?? "—"}
                              </p>
                            </div>
                          ) : null}
                          <p className="mt-1 text-[11px] leading-tight text-muted-foreground lg:hidden">
                            {formatCredits(item.creditsConsumed)}
                            {summary ? ` · ${summary}` : ""}
                          </p>
                        </div>

                        <div className="hidden text-xs text-foreground lg:block">
                          {item.kind === "image"
                            ? copy("Image", "图片")
                            : copy("Video", "视频")}
                        </div>
                        <div
                          className="hidden min-w-0 truncate font-mono text-xs text-foreground lg:block"
                          title={formatAdobeModelIdForDisplay(item.model)}
                        >
                          {formatAdobeModelIdForDisplay(item.model)}
                        </div>
                        <div className="hidden font-mono text-xs text-foreground lg:block">
                          {formatRecordSpecification(item, copy)}
                        </div>
                        <div className="hidden text-xs text-foreground lg:block">
                          {item.processingDurationSeconds ?? "—"}
                        </div>
                        <div className="hidden text-xs text-foreground lg:block">
                          {formatCredits(item.creditsConsumed)}
                          {summary ? (
                            <span className="mt-0.5 block text-[10px] leading-tight text-muted-foreground">
                              {summary}
                            </span>
                          ) : null}
                        </div>
                        <div className="hidden lg:block">
                          <Badge
                            className={`rounded-full border-transparent font-normal text-[10px] uppercase tracking-wide ${statusClasses(item.status)}`}
                            variant="outline"
                          >
                            {statusLabel(item.status)}
                          </Badge>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="flex flex-wrap items-center gap-3">
          <p aria-live="polite" className="text-xs text-muted-foreground">
            {copy(`Total ${totalCount} records`, `共 ${totalCount} 条记录`)}
          </p>
          <UrlPageSizeSelect
            itemSuffix={copy(" rows", " 条")}
            label={copy("Rows per page", "每页条数")}
            options={pageSizeOptions.map((pageSize) => ({
              size: pageSize,
              href: buildHistoryHref(
                {
                  ...queryState,
                  cursor: null,
                  page: 1,
                  pageSize,
                },
                { path: historyPath }
              ),
            }))}
            value={queryState.pageSize}
          />
        </div>
        <UrlCursorPaginationControls
          ariaLabel={copy("Usage records pagination", "使用记录分页")}
          currentPageLabel={copy(
            `Page ${page} of ${totalPages}`,
            `第 ${page} / ${totalPages} 页`
          )}
          currentPageLabelTemplate={copy(
            "Page {page}, current page",
            "第 {page} 页，当前页"
          )}
          names={createPaginationUrlParamNames()}
          nextCursor={nextCursor}
          nextLabel={copy("Next", "下一页")}
          page={page}
          pageLabelTemplate={copy("Go to page {page}", "前往第 {page} 页")}
          previousCursor={previousCursor}
          previousLabel={copy("Previous", "上一页")}
          totalPages={totalPages}
        />
      </div>

      {selected?.kind === "image" ? (
        <ImageLightbox
          generation={toLightboxGeneration(selected)}
          imageUrl={selected.imageUrl}
          onClose={() => setSelectedKey(null)}
          onDelete={canDeleteImages ? handleDelete : undefined}
          open={selectedKey !== null}
          showAdminRequestJson={showUserColumns}
          timeZone={timeZone}
        />
      ) : null}
      {selected?.kind === "video" ? (
        <HistoryVideoDialog
          onClose={() => setSelectedKey(null)}
          open={selectedKey !== null}
          record={selected}
          showAdminRequestJson={showUserColumns}
          showAdminSubmissionAttempts={showUserColumns}
          timeZone={timeZone}
        />
      ) : null}
    </div>
  );
}
