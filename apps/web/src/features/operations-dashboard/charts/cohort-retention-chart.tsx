/**
 * 运营看板注册 Cohort 留存点阵热力图。
 *
 * 使用方：OperationsDashboardPanel。图形沿用 Lieflat Basics F10 Dot Heat：
 * 注册日 × D1/D7/D30 构成矩阵，圆点面积以 sqrt(rate) 编码；真实零和无样本仍
 * 保留小点，未成熟与上线前以不同轮廓明确显示，并附完整等价表。
 */
"use client";

import type { CohortRetentionResult } from "@repo/shared/operations-dashboard/comparison";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/ui/components/chart";
import { cn } from "@repo/ui/utils";
import { useId, useState } from "react";
import { CartesianGrid, Scatter, ScatterChart, XAxis, YAxis } from "recharts";

import type { OperationsGrowthCohort } from "../growth-service";
import {
  formatOperationsDate,
  formatOperationsNumber,
  formatOperationsRate,
} from "../operations-dashboard-format";
import { OperationsChartCard } from "./operations-chart-card";
import { OperationsChartDataTable } from "./operations-chart-data-table";
import {
  OPERATIONS_CHART_GRID,
  OPERATIONS_CHART_INK,
  OPERATIONS_CHART_LIGHT_GRAY,
  OPERATIONS_CHART_MID_GRAY,
  OPERATIONS_CHART_SILENT,
} from "./operations-chart-utils";

type RetentionKey = "d1" | "d7" | "d30";

export type OperationsCohortChartLabels = {
  title: string;
  description: string;
  source: string;
  tableOpen: string;
  tableCaption: string;
  date: string;
  cohortSize: string;
  retainedCount: string;
  rate: string;
  immature: string;
  preEpoch: string;
  noData: string;
  days: Record<RetentionKey, string>;
};

export type OperationsCohortChartProps = {
  cohorts: readonly OperationsGrowthCohort[];
  locale: string;
  labels: OperationsCohortChartLabels;
};

type CohortDot = {
  key: string;
  cohortDate: string;
  dateLabel: string;
  dayKey: RetentionKey;
  dayLabel: string;
  dayIndex: number;
  cohortIndex: number;
  cohortSize: number;
  retainedCount: number;
  status: CohortRetentionResult["status"];
  rate: number | null;
  radius: number;
  value: number;
};

type VisualCohort = {
  index: number;
  cohort: OperationsGrowthCohort;
};

const RETENTION_KEYS: readonly RetentionKey[] = ["d1", "d7", "d30"];
const MAX_VISIBLE_COHORTS = 90;

/**
 * 为固定宽度点阵选择确定性注册日样本。
 *
 * WHY：一年日粒度可能包含 365 列，全部绘制会让圆点彼此遮挡。这里按等宽区间
 * 保留每段最大留存率的注册日，同时固定保留首末边界；完整 Cohort 仍进入键盘
 * 导航和等价表，因此视觉抽样不会改变核对事实。
 *
 * @param cohorts 完整、按注册日升序的 Cohort。
 * @returns 最多 90 个带原始索引的可视 Cohort。
 */
