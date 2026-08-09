/**
 * 用户数据看板四张 Lieflat 图表组合。
 *
 * 使用方：DataDashboardChartsLazy。组件把同一快照分别映射到 F2 图片、F3 积分、L3
 * 视频和 G4 构成；视频数量/秒数切换仅在本地换序列，不发起 action。
 */
"use client";

import type { DataDashboardOutput } from "@repo/shared/analytics/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { ChartDataTable } from "./chart-data-table";
import { ChartFrame } from "./chart-frame";
import { allocateTaskWaffleDots } from "./chart-geometry";
import { DATA_DASHBOARD_CHART_TEMPLATES } from "./chart-tokens";
import { CreditsHairlineArea } from "./credits-hairline-area";
import { ImageHairlineLine } from "./image-hairline-line";
import { TaskDotWaffle } from "./task-dot-waffle";
import { VideoBarcodeLollipop } from "./video-barcode-lollipop";

export type VideoDashboardMode = "count" | "seconds";

/** 从同一快照选择视频数量或秒数序列，不修改范围和其它图表。 */
export function selectVideoDashboardSeries(
  snapshot: DataDashboardOutput,
  mode: VideoDashboardMode
): number[] {
  return snapshot.buckets.map((bucket) =>
    mode === "count" ? bucket.videoCount : bucket.videoSeconds
  );
}

type DataDashboardChartsProps = {
  snapshot: DataDashboardOutput;
};

/**
 * 渲染四张不重复模板图表与逐日等价数据表。
 *
 * @param props 同一账号时区日期范围的已验证快照。
 * @returns 响应式双列报告网格；窄屏保持单位、控件和全部日期表格可读。
 */
