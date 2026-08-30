"use client";

/**
 * 历史记录中的视频详情弹层。
 *
 * 使用方：HistoryClient。视频记录不复用图片灯箱，避免图片删除、参考图和 PSD
 * 操作错误地出现在视频详情中。
 */

import { formatCredits } from "@repo/shared/credits/format";
import { formatModelIdForDisplay } from "@repo/shared/image-backend/model-display";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import type { VideoTaskPublicBilling } from "@repo/shared/video-generation";
import { Badge } from "@repo/ui/components/badge";
import { Dialog, DialogContent, DialogTitle } from "@repo/ui/components/dialog";
import { Separator } from "@repo/ui/components/separator";
import { Film, Images } from "lucide-react";
import Image from "next/image";
import { useLocale } from "next-intl";
import { useEffect, useState } from "react";
import { getVideoInputsAction } from "../history-actions";
import { AdminRequestJsonDetails } from "./admin-request-json-details";
import { formatHistoryError } from "./history-error-copy";

export type HistoryVideoDialogRecord = {
  aspectRatio: string;
  billing: VideoTaskPublicBilling;
  completedAt: string | null;
  createdAt: string;
  creditsConsumed: number;
  duration: number;
  error: string | null;
  generateAudio: boolean;
  id: string;
  input: {
    mode:
      | "none"
      | "first-frame"
      | "first-last-frames"
      | "references"
      | "reference-videos"
      | "reference-audio"
      | "mixed";
    count: number;
  };
  kind: "video";
  model: string;
  prompt: string;
  resolution: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  submissionAttempts?: Array<{
    attemptNumber: number;
    failureCode: string;
    failureReason: string;
    failedAt: string;
    operationsReason: string;
    supplierName: string;
  }>;
  videoUrl: string | null;
};

type VideoInputDetails = NonNullable<
  Awaited<ReturnType<typeof getVideoInputsAction>>["data"]
>;

type VideoInputAsset = {
  label: string;
  mimeType: string;
  url: string;
};

type HistoryVideoDialogProps = {
  onClose: () => void;
  open: boolean;
  record: HistoryVideoDialogRecord;
  showAdminRequestJson?: boolean;
  showAdminSubmissionAttempts?: boolean;
  timeZone: string;
};

/** 格式化视频记录时间；异常输入回退原字符串。 */
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

/** 返回与可见状态文字配套的语义徽标样式。 */
function getStatusClass(status: HistoryVideoDialogRecord["status"]): string {
  if (status === "completed") return "bg-foreground/10 text-foreground";
  if (status === "failed") {
    return "bg-destructive/10 text-destructive";
  }
  return "bg-muted text-muted-foreground";
}

/** 把 UOL 具名输入响应投影为稳定展示顺序，不保留前一个任务的 URL。 */
function listInputAssets(
  details: VideoInputDetails,
  copy: (en: string, zh: string) => string
): VideoInputAsset[] {
  return [
    ...(details.firstFrame
      ? [
          {
            label: copy("First frame", "首帧"),
            ...details.firstFrame,
          },
        ]
      : []),
    ...(details.lastFrame
      ? [
          {
            label: copy("Last frame", "尾帧"),
            ...details.lastFrame,
          },
        ]
      : []),
    ...(details.referenceImages ?? []).map((asset, index) => ({
      label: `${copy("Reference", "参考图")} ${index + 1}`,
      ...asset,
    })),
  ];
}

/** 将机器输入模式转为不依赖新增 i18n key 的详情摘要。 */
function formatInputSummary(
  input: HistoryVideoDialogRecord["input"],
  copy: (en: string, zh: string) => string
): string {
  const mode = {
    none: copy("No image input", "无图片输入"),
    "first-frame": copy("First frame", "首帧"),
    "first-last-frames": copy("First and last frames", "首尾帧"),
    references: copy("Reference images", "参考图"),
    "reference-videos": copy("Reference videos", "参考视频"),
    "reference-audio": copy("Reference audio", "参考音频"),
    mixed: copy("Mixed inputs", "混合输入"),
  }[input.mode];
  return input.count > 0
    ? `${mode} · ${input.count} ${copy("images", "张")}`
    : mode;
}

