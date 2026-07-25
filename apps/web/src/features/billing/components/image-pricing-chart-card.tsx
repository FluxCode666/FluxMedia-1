/**
 * 账单用量页的生图计价说明与曲线卡。
 *
 * 使用方通过懒加载包装器按需渲染本组件。关键依赖是 Recharts、
 * 运行时生图定价和当前用户的套餐计费数据。
 */

"use client";

import { formatCredits } from "@repo/shared/credits/format";
import {
  GLOBAL_DEFAULT_IMAGE_PRICING_MODEL,
  getImageModelCreditPricing,
  type ImageCreditOverrides,
  type ImageCreditPriceField,
  type ImageCreditPricing,
  type ResolvedImageCreditPricing,
  resolveImageCreditPricing,
} from "@repo/shared/image-backend/group-image-pricing";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { useEffect, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ImagePricingCardData } from "@/features/billing/image-pricing-card-data";
import {
  getImageBaseCredits,
  IMAGE_1K_BASE_EDGE,
  IMAGE_1K_BASE_SIZE,
  IMAGE_2K_BASE_EDGE,
  IMAGE_4K_BASE_EDGE,
  MAX_IMAGE_ASPECT_RATIO,
  MIN_IMAGE_DIMENSION,
  MIN_IMAGE_PIXELS,
} from "@/features/image-generation/resolution";

type ImagePricingChartCardProps = ImagePricingCardData & {
  isZh: boolean;
};

type PricingPoint = {
  baseCredits: number;
  dimensions: { height: number; width: number };
  label: string;
  longestEdge: number;
  megapixels: number;
  pixels: number;
  size: string;
};

type ModelPricingRow = {
  effectivePricing: ResolvedImageCreditPricing;
  globalOverrides: ImageCreditPricing;
  globalPricing: ResolvedImageCreditPricing;
  groupOverrides: ImageCreditPricing;
  model: string;
};

type PriceTierDefinition = {
  field: ImageCreditPriceField;
  label: string;
  range: (formatEdge: (value: number) => string) => string;
};

const PRICE_TIERS: readonly PriceTierDefinition[] = [
  {
    field: "base1024Credits",
    label: "1024",
    range: (formatEdge) => `E < ${formatEdge(IMAGE_1K_BASE_EDGE)}`,
  },
  {
    field: "base1kCredits",
    label: "1K",
    range: (formatEdge) =>
      `${formatEdge(IMAGE_1K_BASE_EDGE)} <= E < ${formatEdge(
        IMAGE_2K_BASE_EDGE
      )}`,
  },
  {
    field: "base2kCredits",
    label: "2K",
    range: (formatEdge) =>
      `${formatEdge(IMAGE_2K_BASE_EDGE)} <= E < ${formatEdge(
        IMAGE_4K_BASE_EDGE
      )}`,
  },
  {
    field: "base4kCredits",
    label: "4K",
    range: (formatEdge) => `E >= ${formatEdge(IMAGE_4K_BASE_EDGE)}`,
  },
];

const PRICING_POINTS = [
  {
    dimensions: { height: 640, width: 1024 },
    label: "Lower bound",
    size: "1024x640",
    pixels: MIN_IMAGE_PIXELS,
  },
  {
    dimensions: { height: 1024, width: 1024 },
    label: "1024",
    size: "1024x1024",
    pixels: 1024 * 1024,
  },
  {
    dimensions: { height: 1248, width: 1248 },
    label: "1K",
    size: IMAGE_1K_BASE_SIZE,
    pixels: 1248 * 1248,
  },
  {
    dimensions: { height: 1024, width: 1536 },
    label: "3:2",
    size: "1536x1024",
    pixels: 1536 * 1024,
  },
  {
    dimensions: { height: 2048, width: 2048 },
    label: "2K",
    size: "2048x2048",
    pixels: 2048 * 2048,
  },
  {
    dimensions: { height: 1728, width: 3072 },
    label: "3K",
    size: "3072x1728",
    pixels: 3072 * 1728,
  },
  {
    dimensions: { height: 2160, width: 3840 },
    label: "4K",
    size: "3840x2160",
    pixels: 3840 * 2160,
  },
];

/**
 * 根据完整的四档价格生成图表点。
 *
 * @param pricing 已按模型和分组解析完成的四档价格。
 * @returns 保留尺寸信息并补齐固定价格的图表数据；无副作用。
 */
