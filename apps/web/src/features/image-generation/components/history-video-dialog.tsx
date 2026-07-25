"use client";

/**
 * 历史记录中的视频详情弹层。
 *
 * 使用方：HistoryClient。视频记录不复用图片灯箱，避免图片删除、参考图和 PSD
 * 操作错误地出现在视频详情中。
 */

import { formatAdobeModelIdForDisplay } from "@repo/shared/adobe";
import { formatCredits } from "@repo/shared/credits/format";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { Badge } from "@repo/ui/components/badge";
import { Dialog, DialogContent, DialogTitle } from "@repo/ui/components/dialog";
import { Separator } from "@repo/ui/components/separator";
import { Film } from "lucide-react";
import { useLocale } from "next-intl";
import { formatHistoryError } from "./history-error-copy";

export type HistoryVideoDialogRecord = {
  aspectRatio: string;
  completedAt: string | null;
  createdAt: string;
  creditsConsumed: number;
  durationSeconds: number;
  error: string | null;
  family: string;
  id: string;
  kind: "video";
  model: string;
  prompt: string;
  resolution: string;
  status: "processing" | "completed" | "failed";
  videoUrl: string | null;
};

type HistoryVideoDialogProps = {
  onClose: () => void;
  open: boolean;
  record: HistoryVideoDialogRecord;
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
  timeZone,
}: HistoryVideoDialogProps) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const statusLabel = {
    completed: copy("Completed", "已完成"),
    failed: copy("Failed", "失败"),
    processing: copy("Processing", "处理中"),
  }[record.status];
  const errorMessage = formatHistoryError(record.error, copy);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[92vh] max-w-5xl gap-0 overflow-y-auto border-border bg-background p-0 duration-250 lg:overflow-hidden"
      >
        <DialogTitle className="sr-only">
          {copy("Video details", "视频详情")}
        </DialogTitle>
        <div className="grid min-h-0 lg:max-h-[88vh] lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.8fr)]">
          <div className="flex min-h-72 items-center justify-center bg-black lg:min-h-[560px]">
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
                  {record.status === "processing"
                    ? copy(
                        "The video is still being generated.",
                        "视频仍在生成中。"
                      )
                    : copy("Video preview unavailable", "视频预览不可用")}
                </span>
              </div>
            )}
          </div>

          <div className="min-h-0 overflow-y-auto p-6">
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
                    {formatAdobeModelIdForDisplay(record.model)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                    {copy("Family", "模型族")}
                  </dt>
                  <dd className="mt-0.5 font-mono text-xs text-foreground">
                    {record.family}
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
                    {record.durationSeconds} {copy("seconds", "秒")}
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
                    {copy("Credits", "积分")}
                  </dt>
                  <dd className="mt-0.5 text-xs text-foreground">
                    {formatCredits(record.creditsConsumed)}
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
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
