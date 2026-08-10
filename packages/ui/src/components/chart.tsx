/**
 * shadcn/ui Chart 的共享 Recharts 适配层。
 *
 * 使用方：需要主题色、响应式容器、统一浮窗和图例的业务图表。配置由调用方代码
 * 声明，不接收外部输入；颜色通过局部 CSS 变量注入并随明暗主题切换。
 */
"use client";

import * as React from "react";
import * as RechartsPrimitive from "recharts";
import type { TooltipValueType } from "recharts";

import { cn } from "../utils";

const THEMES = { light: "", dark: ".dark" } as const;
const INITIAL_DIMENSION = { width: 320, height: 200 } as const;
type TooltipNameType = number | string;

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    icon?: React.ComponentType;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  )
>;

type ChartContextValue = {
  config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextValue | null>(null);

/** 读取最近 ChartContainer 提供的系列配置。 */
function useChart(): ChartContextValue {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />");
  }
  return context;
}

type ChartContainerProps = React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<
    typeof RechartsPrimitive.ResponsiveContainer
  >["children"];
  initialDimension?: { width: number; height: number };
};

/** 渲染响应式 Recharts 容器并建立 shadcn 图表主题作用域。 */
function ChartContainer({
  id,
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: ChartContainerProps) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replaceAll(":", "")}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
          className
        )}
        data-chart={chartId}
        data-slot="chart"
        {...props}
      >
        <ChartStyle config={config} id={chartId} />
        <RechartsPrimitive.ResponsiveContainer
          initialDimension={initialDimension}
        >
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