function buildChartData(pricing: ResolvedImageCreditPricing): PricingPoint[] {
  return PRICING_POINTS.map((point) => ({
    ...point,
    baseCredits: getImageBaseCredits(point.dimensions, pricing),
    longestEdge: Math.max(point.dimensions.width, point.dimensions.height),
    megapixels: Number((point.pixels / 1_000_000).toFixed(2)),
  }));
}

/**
 * 使用全局积分精度格式化价格。
 *
 * @param value 有限积分值。
 * @returns 与积分流水一致的显示文本。
 */
function formatPrice(value: number): string {
  return formatCredits(value);
}

/**
 * 将像素整数格式化为易读的英文数字分组。
 *
 * @param value 像素数。
 * @returns 带千位分隔符的整数文本。
 */
function formatPixels(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/**
 * 将百万像素值压缩为图表刻度文本。
 *
 * @param value 百万像素数。
 * @returns 最多保留两位小数的 MP 文本。
 */
function formatMegapixels(value: number): string {
  return `${Number(value.toFixed(2))}MP`;
}

/**
 * 将最长边像素值格式化为图表刻度。
 *
 * @param value 最长边像素数。
 * @returns 带千位分隔符和 px 后缀的文本。
 */
function formatLongestEdge(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")}px`;
}

/**
 * 返回示例尺寸命中的档位价格与边界表达式。
 *
 * @param point 已计算最长边的图表点。
 * @param pricing 完整的四档价格。
 * @returns 命中档位的积分和边界文本；无失败分支。
 */
function getExampleFormula(
  point: PricingPoint,
  pricing: ResolvedImageCreditPricing
): { baseCredits: number; formula: string } {
  if (point.longestEdge < IMAGE_1K_BASE_EDGE) {
    return {
      baseCredits: pricing.base1024Credits,
      formula: `E < ${formatLongestEdge(IMAGE_1K_BASE_EDGE)}`,
    };
  }

  if (point.longestEdge < IMAGE_2K_BASE_EDGE) {
    return {
      baseCredits: pricing.base1kCredits,
      formula: `${formatLongestEdge(
        IMAGE_1K_BASE_EDGE
      )} <= E < ${formatLongestEdge(IMAGE_2K_BASE_EDGE)}`,
    };
  }

  if (point.longestEdge < IMAGE_4K_BASE_EDGE) {
    return {
      baseCredits: pricing.base2kCredits,
      formula: `${formatLongestEdge(
        IMAGE_2K_BASE_EDGE
      )} <= E < ${formatLongestEdge(IMAGE_4K_BASE_EDGE)}`,
    };
  }

  return {
    baseCredits: pricing.base4kCredits,
    formula: `E >= ${formatLongestEdge(IMAGE_4K_BASE_EDGE)}`,
  };
}

/**
 * 构造全局模型价与当前分组覆盖关系的展示行。
 *
 * @param globalModelPricing 管理员配置的全局模型稀疏价格。
 * @param groupModelOverrides 当前分组的模型逐档覆盖。
 * @returns 按模型名排序的全局、生效与显式覆盖价格；不修改输入对象。
 */
export function buildModelPricingRows(
  globalModelPricing: ImageCreditOverrides,
  groupModelOverrides: ImageCreditOverrides
): ModelPricingRow[] {
  const models = new Set([
    ...Object.keys(globalModelPricing.byModel),
    ...Object.keys(groupModelOverrides.byModel),
  ]);

  return [...models]
    .sort((left, right) => left.localeCompare(right))
    .map((model) => ({
      effectivePricing: resolveImageCreditPricing({
        model,
        global: globalModelPricing,
        group: groupModelOverrides,
      }),
      globalPricing: resolveImageCreditPricing({
        model,
        global: globalModelPricing,
      }),
      globalOverrides: getImageModelCreditPricing(
        model,
        globalModelPricing.byModel
      ),
      groupOverrides: getImageModelCreditPricing(
        model,
        groupModelOverrides.byModel
      ),
      model,
    }));
}

/** 观察容器宽度，使固定高度的 Recharts 适配响应式容器。 */
function useElementWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateWidth = (nextWidth: number) => {
      const roundedWidth = Math.floor(nextWidth);
      setWidth(roundedWidth > 0 ? roundedWidth : 0);
    };

    updateWidth(element.getBoundingClientRect().width);
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateWidth(entry.contentRect.width);
    });
    resizeObserver.observe(element);

    return () => resizeObserver.disconnect();
  }, []);

  return { ref, width };
}