/** 将快照或 legacy 账单格式化为用户可核对的模式与单位。 */
function formatBillingMode(
  billing: VideoTaskPublicBilling,
  copy: (en: string, zh: string) => string
): string {
  if (billing.kind === "legacy") {
    return copy("Per second (legacy task)", "按秒（旧任务）");
  }
  return billing.mode === "per_item"
    ? copy("Per item", "按条")
    : copy("Per second", "按秒");
}

/**
 * 展示视频预览、规格、结算和失败信息。
 *
 * @param props 当前视频记录、用户时区和受控弹层状态。
 * @returns 响应式详情弹层；视频不可用时显示明确占位。
 */
export function HistoryVideoDialog({
  onClose,
  open,
  record,
  showAdminRequestJson = false,
  showAdminSubmissionAttempts = false,
  timeZone,
}: HistoryVideoDialogProps) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const statusLabel = {
    completed: copy("Completed", "已完成"),
    failed: copy("Failed", "失败"),
    queued: copy("Queued", "排队中"),
    in_progress: copy("In progress", "生成中"),
  }[record.status];
  const errorMessage = formatHistoryError(record.error, copy);
  const [inputState, setInputState] = useState<
    | { status: "loading" }
    | { status: "ready"; details: VideoInputDetails }
    | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    if (!open) return;
    let acceptsResult = true;
    const taskId = record.id;
    setInputState({ status: "loading" });
    void getVideoInputsAction({ taskId })
      .then((result) => {
        if (!acceptsResult) return;
        if (!result.data || result.data.taskId !== taskId) {
          setInputState({ status: "error" });
          return;
        }
        setInputState({ status: "ready", details: result.data });
      })
      .catch(() => {
        if (acceptsResult) setInputState({ status: "error" });
      });
    return () => {
      acceptsResult = false;
    };
  }, [open, record.id]);

  const inputDetails =
    inputState.status === "ready" ? inputState.details : null;
  const inputAssets = inputDetails ? listInputAssets(inputDetails, copy) : [];
  const inputSummary = inputDetails?.summary ?? record.input;
  const inputSkeletonKeys = Array.from(
    { length: Math.max(record.input.count, 1) },
    (_, inputNumber) => `${record.id}-input-loading-${inputNumber + 1}`
  );
  const submissionAttempts = showAdminSubmissionAttempts
    ? (record.submissionAttempts ?? [])
    : [];

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[92vh] max-w-5xl gap-0 overflow-y-auto border-border bg-background p-0 duration-250 lg:overflow-hidden"
      >
        <DialogTitle className="sr-only">
          {copy("Video details", "视频详情")}
        </DialogTitle>
        <div className="grid min-h-0 min-w-0 max-w-full lg:max-h-[88vh] lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.8fr)]">
          <div className="flex min-h-72 min-w-0 items-center justify-center bg-black lg:min-h-[560px]">
            {record.videoUrl && record.status === "completed" ? (
              <video
                className="max-h-[88vh] w-full object-contain"
                controls
                playsInline
                preload="metadata"
                src={record.videoUrl}
              >
                <track kind="captions" />
              </video>
            ) : (
              <div className="flex flex-col items-center gap-3 px-6 text-center text-sm text-white/60">
                <Film className="size-12" strokeWidth={1.2} />
                <span>
                  {record.status === "queued"
                    ? copy("The video is queued.", "视频正在排队。")
                    : record.status === "in_progress"
                      ? copy(
                          "The video is still being generated.",
                          "视频仍在生成中。"
                        )
                      : copy("Video preview unavailable", "视频预览不可用")}
                </span>
              </div>
            )}
          </div>

          <div className="min-h-0 min-w-0 overflow-y-auto p-6">
            <div className="space-y-5">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                  {copy("Prompt", "提示词")}
                </p>
                <p className="mt-1 whitespace-pre-wrap font-serif text-base leading-relaxed text-foreground">
                  {record.prompt}
                </p>
              </div>

              {record.status === "failed" && errorMessage ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
                  <p className="text-[11px] font-medium uppercase tracking-widest text-destructive">
                    {copy("Error", "错误")}
                  </p>
                  <p className="mt-1 break-words text-sm leading-relaxed text-destructive">
                    {errorMessage}
                  </p>
                </div>
              ) : null}

              <Separator />

              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div className="col-span-2">
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Model", "模型")}
                  </dt>
                  <dd className="mt-0.5 break-all font-mono text-xs text-foreground">
                    {formatModelIdForDisplay(record.model)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Resolution", "分辨率")}
                  </dt>
                  <dd className="mt-0.5 font-mono text-xs text-foreground">
                    {record.resolution}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Duration", "时长")}
                  </dt>
                  <dd className="mt-0.5 text-xs text-foreground">
                    {record.duration} {copy("seconds", "秒")}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Audio", "声音")}
                  </dt>
                  <dd className="mt-0.5 text-xs text-foreground">
                    {record.generateAudio
                      ? copy("Enabled", "已启用")
                      : copy("Disabled", "未启用")}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Image input", "图片输入")}
                  </dt>
                  <dd className="mt-0.5 text-xs text-foreground">
                    {formatInputSummary(inputSummary, copy)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Aspect ratio", "宽高比")}
                  </dt>
                  <dd className="mt-0.5 font-mono text-xs text-foreground">
                    {record.aspectRatio}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Billing mode", "计费模式")}
                  </dt>
                  <dd className="mt-0.5 text-xs text-foreground">
                    {formatBillingMode(record.billing, copy)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Unit price", "计费单价")}
                  </dt>
                  <dd className="mt-0.5 text-xs text-foreground">
                    {record.billing.kind === "snapshot"
                      ? `${formatCredits(record.billing.unitPrice)} ${copy(
                          record.billing.mode === "per_item"
                            ? "credits/item"
                            : "credits/second",
                          record.billing.mode === "per_item"
                            ? "积分/条"
                            : "积分/秒"
                        )}`
                      : copy("Unknown", "未知")}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Quoted credits", "原报价积分")}
                  </dt>
                  <dd className="mt-0.5 text-xs text-foreground">
                    {record.billing.kind === "snapshot"
                      ? formatCredits(record.billing.quotedCredits)
                      : copy("Unknown", "未知")}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Actual credits", "实际积分")}
                  </dt>
                  <dd className="mt-0.5 text-xs text-foreground">
                    {formatCredits(record.billing.actualCredits)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Status", "状态")}
                  </dt>
                  <dd className="mt-0.5">
                    <Badge
                      className={`rounded-full border-transparent font-normal text-[10px] uppercase tracking-wide ${getStatusClass(record.status)}`}
                      variant="outline"
                    >
                      {statusLabel}
                    </Badge>
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Created", "创建时间")}
                  </dt>
                  <dd className="mt-0.5 text-xs text-foreground">
                    {formatDate(record.createdAt, locale, timeZone)}
                  </dd>
                </div>
                {record.completedAt ? (
                  <div className="col-span-2">
                    <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                      {copy("Completed", "完成时间")}
                    </dt>
                    <dd className="mt-0.5 text-xs text-foreground">
                      {formatDate(record.completedAt, locale, timeZone)}
                    </dd>
                  </div>
                ) : null}
              </dl>

              {showAdminRequestJson ? (
                <AdminRequestJsonDetails
                  id={record.id}
                  key={`video-request-${record.id}`}
                  kind="video"
                />
              ) : null}

              {submissionAttempts.length > 0 ? (
                <section
                  aria-label={copy("Submission failures", "提交失败记录")}
                >
                  <Separator className="mb-5" />
                  <h3 className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Submission failures", "提交失败记录")}
                  </h3>
                  <ol className="mt-3 space-y-3">
                    {submissionAttempts.map((attempt) => (
                      <li
                        className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs"
                        key={`${attempt.attemptNumber}-${attempt.supplierName}`}
                      >
                        <p className="font-medium text-foreground">
                          {copy("Attempt", "第")} {attempt.attemptNumber}
                          {isZh ? " 次" : ""} · {attempt.supplierName}
                        </p>
                        <dl className="mt-2 grid gap-x-3 gap-y-2 sm:grid-cols-2">
                          <div>
                            <dt className="text-muted-foreground">
                              {copy("Failure code", "失败码")}
                            </dt>
                            <dd className="break-all font-mono text-[11px] text-foreground">
                              {attempt.failureCode}
                            </dd>
                          </div>
                          <div className="sm:col-span-2">
                            <dt className="text-muted-foreground">
                              {copy("Failure reason", "失败原因")}
                            </dt>
                            <dd className="mt-0.5 break-words text-foreground">
                              {attempt.failureReason}
                            </dd>
                          </div>
                          <div className="sm:col-span-2">
                            <dt className="text-muted-foreground">
                              {copy("Operations note", "运营说明")}
                            </dt>
                            <dd className="mt-0.5 break-words text-foreground">
                              {attempt.operationsReason}
                            </dd>
                          </div>
                          <div className="sm:col-span-2">
                            <dt className="text-muted-foreground">
                              {copy("Failed at", "失败时间")}
                            </dt>
                            <dd className="mt-0.5 text-foreground">
                              {formatDate(attempt.failedAt, locale, timeZone)}
                            </dd>
                          </div>
                        </dl>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}

              <Separator />

              <section aria-live="polite">
                <div className="flex items-center gap-2">
                  <Images
                    aria-hidden="true"
                    className="size-4 text-muted-foreground"
                    strokeWidth={1.5}
                  />
                  <h3 className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Actual inputs", "实际输入")}
                  </h3>
                </div>
                {inputState.status === "loading" ? (
                  <div
                    aria-label={copy(
                      "Loading video inputs",
                      "正在加载视频输入"
                    )}
                    className="mt-3 grid grid-cols-2 gap-3"
                    role="status"
                  >
                    {inputSkeletonKeys.map((key) => (
                      <div
                        className="aspect-square animate-pulse rounded-md bg-muted motion-reduce:animate-none"
                        key={key}
                      />
                    ))}
                  </div>
                ) : null}
                {inputState.status === "error" ? (
                  <p className="mt-3 text-sm leading-relaxed text-destructive">
                    {copy(
                      "Video inputs could not be loaded. Reopen the details to retry.",
                      "视频输入加载失败，请重新打开详情后重试。"
                    )}
                  </p>
                ) : null}
                {inputState.status === "ready" && inputAssets.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    {copy(
                      "This task has no image inputs.",
                      "此任务没有图片输入。"
                    )}
                  </p>
                ) : null}
                {inputAssets.length > 0 ? (
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {inputAssets.map((asset) => (
                      <figure
                        className="min-w-0"
                        key={`${asset.label}-${asset.url}`}
                      >
                        <div className="relative aspect-square overflow-hidden rounded-md border border-border bg-muted">
                          <Image
                            alt={asset.label}
                            className="object-contain"
                            fill
                            sizes="(max-width: 640px) 50vw, 160px"
                            src={asset.url}
                            unoptimized
                          />
                        </div>
                        <figcaption className="mt-1 truncate text-[11px] text-muted-foreground">
                          {asset.label} · {asset.mimeType}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                ) : null}
              </section>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