/** 把静态系列配置转换为当前图表作用域的 CSS 颜色变量。 */
function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colorConfig = Object.entries(config).filter(
    ([, item]) => item.theme ?? item.color
  );
  if (colorConfig.length === 0) return null;
  const cssText = Object.entries(THEMES)
    .map(
      ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, item]) => {
    const color = item.theme?.[theme as keyof typeof item.theme] ?? item.color;
    return color ? `  --color-${key}: ${color};` : null;
  })
  .join("\n")}
}
`
    )
    .join("\n");

  return (
    // 配置只来自受信任的源码常量；文本子节点保留 shadcn 的主题选择器且不注入 HTML。
    <style>{cssText}</style>
  );
}

const ChartTooltip = RechartsPrimitive.Tooltip;

type ChartTooltipContentProps = React.ComponentProps<
  typeof RechartsPrimitive.Tooltip
> &
  React.ComponentProps<"div"> & {
    hideLabel?: boolean;
    hideIndicator?: boolean;
    indicator?: "line" | "dot" | "dashed";
    nameKey?: string;
    labelKey?: string;
  } & Omit<
    RechartsPrimitive.DefaultTooltipContentProps<
      TooltipValueType,
      TooltipNameType
    >,
    "accessibilityLayer"
  >;

/** 渲染与 shadcn 主题一致的图表数据浮窗。 */
function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
}: ChartTooltipContentProps) {
  const { config } = useChart();
  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) return null;
    const [item] = payload;
    const key = `${labelKey ?? item?.dataKey ?? item?.name ?? "value"}`;
    const itemConfig = getPayloadConfigFromPayload(config, item, key);
    const value =
      !labelKey && typeof label === "string"
        ? (config[label]?.label ?? label)
        : itemConfig?.label;

    if (labelFormatter) {
      return (
        <div className={cn("font-medium", labelClassName)}>
          {labelFormatter(value, payload)}
        </div>
      );
    }
    return value ? (
      <div className={cn("font-medium", labelClassName)}>{value}</div>
    ) : null;
  }, [
    config,
    hideLabel,
    label,
    labelClassName,
    labelFormatter,
    labelKey,
    payload,
  ]);

  if (!active || !payload?.length) return null;
  const nestLabel = payload.length === 1 && indicator !== "dot";

  return (
    <div
      className={cn(
        "grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-menu",
        className
      )}
    >
      {nestLabel ? null : tooltipLabel}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.type !== "none")
          .map((item, itemIndex) => {
            const key = `${nameKey ?? item.name ?? item.dataKey ?? "value"}`;
            const itemConfig = getPayloadConfigFromPayload(config, item, key);
            const indicatorColor = color ?? item.payload?.fill ?? item.color;
            const stableKey = `${key}-${String(item.value)}`;
            return (
              <div
                className={cn(
                  "flex w-full flex-wrap items-stretch gap-2 [&>svg]:size-2.5 [&>svg]:text-muted-foreground",
                  indicator === "dot" && "items-center"
                )}
                key={stableKey}
              >
                {formatter && item.value !== undefined && item.name ? (
                  formatter(
                    item.value,
                    item.name,
                    item,
                    itemIndex,
                    item.payload
                  )
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : hideIndicator ? null : (
                      <div
                        className={cn(
                          "shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)",
                          indicator === "dot" && "size-2.5",
                          indicator === "line" && "w-1",
                          indicator === "dashed" &&
                            "w-0 border-[1.5px] border-dashed bg-transparent",
                          nestLabel && indicator === "dashed" && "my-0.5"
                        )}
                        style={
                          {
                            "--color-bg": indicatorColor,
                            "--color-border": indicatorColor,
                          } as React.CSSProperties
                        }
                      />
                    )}
                    <div
                      className={cn(
                        "flex flex-1 justify-between leading-none",
                        nestLabel ? "items-end" : "items-center"
                      )}
                    >
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-muted-foreground">
                          {itemConfig?.label ?? item.name}
                        </span>
                      </div>
                      {item.value == null ? null : (
                        <span className="font-mono font-medium tabular-nums text-foreground">
                          {typeof item.value === "number"
                            ? item.value.toLocaleString()
                            : String(item.value)}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

const ChartLegend = RechartsPrimitive.Legend;

type ChartLegendContentProps = React.ComponentProps<"div"> & {
  hideIcon?: boolean;
  nameKey?: string;
} & RechartsPrimitive.DefaultLegendContentProps;

/** 渲染使用 ChartConfig 文案和颜色的紧凑图例。 */
function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = "bottom",
  nameKey,
}: ChartLegendContentProps) {
  const { config } = useChart();
  if (!payload?.length) return null;

  return (
    <div
      className={cn(
        "flex items-center justify-center gap-4",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className
      )}
    >
      {payload
        .filter((item) => item.type !== "none")
        .map((item) => {
          const key = `${nameKey ?? item.dataKey ?? "value"}`;
          const itemConfig = getPayloadConfigFromPayload(config, item, key);
          return (
            <div
              className="flex items-center gap-1.5 [&>svg]:size-3 [&>svg]:text-muted-foreground"
              key={`${key}-${String(item.value)}`}
            >
              {itemConfig?.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <div
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: item.color }}
                />
              )}
              {itemConfig?.label}
            </div>
          );
        })}
    </div>
  );
}

/** 从 Recharts payload 中解析对应的 ChartConfig 项。 */
function getPayloadConfigFromPayload(
  config: ChartConfig,
  payload: unknown,
  key: string
) {
  if (typeof payload !== "object" || payload === null) return undefined;
  const nestedPayload =
    "payload" in payload &&
    typeof payload.payload === "object" &&
    payload.payload !== null
      ? payload.payload
      : undefined;
  let configKey = key;

  if (
    key in payload &&
    typeof payload[key as keyof typeof payload] === "string"
  ) {
    configKey = payload[key as keyof typeof payload] as string;
  } else if (
    nestedPayload &&
    key in nestedPayload &&
    typeof nestedPayload[key as keyof typeof nestedPayload] === "string"
  ) {
    configKey = nestedPayload[key as keyof typeof nestedPayload] as string;
  }
  return configKey in config ? config[configKey] : config[key];
}

export {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
  ChartTooltip,
  ChartTooltipContent,
};