export function DataDashboardCharts({ snapshot }: DataDashboardChartsProps) {
  const locale = useLocale();
  const t = useTranslations("DataDashboard");
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const [videoMode, setVideoMode] = useState<VideoDashboardMode>("count");
  const videoValues = selectVideoDashboardSeries(snapshot, videoMode);
  const rangeLabel = t("charts.rangeLabel", {
    start: snapshot.range.startDate,
    end: snapshot.range.endDate,
  });
  const composition = allocateTaskWaffleDots(
    snapshot.taskComposition.imageTaskCount,
    snapshot.taskComposition.videoCount
  );

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartFrame
        dataTable={
          <ChartDataTable
            caption={t("charts.table.caption", {
              metric: t("charts.images"),
            })}
            columns={[t("charts.table.date"), t("charts.table.images")]}
            label={t("charts.table.show")}
            rows={snapshot.buckets.map((bucket) => [
              bucket.date,
              number.format(bucket.imageCount),
            ])}
          />
        }
        description={t("charts.imagesDescription", { range: rangeLabel })}
        replayLabel={t("charts.replay")}
        source="F2 HAIRLINE LINE · MONO · SUCCESSFUL OUTPUTS"
        summary={t("charts.imagesSummary", {
          value: number.format(snapshot.metrics.imageCount),
        })}
        template={DATA_DASHBOARD_CHART_TEMPLATES.images}
        title={t("charts.images")}
      >
        {({ titleId, descriptionId }) => (
          <ImageHairlineLine
            accessibleTitle={t("charts.images")}
            buckets={snapshot.buckets}
            descriptionId={descriptionId}
            titleId={titleId}
          />
        )}
      </ChartFrame>

      <ChartFrame
        dataTable={
          <ChartDataTable
            caption={t("charts.table.caption", {
              metric: t("charts.credits"),
            })}
            columns={[t("charts.table.date"), t("charts.table.credits")]}
            label={t("charts.table.show")}
            rows={snapshot.buckets.map((bucket) => [
              bucket.date,
              number.format(bucket.creditsConsumed),
            ])}
          />
        }
        description={t("charts.creditsDescription", { range: rangeLabel })}
        replayLabel={t("charts.replay")}
        source="F3 HAIRLINE AREA · MONO · NET CREDITS"
        summary={t("charts.creditsSummary", {
          value: number.format(snapshot.metrics.creditsConsumed),
        })}
        template={DATA_DASHBOARD_CHART_TEMPLATES.credits}
        title={t("charts.credits")}
      >
        {({ titleId, descriptionId }) => (
          <CreditsHairlineArea
            accessibleTitle={t("charts.credits")}
            buckets={snapshot.buckets}
            descriptionId={descriptionId}
            titleId={titleId}
          />
        )}
      </ChartFrame>

      <ChartFrame
        controls={
          <fieldset className="inline-flex rounded-full border border-black/15 p-1 text-xs">
            <legend className="sr-only">{t("charts.videoMode.label")}</legend>
            {(["count", "seconds"] as const).map((mode) => (
              <button
                aria-pressed={videoMode === mode}
                className="rounded-full px-3 py-1.5 font-medium text-[var(--chart-muted)] aria-pressed:bg-[var(--chart-ink)] aria-pressed:text-[var(--chart-paper)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/50"
                key={mode}
                onClick={() => setVideoMode(mode)}
                type="button"
              >
                {t(`charts.videoMode.${mode}`)}
              </button>
            ))}
          </fieldset>
        }
        dataTable={
          <ChartDataTable
            caption={t("charts.table.caption", {
              metric: t(`charts.videoMode.${videoMode}`),
            })}
            columns={[
              t("charts.table.date"),
              t(
                videoMode === "count"
                  ? "charts.table.videos"
                  : "charts.table.seconds"
              ),
            ]}
            label={t("charts.table.show")}
            rows={snapshot.buckets.map((bucket, index) => [
              bucket.date,
              number.format(videoValues[index] ?? 0),
            ])}
          />
        }
        description={t("charts.videosDescription", {
          range: rangeLabel,
          unit: t(`charts.videoMode.${videoMode}`),
        })}
        replayLabel={t("charts.replay")}
        source="L3 BARCODE LOLLIPOP · MONO · SUCCESSFUL VIDEOS"
        summary={t("charts.videosSummary", {
          value: number.format(
            videoValues.reduce((sum, value) => sum + value, 0)
          ),
          unit: t(`charts.videoMode.${videoMode}`),
        })}
        template={DATA_DASHBOARD_CHART_TEMPLATES.videos}
        title={t("charts.videos")}
      >
        {({ titleId, descriptionId }) => (
          <VideoBarcodeLollipop
            accessibleTitle={t("charts.videos")}
            buckets={snapshot.buckets}
            descriptionId={descriptionId}
            titleId={titleId}
            values={videoValues}
          />
        )}
      </ChartFrame>

      <ChartFrame
        dataTable={
          <ChartDataTable
            caption={t("charts.table.caption", {
              metric: t("charts.composition"),
            })}
            columns={[
              t("charts.table.taskType"),
              t("charts.table.tasks"),
              t("charts.table.percent"),
            ]}
            label={t("charts.table.show")}
            rows={[
              [
                t("charts.taskType.image"),
                number.format(snapshot.taskComposition.imageTaskCount),
                `${composition.allocations[0]}%`,
              ],
              [
                t("charts.taskType.video"),
                number.format(snapshot.taskComposition.videoCount),
                `${composition.allocations[1]}%`,
              ],
            ]}
          />
        }
        description={t("charts.compositionDescription", { range: rangeLabel })}
        replayLabel={t("charts.replay")}
        source="G4 DOT WAFFLE · MONO · SUCCESSFUL TASK MIX"
        summary={
          snapshot.taskComposition.totalTasks === 0
            ? t("charts.compositionEmpty")
            : t("charts.compositionSummary", {
                images: number.format(snapshot.taskComposition.imageTaskCount),
                videos: number.format(snapshot.taskComposition.videoCount),
              })
        }
        template={DATA_DASHBOARD_CHART_TEMPLATES.composition}
        title={t("charts.composition")}
      >
        {({ titleId, descriptionId }) => (
          <TaskDotWaffle
            accessibleTitle={t("charts.composition")}
            descriptionId={descriptionId}
            emptyLabel={t("charts.compositionEmpty")}
            imageLabel={t("charts.taskType.image")}
            imageTaskCount={snapshot.taskComposition.imageTaskCount}
            titleId={titleId}
            videoLabel={t("charts.taskType.video")}
            videoTaskCount={snapshot.taskComposition.videoCount}
          />
        )}
      </ChartFrame>
    </div>
  );
}