/**
 * 渲染完整的生图定价曲线、套餐参数和计算示例。
 *
 * @param props 已由 Billing 服务端 loader 装配的计价与语言数据。
 * @returns 可响应式缩放的客户端计价卡。
 */
export function ImagePricingChartCard({
  billing,
  defaultModelPricing,
  globalModelPricing,
  groupModelOverrides,
  isZh,
  moderationPricing,
}: ImagePricingChartCardProps) {
  const data = buildChartData(defaultModelPricing);
  const chartXTicks = [
    1024,
    IMAGE_1K_BASE_EDGE,
    IMAGE_2K_BASE_EDGE,
    IMAGE_4K_BASE_EDGE,
  ];
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const { ref: chartContainerRef, width: chartWidth } = useElementWidth();
  const modelPricingRows = buildModelPricingRows(
    globalModelPricing,
    groupModelOverrides
  );

  const pricingItems = [
    {
      label: copy("Plan quota", "套餐配额"),
      value: `${billing.planName} · ${formatCredits(
        billing.monthlyCredits
      )} ${copy("credits / month", "积分/月")}`,
    },
    {
      label: copy("Chat round", "Chat 轮次"),
      value: `${formatCredits(billing.chatRoundCredits)} ${copy(
        "credits / round",
        "积分/轮"
      )}`,
    },
    {
      label: copy("Agent round", "Agent 轮次"),
      value: `${formatCredits(billing.agentRoundCredits)} ${copy(
        "credits / round",
        "积分/轮"
      )}`,
    },
    {
      label: copy("Backend group", "后端分组"),
      value: billing.groupName || copy("Default group", "默认分组"),
    },
    {
      label: copy("Review add-on", "审核附加"),
      value: billing.moderationBlockingEnabled
        ? `${formatCredits(moderationPricing.textModerationCredits)} ${copy(
            "text",
            "文本"
          )} · ${formatCredits(
            moderationPricing.imageModerationCredits
          )} ${copy("per input image", "每张输入图片")}`
        : copy("Review disabled", "审核当前关闭"),
    },
  ];
  const examplePoints = data.filter((point) =>
    ["1024", "1K", "2K", "4K"].includes(point.label)
  );

  // hover 语言与首页统计卡一致:轻抬升 + whisper 阴影 + 边框提亮;
  // Tailwind v4 的 -translate-y-* 走原生 translate 属性,过渡列表须写 translate 而非 transform
  return (
    <Card className="transition-[border-color,box-shadow,translate] duration-250 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-whisper motion-reduce:transition-none">
      <CardHeader className="space-y-1">
        <CardTitle className="font-serif text-lg font-medium tracking-tight">
          {copy("Image Pricing Tiers", "生图固定价格档位")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {copy(
            `The default image model uses four global fixed tiers: 1024 ${formatPrice(
              defaultModelPricing.base1024Credits
            )}, 1K ${formatPrice(
              defaultModelPricing.base1kCredits
            )}, 2K ${formatPrice(
              defaultModelPricing.base2kCredits
            )}, and 4K ${formatPrice(defaultModelPricing.base4kCredits)}.`,
            `默认图像模型采用四个全局固定档位：1024 ${formatPrice(
              defaultModelPricing.base1024Credits
            )}、1K ${formatPrice(
              defaultModelPricing.base1kCredits
            )}、2K ${formatPrice(
              defaultModelPricing.base2kCredits
            )}、4K ${formatPrice(
              defaultModelPricing.base4kCredits
            )}；按输出最长边归档。`
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {PRICE_TIERS.map((tier) => (
            <div className="rounded-md border bg-muted/30 p-3" key={tier.field}>
              <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                {tier.label}
              </div>
              <div className="mt-1.5 text-lg font-medium text-foreground">
                {formatPrice(defaultModelPricing[tier.field])}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  {copy("credits", "积分")}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {tier.range(formatLongestEdge)}
              </div>
            </div>
          ))}
        </div>
        <div
          className="h-[240px] min-w-0 overflow-hidden"
          ref={chartContainerRef}
        >
          {chartWidth > 0 ? (
            <LineChart
              data={data}
              height={240}
              margin={{ bottom: 8, left: 6, right: 18, top: 10 }}
              width={chartWidth}
            >
              {/* 网格与轴降噪:网格线取 border 40% 透明度,隐藏轴线,刻度字取 muted token */}
              <CartesianGrid
                stroke="var(--border)"
                strokeDasharray="3 3"
                strokeOpacity={0.4}
                vertical={false}
              />
              <XAxis
                axisLine={false}
                dataKey="longestEdge"
                domain={[1024, IMAGE_4K_BASE_EDGE]}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                tickFormatter={(value) => formatLongestEdge(Number(value))}
                ticks={chartXTicks}
                tickLine={false}
                type="number"
              />
              <YAxis
                axisLine={false}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                tickFormatter={(value) => formatPrice(Number(value))}
                tickLine={false}
                width={42}
              />
              {/* Tooltip 样式 token 化:浮层取 popover/border/menu 阴影,随主题明暗 */}
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm, 8px)",
                  boxShadow: "var(--shadow-menu)",
                  fontSize: 12,
                  padding: "8px 12px",
                }}
                cursor={{
                  stroke: "var(--muted-foreground)",
                  strokeDasharray: "3 3",
                  strokeOpacity: 0.4,
                }}
                itemStyle={{ color: "var(--muted-foreground)", padding: 0 }}
                labelStyle={{
                  color: "var(--popover-foreground)",
                  fontWeight: 500,
                  marginBottom: 4,
                }}
                formatter={(value) => [
                  `${formatPrice(Number(value))} ${copy("credits", "积分")}`,
                  copy("Base credits", "基础积分"),
                ]}
                labelFormatter={(_, payload) => {
                  const point = payload?.[0]?.payload as
                    | PricingPoint
                    | undefined;
                  if (!point) return "";
                  return `${point.label} · ${point.size} · ${formatMegapixels(
                    point.megapixels
                  )}`;
                }}
              />
              {/* 阶梯线与固定档位一致；数据点空心化以适配暗色主题。 */}
              <Line
                activeDot={{ r: 5 }}
                dataKey="baseCredits"
                dot={{ fill: "var(--background)", r: 3, strokeWidth: 1.5 }}
                isAnimationActive={false}
                stroke="var(--primary)"
                strokeWidth={2}
                type="stepBefore"
              />
            </LineChart>
          ) : (
            <div className="h-full w-full rounded-md bg-muted/30" />
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {pricingItems.map((item) => (
            <div className="rounded-md border bg-muted/30 p-3" key={item.label}>
              <div className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                {item.label}
              </div>
              <div className="mt-1.5 text-sm font-medium">{item.value}</div>
            </div>
          ))}
        </div>
        <div className="rounded-md border bg-muted/20 p-3">
          <div className="font-medium text-foreground">
            {copy(
              "Model fixed prices and group inheritance",
              "模型固定价格与分组继承"
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {copy(
              `The first value is the global model price. The second line shows whether ${billing.groupName || "the default group"} overrides it or inherits it.`,
              `首行是全局模型价；次行展示当前分组“${billing.groupName || "默认分组"}”逐档覆盖或继承后的生效价。`
            )}
          </p>
          {modelPricingRows.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-2 py-2 font-medium">
                      {copy("Model", "模型")}
                    </th>
                    {PRICE_TIERS.map((tier) => (
                      <th className="px-2 py-2 font-medium" key={tier.field}>
                        {tier.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {modelPricingRows.map((row) => (
                    <tr className="border-b last:border-b-0" key={row.model}>
                      <td className="px-2 py-2 font-mono text-foreground">
                        {row.model === GLOBAL_DEFAULT_IMAGE_PRICING_MODEL
                          ? copy("Other/custom models", "其他或自定义模型")
                          : row.model}
                      </td>
                      {PRICE_TIERS.map((tier) => {
                        const globalOverride = row.globalOverrides[tier.field];
                        const override = row.groupOverrides[tier.field];
                        return (
                          <td className="px-2 py-2" key={tier.field}>
                            <div className="font-medium text-foreground">
                              {formatPrice(row.globalPricing[tier.field])}{" "}
                              <span className="font-normal text-muted-foreground">
                                {globalOverride === undefined
                                  ? copy("global default", "全局默认")
                                  : copy("global", "全局")}
                              </span>
                            </div>
                            <div className="mt-0.5 text-muted-foreground">
                              {override === undefined
                                ? copy(
                                    `Inherit · ${formatPrice(
                                      row.effectivePricing[tier.field]
                                    )}`,
                                    `继承全局 · ${formatPrice(
                                      row.effectivePricing[tier.field]
                                    )}`
                                  )
                                : copy(
                                    `Override · ${formatPrice(override)}`,
                                    `分组覆盖 · ${formatPrice(override)}`
                                  )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-3 rounded-md border bg-background p-3 text-xs text-muted-foreground">
              {copy(
                "All models inherit the required global default prices.",
                "所有模型均继承必填的全局默认价格。"
              )}
            </p>
          )}
        </div>
        <div className="grid gap-3 lg:grid-cols-[1fr_1.2fr]">
          <div className="rounded-md border bg-muted/20 p-3 text-xs">
            <div className="font-medium text-foreground">
              {copy("Fixed-price selection", "固定价格选择")}
            </div>
            <div className="mt-2 space-y-1 text-muted-foreground">
              <p>{copy("E = max(width, height).", "E = max(宽, 高)。")}</p>
              <p>
                {copy(
                  `Valid GPT image sizes start at ${formatPixels(
                    MIN_IMAGE_PIXELS
                  )} pixels, dimensions must be at least ${MIN_IMAGE_DIMENSION}px, and aspect ratio must be <= ${MAX_IMAGE_ASPECT_RATIO}:1.`,
                  `GPT 合法尺寸从 ${formatPixels(
                    MIN_IMAGE_PIXELS
                  )} 像素起，宽高至少 ${MIN_IMAGE_DIMENSION}px，宽高比不超过 ${MAX_IMAGE_ASPECT_RATIO}:1。`
                )}
              </p>
              {PRICE_TIERS.map((tier) => (
                <p key={tier.field}>
                  {tier.range(formatLongestEdge)} · {tier.label} ={" "}
                  {formatPrice(defaultModelPricing[tier.field])}{" "}
                  {copy("global credits", "全局积分")}
                </p>
              ))}
              <p className="pt-1 text-foreground">
                {copy(
                  "Priority: current group override > global model price.",
                  "优先级：当前分组覆盖 > 全局模型价。"
                )}
              </p>
            </div>
          </div>
          <div className="rounded-md border bg-muted/20 p-3 text-xs">
            <div className="font-medium text-foreground">
              {copy("Model fixed price + review fee", "模型固定价 + 审核费")}
            </div>
            <div className="mt-2 space-y-1 text-muted-foreground">
              <p>
                {copy(
                  "Single-image charge = model fixed price + text review fee + input image count x image review fee.",
                  "单张扣费 = 模型固定价 + 文本审核费 + 输入图片数 × 图片审核费。"
                )}
              </p>
              <p>
                {billing.moderationBlockingEnabled
                  ? copy(
                      `Review fee = ${formatPrice(
                        moderationPricing.textModerationCredits
                      )} text + N x ${formatPrice(
                        moderationPricing.imageModerationCredits
                      )} input image credits.`,
                      `审核费 = ${formatPrice(
                        moderationPricing.textModerationCredits
                      )} 文本 + N × ${formatPrice(
                        moderationPricing.imageModerationCredits
                      )} 输入图片积分。`
                    )
                  : copy(
                      "Review add-on is 0 because moderation is disabled.",
                      "审核当前关闭，审核附加为 0。"
                    )}
              </p>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {examplePoints.map((point) => {
                const example = getExampleFormula(point, defaultModelPricing);
                return (
                  <div
                    className="rounded-md border bg-background p-2"
                    key={point.size}
                  >
                    <div className="font-medium text-foreground">
                      {point.size} · {formatMegapixels(point.megapixels)}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      P = {formatPixels(point.pixels)}
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {example.formula}
                    </div>
                    <div className="mt-1 font-medium text-foreground">
                      = {formatPrice(example.baseCredits)}{" "}
                      {copy("credits", "积分")}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
          <p>
            {copy(
              "The curve shows the default image model's global fixed prices. Group prices follow the priority above; review and Chat/Agent round charges are added separately.",
              "曲线展示默认图像模型的全局固定价格；分组价格按上述优先级生效，审核及 Chat/Agent 轮次费用另行叠加。"
            )}
          </p>
          <p>
            {copy(
              `Requests with E below ${formatLongestEdge(
                IMAGE_1K_BASE_EDGE
              )} use the 1024 tier, and requests at or above ${formatLongestEdge(
                IMAGE_4K_BASE_EDGE
              )} use the 4K tier.`,
              `最长边低于 ${formatLongestEdge(
                IMAGE_1K_BASE_EDGE
              )} 归入 1024 档，达到或超过 ${formatLongestEdge(
                IMAGE_4K_BASE_EDGE
              )} 归入 4K 档。`
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