function selectVisualCohorts(
  cohorts: readonly OperationsGrowthCohort[]
): VisualCohort[] {
  if (cohorts.length <= MAX_VISIBLE_COHORTS) {
    return cohorts.map((cohort, index) => ({ cohort, index }));
  }
  const selected = new Set<number>([0, cohorts.length - 1]);
  const interiorSlots = MAX_VISIBLE_COHORTS - selected.size;
  const span = cohorts.length / interiorSlots;
  for (let bucket = 0; bucket < interiorSlots; bucket += 1) {
    const start = Math.floor(bucket * span);
    const end = Math.min(
      cohorts.length,
      Math.max(start + 1, Math.floor((bucket + 1) * span))
    );
    let winnerIndex = start;
    let winnerRate = -1;
    for (let index = start; index < end; index += 1) {
      const cohort = cohorts[index];
      if (!cohort) continue;
      const maximumRate = Math.max(
        ...RETENTION_KEYS.map((key) =>
          cohort[key].status === "value" ? cohort[key].rate : -1
        )
      );
      if (maximumRate > winnerRate) {
        winnerIndex = index;
        winnerRate = maximumRate;
      }
    }
    selected.add(winnerIndex);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .slice(0, MAX_VISIBLE_COHORTS)
    .map((index) => ({ cohort: cohorts[index], index }))
    .filter((entry): entry is VisualCohort => Boolean(entry.cohort));
}

/**
 * 为 Cohort 横轴生成至多十二个真实注册日刻度。
 *
 * @param cohortCount 完整 Cohort 数量。
 * @returns 去重后的原始数组索引，首末日期始终存在。
 */
function buildCohortAxisTicks(cohortCount: number): number[] {
  if (cohortCount <= 0) return [];
  const tickCount = Math.min(12, cohortCount);
  return Array.from({ length: tickCount }, (_, index) =>
    Math.round((index * (cohortCount - 1)) / Math.max(1, tickCount - 1))
  ).filter((value, index, values) => values.indexOf(value) === index);
}

/**
 * 将 Cohort 全量矩阵展开为点阵数据。
 *
 * @param cohorts 完整注册日行。
 * @param locale 日期显示语言。
 * @param labels D1/D7/D30 文案。
 * @returns 每个注册日三个点；面积以 sqrt(rate) 对应，特殊状态保留最小点。
 */
function buildCohortDots(
  cohorts: readonly VisualCohort[],
  locale: string,
  labels: OperationsCohortChartLabels
): CohortDot[] {
  return cohorts.flatMap(({ cohort, index: cohortIndex }) =>
    RETENTION_KEYS.map((dayKey, dayIndex) => {
      const retention = cohort[dayKey];
      const rate = retention.status === "value" ? retention.rate : null;
      return {
        key: `${cohort.cohortDate}-${dayKey}`,
        cohortDate: cohort.cohortDate,
        dateLabel: formatOperationsDate(cohort.cohortDate, locale),
        dayKey,
        dayLabel: labels.days[dayKey],
        dayIndex,
        cohortIndex,
        cohortSize: cohort.cohortSize,
        retainedCount: retention.retainedCount,
        status: retention.status,
        rate,
        radius: rate === null ? 2.2 : 2.2 + Math.sqrt(rate) * 12,
        value: rate ?? 0,
      };
    })
  );
}

/**
 * 将留存状态和值格式化为明确文案。
 *
 * @param retention 单个 D1/D7/D30 结果。
 * @param locale 比率显示语言。
 * @param labels 特殊状态文案。
 * @returns 比率或未成熟、上线前、无样本文案。
 */
function formatRetentionValue(
  retention: CohortRetentionResult,
  locale: string,
  labels: OperationsCohortChartLabels
): string {
  if (retention.status === "value") {
    return formatOperationsRate(retention.rate, locale);
  }
  if (retention.status === "immature") return labels.immature;
  if (retention.status === "pre_epoch") return labels.preEpoch;
  return labels.noData;
}

/**
 * 渲染 Cohort 点的 Mono 状态轮廓。
 *
 * @param props Recharts 提供的坐标和点数据。
 * @returns 面积与比率对应的 SVG 圆；特殊状态用空心/虚线/浅点区分。
 */
function CohortDotShape(props: {
  cx?: number;
  cy?: number;
  payload?: CohortDot;
}) {
  if (
    typeof props.cx !== "number" ||
    typeof props.cy !== "number" ||
    !props.payload
  ) {
    return <g />;
  }
  const { payload } = props;
  if (payload.status === "pre_epoch") {
    return (
      <circle
        cx={props.cx}
        cy={props.cy}
        fill="none"
        r={payload.radius}
        stroke={OPERATIONS_CHART_LIGHT_GRAY}
        strokeDasharray="1 2"
      />
    );
  }
  if (payload.status === "immature") {
    return (
      <circle
        cx={props.cx}
        cy={props.cy}
        fill="var(--card)"
        r={payload.radius}
        stroke={OPERATIONS_CHART_MID_GRAY}
        strokeWidth={1}
      />
    );
  }
  if (payload.status === "no_data") {
    return (
      <circle
        cx={props.cx}
        cy={props.cy}
        fill={OPERATIONS_CHART_SILENT}
        r={payload.radius}
      />
    );
  }
  return (
    <circle
      cx={props.cx}
      cy={props.cy}
      fill={
        (payload.rate ?? 0) >= 0.5
          ? OPERATIONS_CHART_INK
          : (payload.rate ?? 0) >= 0.2
            ? OPERATIONS_CHART_MID_GRAY
            : OPERATIONS_CHART_LIGHT_GRAY
      }
      r={payload.radius}
    />
  );
}

type CohortKeyboardPointsProps = {
  dots: readonly CohortDot[];
  labels: OperationsCohortChartLabels;
  locale: string;
};

/**
 * 渲染完整 Cohort 单元的键盘与触摸焦点队列。
 *
 * @param props 全量点阵、语言和特殊状态文案。
 * @returns 每个真实矩阵格一个按钮，以及 aria-live 当前格读数。
 * @sideEffects 仅记录最后聚焦或触摸的格子。
 */
function CohortKeyboardPoints({
  dots,
  labels,
  locale,
}: CohortKeyboardPointsProps) {
  const navigationId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const activeDot = dots[activeIndex];

  /** 将点阵格格式化为比率或特殊状态。 */
  function formatDot(dot: CohortDot): string {
    if (dot.status === "value" && dot.rate !== null) {
      return formatOperationsRate(dot.rate, locale);
    }
    if (dot.status === "immature") return labels.immature;
    if (dot.status === "pre_epoch") return labels.preEpoch;
    return labels.noData;
  }

  return (
    <div className="grid gap-2">
      <p className="sr-only" id={navigationId}>
        {labels.tableCaption}
      </p>
      <ul
        aria-labelledby={navigationId}
        className="flex max-w-full gap-1 overflow-x-auto pb-1"
      >
        {dots.map((dot, index) => (
          <li className="flex items-end" key={dot.key}>
            <button
              aria-label={`${dot.dateLabel}，${dot.dayLabel}：${formatDot(dot)}`}
              className={cn(
                "size-2.5 rounded-full bg-[#B0AFA9] outline-none",
                "hover:bg-[#55554F] focus-visible:bg-[#1C1C1A]",
                dot.status === "immature" && "border border-[#8F8E88] bg-card",
                dot.status === "pre_epoch" &&
                  "border border-dashed border-[#B0AFA9] bg-transparent",
                dot.status === "no_data" && "bg-[#D8D6CE]"
              )}
              onClick={() => setActiveIndex(index)}
              onFocus={() => setActiveIndex(index)}
              type="button"
            />
          </li>
        ))}
      </ul>
      <p aria-live="polite" className="text-xs font-medium text-[#55554F]">
        {activeDot
          ? `${activeDot.dateLabel} · ${activeDot.dayLabel} · ${formatDot(
              activeDot
            )}`
          : labels.tableCaption}
      </p>
    </div>
  );
}

/**
 * 渲染 F10 Cohort 留存点阵。
 *
 * @param props 完整 Cohort、语言和用户可见文案。
 * @returns 可滚动点阵、tooltip 与包含所有状态的完整等价表。
 */
export function OperationsCohortChart({
  cohorts,
  labels,
  locale,
}: OperationsCohortChartProps) {
  const fullDots = buildCohortDots(
    cohorts.map((cohort, index) => ({ cohort, index })),
    locale,
    labels
  );
  const dots = buildCohortDots(selectVisualCohorts(cohorts), locale, labels);
  const axisTicks = buildCohortAxisTicks(cohorts.length);
  const config = {
    value: { label: labels.rate, color: OPERATIONS_CHART_INK },
  } satisfies ChartConfig;
  return (
    <OperationsChartCard
      accessibility={
        <OperationsChartDataTable
          caption={labels.tableCaption}
          columns={[
            {
              key: "date",
              label: labels.date,
              render: (cohort) =>
                formatOperationsDate(cohort.cohortDate, locale),
            },
            {
              key: "size",
              label: labels.cohortSize,
              align: "right",
              render: (cohort) =>
                formatOperationsNumber(cohort.cohortSize, locale),
            },
            ...RETENTION_KEYS.map((dayKey) => ({
              key: dayKey,
              label: labels.days[dayKey],
              align: "right" as const,
              render: (cohort: OperationsGrowthCohort) =>
                formatRetentionValue(cohort[dayKey], locale, labels),
            })),
          ]}
          openLabel={labels.tableOpen}
          rowKey={(cohort) => cohort.cohortDate}
          rows={cohorts}
        />
      }
      description={labels.description}
      source={labels.source}
      title={labels.title}
    >
      <ChartContainer
        aria-label={labels.title}
        className="h-60 w-full aspect-auto"
        config={config}
        role="img"
      >
        <ScatterChart
          accessibilityLayer
          data={dots}
          margin={{ bottom: 20, left: 20, right: 20, top: 18 }}
        >
          <CartesianGrid stroke={OPERATIONS_CHART_GRID} strokeWidth={0.6} />
          <XAxis
            axisLine={false}
            dataKey="cohortIndex"
            domain={[-0.5, Math.max(0.5, cohorts.length - 0.5)]}
            tick={{ fill: "#8F8E88", fontSize: 9, fontWeight: 600 }}
            tickFormatter={(index) =>
              cohorts[Number(index)]?.cohortDate.slice(5) ?? ""
            }
            tickLine={false}
            tickMargin={10}
            ticks={axisTicks}
            type="number"
          />
          <YAxis
            axisLine={false}
            dataKey="dayIndex"
            domain={[-0.5, 2.5]}
            ticks={[0, 1, 2]}
            tick={{ fill: "#55554F", fontSize: 10, fontWeight: 700 }}
            tickFormatter={(index) =>
              labels.days[RETENTION_KEYS[Number(index)] ?? "d1"]
            }
            tickLine={false}
            type="number"
            width={48}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                hideIndicator
                formatter={(_, __, item) => {
                  const dot = item.payload as CohortDot;
                  const display =
                    dot.status === "value" && dot.rate !== null
                      ? formatOperationsRate(dot.rate, locale)
                      : dot.status === "immature"
                        ? labels.immature
                        : dot.status === "pre_epoch"
                          ? labels.preEpoch
                          : labels.noData;
                  return (
                    <div className="grid min-w-40 gap-1">
                      <div className="flex justify-between gap-3">
                        <span>{labels.rate}</span>
                        <span className="font-mono font-semibold">
                          {display}
                        </span>
                      </div>
                      <div className="flex justify-between gap-3 text-[#55554F]">
                        <span>{labels.retainedCount}</span>
                        <span className="font-mono">
                          {formatOperationsNumber(dot.retainedCount, locale)}
                        </span>
                      </div>
                    </div>
                  );
                }}
                labelFormatter={(_, payload) => {
                  const dot = payload[0]?.payload as CohortDot | undefined;
                  return dot ? `${dot.dateLabel} · ${dot.dayLabel}` : "";
                }}
              />
            }
            cursor={{ stroke: OPERATIONS_CHART_MID_GRAY }}
          />
          <Scatter
            data={dots}
            dataKey="value"
            isAnimationActive="auto"
            shape={<CohortDotShape />}
          />
        </ScatterChart>
      </ChartContainer>
      <CohortKeyboardPoints dots={fullDots} labels={labels} locale={locale} />
    </OperationsChartCard>
  );
}
