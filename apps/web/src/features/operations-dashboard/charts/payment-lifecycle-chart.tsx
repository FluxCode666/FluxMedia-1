/**
 * 运营看板支付订单生命周期阶段图。
 *
 * 使用方：OperationsDashboardPanel。图形沿用 Lieflat Basics F5 Tick Rows：
 * 每个阶段是一条横向 tick 队列，基线提供可比较长度，行尾保留精确数值；数量
 * 过大时一个 tick 代表自动计算的等量订单，避免伪造逐订单记录。
 */
"use client";

import { Button } from "@repo/ui/components/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/ui/components/chart";
import {
  Bar,
  BarChart,
  type BarShapeProps,
  CartesianGrid,
  LabelList,
  XAxis,
  YAxis,
} from "recharts";

import type {
  OperationsCommercialCountMetric,
  OperationsCommercialSnapshot,
} from "../commercial-service";
import { formatOperationsNumber } from "../operations-dashboard-format";
import { OperationsChartCard } from "./operations-chart-card";
import { OperationsChartDataTable } from "./operations-chart-data-table";
import {
  formatOperationsTooltipLabel,
  OPERATIONS_CHART_GRID,
  OPERATIONS_CHART_INK,
} from "./operations-chart-utils";

type PaymentLifecycleKey = keyof OperationsCommercialSnapshot["lifecycle"];
export type OperationsPaymentLifecycleStage = PaymentLifecycleKey;

export type OperationsPaymentLifecycleChartLabels = {
  title: string;
  description: string;
  source: string;
  unit: string;
  tableOpen: string;
  tableCaption: string;
  stage: string;
  status: string;
  valueStatus: string;
  preEpoch: string;
  current: string;
  previous: string;
  stages: Record<PaymentLifecycleKey, string>;
};

export type OperationsPaymentLifecycleChartProps = {
  locale: string;
  lifecycle: OperationsCommercialSnapshot["lifecycle"];
  labels: OperationsPaymentLifecycleChartLabels;
  onSelectStage?: (stage: OperationsPaymentLifecycleStage) => void;
};

type PaymentLifecycleRow = {
  key: PaymentLifecycleKey;
  label: string;
  status: OperationsCommercialCountMetric["status"];
  current: number;
  previous: number;
};

const PAYMENT_STAGE_KEYS: readonly PaymentLifecycleKey[] = [
  "createdOrders",
  "pendingOrders",
  "paymentConfirmedOrders",
  "paidNotFulfilledOrders",
  "fulfilledOrders",
  "failedOrders",
];

/**
 * 计算每根可见 tick 代表的订单数。
 *
 * @param maximum 最大阶段订单数。
 * @returns 至少为 1 的整数单位，使最长队列不超过约 48 根 tick。
 */
function resolvePaymentTickUnit(maximum: number): number {
  return Math.max(1, Math.ceil(maximum / 48));
}

/**
 * 将单条 Recharts 横柱绘制为 F5 的离散竖 tick 队列。
 *
 * @param props 横柱像素边界与当前阶段数据。
 * @returns SVG 基线及等距 tick；零值和上线前阶段只保留基线。
 */
function PaymentTickRowShape(props: BarShapeProps) {
  const payload = props.payload as
    | (PaymentLifecycleRow & { ticks: number })
    | undefined;
  if (!payload) return <g />;
  const count = payload.ticks;
  const baselineY = props.y + props.height / 2 + 5;
  const step = count > 0 ? props.width / count : 0;
  return (
    <g>
      <line
        stroke={OPERATIONS_CHART_GRID}
        strokeWidth={0.7}
        x1={props.x}
        x2={props.x + Math.max(props.width, 1)}
        y1={baselineY}
        y2={baselineY}
      />
      {Array.from({ length: count }, (_, index) => ({
        id: `${payload.key}-tick-${index + 1}`,
        index,
      })).map((tick) => {
        const x = props.x + step * tick.index + step / 2;
        const height = 8 + (tick.index % 4) * 1.4;
        return (
          <line
            key={tick.id}
            opacity={0.58 + (tick.index % 5) * 0.09}
            stroke={OPERATIONS_CHART_INK}
            strokeWidth={1}
            x1={x}
            x2={x}
            y1={baselineY}
            y2={baselineY - height}
          />
        );
      })}
    </g>
  );
}

/**
 * 渲染 F5 支付阶段 tick 队列。
 *
 * @param props 生命周期快照、语言和用户可见文案。
 * @returns 横向队列图、tooltip 与包含当前/上期值的完整等价表。
 */
export function OperationsPaymentLifecycleChart({
  labels,
  lifecycle,
  locale,
  onSelectStage,
}: OperationsPaymentLifecycleChartProps) {
  const rows: PaymentLifecycleRow[] = PAYMENT_STAGE_KEYS.map((key) => ({
    key,
    label: labels.stages[key],
    status: lifecycle[key].status,
    current: lifecycle[key].current,
    previous: lifecycle[key].previous,
  }));
  const maximum = Math.max(0, ...rows.map((row) => row.current));
  const unit = resolvePaymentTickUnit(maximum);
  const chartRows = rows.map((row) => ({
    ...row,
    ticks:
      row.status === "pre_epoch" || row.current === 0
        ? 0
        : Math.max(1, Math.ceil(row.current / unit)),
  }));
  const config = {
    ticks: { label: labels.current, color: OPERATIONS_CHART_INK },
  } satisfies ChartConfig;
  return (
    <OperationsChartCard
      accessibility={
        <OperationsChartDataTable
          caption={labels.tableCaption}
          columns={[
            {
              key: "stage",
              label: labels.stage,
              render: (row) => row.label,
            },
            {
              key: "status",
              label: labels.status,
              render: (row) =>
                row.status === "value" ? labels.valueStatus : labels.preEpoch,
            },
            {
              key: "current",
              label: labels.current,
              align: "right",
              render: (row) =>
                row.status === "value"
                  ? formatOperationsNumber(row.current, locale)
                  : labels.preEpoch,
            },
            {
              key: "previous",
              label: labels.previous,
              align: "right",
              render: (row) => formatOperationsNumber(row.previous, locale),
            },
          ]}
          openLabel={labels.tableOpen}
          rowKey={(row) => row.key}
          rows={rows}
        />
      }
      description={`${labels.description} · 1 tick = ${formatOperationsNumber(
        unit,
        locale
      )} ${labels.unit}`}
      source={labels.source}
      title={labels.title}
    >
      <ChartContainer
        aria-label={labels.title}
        className="h-80 w-full aspect-auto"
        config={config}
        role="img"
      >
        <BarChart
          accessibilityLayer
          data={chartRows}
          layout="vertical"
          margin={{ bottom: 8, left: 8, right: 54, top: 8 }}
        >
          <CartesianGrid
            horizontal={false}
            stroke={OPERATIONS_CHART_GRID}
            strokeWidth={0.6}
          />
          <XAxis axisLine={false} hide type="number" />
          <YAxis
            axisLine={false}
            dataKey="label"
            tick={{ fill: "#55554F", fontSize: 10, fontWeight: 700 }}
            tickLine={false}
            type="category"
            width={126}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                hideIndicator
                formatter={(_, __, item) => {
                  const payload = item.payload as PaymentLifecycleRow;
                  return (
                    <div className="flex min-w-36 justify-between gap-3">
                      <span>{labels.current}</span>
                      <span className="font-mono font-semibold tabular-nums">
                        {payload.status === "value"
                          ? formatOperationsNumber(payload.current, locale)
                          : labels.preEpoch}
                      </span>
                    </div>
                  );
                }}
                labelFormatter={formatOperationsTooltipLabel}
              />
            }
            cursor={{ fill: OPERATIONS_CHART_GRID }}
          />
          <Bar
            dataKey="ticks"
            fill="transparent"
            isAnimationActive="auto"
            shape={PaymentTickRowShape}
          >
            <LabelList
              fill={OPERATIONS_CHART_INK}
              fontSize={11}
              fontWeight={800}
              position="right"
              valueAccessor={(entry) => {
                const row = entry.payload as PaymentLifecycleRow;
                return row?.status === "value"
                  ? formatOperationsNumber(row.current, locale)
                  : labels.preEpoch;
              }}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">{labels.stage}</legend>
        {rows.map((row) => (
          <Button
            disabled={row.status === "pre_epoch"}
            key={row.key}
            onClick={() => onSelectStage?.(row.key)}
            size="sm"
            type="button"
            variant="outline"
          >
            {row.label}
          </Button>
        ))}
      </fieldset>
    </OperationsChartCard>
  );
}
