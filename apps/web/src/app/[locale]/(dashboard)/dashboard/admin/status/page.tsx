/**
 * 管理后台全局状态页。
 *
 * 职责：只读聚合生成、财务、用户、工单以及统一媒体成员和调度指标，并以响应式卡片展示。
 * 使用方：具备后端池查看权限的管理员；本页不执行任何号池写操作。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { canViewImageBackendPool } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { formatCredits } from "@repo/shared/credits/format";
import type { AdminStatusErrorListOutput } from "@repo/shared/image-generation/admin-status-errors-contract";
import {
  formatDateInputInTimeZone,
  formatDateInTimeZone,
  parseDateInputInTimeZone,
} from "@repo/shared/time-zone";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Progress } from "@repo/ui/components/progress";
import {
  Activity,
  AlertTriangle,
  Coins,
  ImageIcon,
  Server,
  Video,
} from "lucide-react";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { UrlPaginationControls } from "@/features/pagination/pagination-controls";
import { createPaginationUrlParamNames } from "@/features/pagination/url-adapter";
import { UrlPageSizeSelect } from "@/features/pagination/url-page-size-select";
import { requestGoJson } from "@/server/go-backend-client";
import { RefreshStatusButton } from "./refresh-status-button";

export const dynamic = "force-dynamic";

const ERROR_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const ERROR_PAGINATION_NAMES = createPaginationUrlParamNames("error");

type ErrorRange = "24h" | "7d" | "30d" | "90d" | "all" | "custom";

interface GlobalStatusPageProps {
  searchParams: Promise<{
    errorRange?: string;
    errorFrom?: string;
    errorTo?: string;
    errorPage?: string;
    errorPageSize?: string;
  }>;
}

const RESOLUTION_DURATION_BUCKETS = ["4k", "2k", "1k", "custom"] as const;
const BACKEND_DURATION_BUCKETS = ["api"] as const;

type ResolutionDurationBucket = (typeof RESOLUTION_DURATION_BUCKETS)[number];
type BackendDurationBucket = (typeof BACKEND_DURATION_BUCKETS)[number];
type DurationBucketStats = {
  count: number;
  avgSeconds: number | null;
  p95Seconds: number | null;
};
type DurationBreakdown = Record<
  ResolutionDurationBucket,
  Record<BackendDurationBucket, DurationBucketStats>
>;

type GenerationWindowStats = {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  producedImages: number;
  creditsConsumed: number;
  successRate: number;
  platformSla: number;
  platformErrors: number;
  moderationErrors: number;
  userRequestErrors: number;
  avgSeconds: number | null;
  p95Seconds: number | null;
  durationBreakdown: DurationBreakdown;
  moderationPromptRepair: ModerationPromptRepairStats;
};

type ModerationPromptRepairStats = {
  attempted: number;
  succeeded: number;
  failed: number;
  byAttempt: Array<{
    attempt: number;
    attempted: number;
    succeeded: number;
    failed: number;
  }>;
};

type BackendHealthStats = {
  total: number;
  enabled: number;
  active: number;
  limited: number;
  error: number;
  cooling: number;
  disabled: number;
  successCount: number;
  failCount: number;
  healthStates: Array<{ health: string; count: number }>;
};

type VideoModelStats = {
  model: string;
  total: number;
  completed: number;
  failed: number;
};

type VideoGenerationStats = {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  // 成功率 = 完成 / (完成 + 失败);仅在有终态样本时有意义。
  successRate: number;
  // 已完成视频累计消耗积分。
  creditsConsumed: number;
  // 已完成视频累计时长(秒)。
  totalVideoSeconds: number;
  // 已完成视频平均生成耗时(completedAt - createdAt,秒);无样本为 null。
  avgLatencySeconds: number | null;
  byModel: VideoModelStats[];
};

type HistoricalErrorFilters = {
  range: ErrorRange;
  fromInput: string;
  toInput: string;
  fromDate: Date | null;
  toDate: Date | null;
  page: number;
  pageSize: 10 | 20 | 50;
};

type HistoricalGenerationErrorRow = {
  id: string;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  prompt: string;
  model: string;
  size: string;
  creditsConsumed: number;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
  category: "platform" | "moderation" | "user_request";
};

function copy(locale: string, en: string, zh: string) {
  return locale === "zh" ? zh : en;
}

function normalizeErrorRange(value: string | undefined): ErrorRange {
  if (
    value === "24h" ||
    value === "7d" ||
    value === "30d" ||
    value === "90d" ||
    value === "all" ||
    value === "custom"
  ) {
    return value;
  }
  return "7d";
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseDateInput(
  value: string | undefined,
  timeZone: string,
  endOfDay = false
) {
  return parseDateInputInTimeZone(value, { timeZone, endOfDay });
}

function formatDateInput(date: Date, timeZone: string) {
  return formatDateInputInTimeZone(date, timeZone);
}

function parseHistoricalErrorFilters(
  searchParams: GlobalStatusPageProps["searchParams"] extends Promise<infer T>
    ? T
    : never,
  timeZone: string
): HistoricalErrorFilters {
  const range = normalizeErrorRange(searchParams.errorRange);
  const now = new Date();
  const page = parsePositiveInteger(searchParams.errorPage, 1);
  const pageSize = parseHistoricalErrorPageSize(searchParams.errorPageSize);
  const customFrom = parseDateInput(searchParams.errorFrom, timeZone);
  const customTo = parseDateInput(searchParams.errorTo, timeZone, true);

  if (range === "all") {
    return {
      range,
      fromInput: searchParams.errorFrom ?? "",
      toInput: searchParams.errorTo ?? "",
      fromDate: null,
      toDate: null,
      page,
      pageSize,
    };
  }

  if (range === "custom") {
    return {
      range,
      fromInput: searchParams.errorFrom ?? "",
      toInput: searchParams.errorTo ?? "",
      fromDate: customFrom,
      toDate: customTo,
      page,
      pageSize,
    };
  }

  const rangeMs =
    range === "24h"
      ? 24 * 60 * 60 * 1000
      : range === "30d"
        ? 30 * 24 * 60 * 60 * 1000
        : range === "90d"
          ? 90 * 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;
  const fromDate = new Date(now.getTime() - rangeMs);

  return {
    range,
    fromInput: formatDateInput(fromDate, timeZone),
    toInput: formatDateInput(now, timeZone),
    fromDate,
    toDate: null,
    page,
    pageSize,
  };
}

/** 将历史错误页大小收窄到产品确认的 10/20/50 白名单。 */
function parseHistoricalErrorPageSize(value: string | undefined): 10 | 20 | 50 {
  if (value === "10") return 10;
  if (value === "50") return 50;
  return 20;
}

function formatDateTime(value: Date | null, locale: string, timeZone: string) {
  if (!value) return copy(locale, "Not recorded", "未记录");
  return formatDateInTimeZone(
    value,
    locale,
    {
      dateStyle: "medium",
      timeStyle: "medium",
    },
    timeZone
  );
}

function truncateText(value: string | null, length: number) {
  const normalized = (value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > length
    ? `${normalized.slice(0, Math.max(0, length - 3))}...`
    : normalized;
}

/** 构造保留历史错误时间筛选且回到第一页的页大小 URL。 */
function buildErrorPageSizeHref(
  filters: HistoricalErrorFilters,
  pageSize: number
) {
  const params = new URLSearchParams();
  params.set("errorRange", filters.range);
  if (pageSize !== 20) params.set("errorPageSize", String(pageSize));
  if (filters.range === "custom") {
    if (filters.fromInput) params.set("errorFrom", filters.fromInput);
    if (filters.toInput) params.set("errorTo", filters.toInput);
  }
  return `?${params.toString()}#historical-errors`;
}

function formatDuration(seconds: number | null, locale: string) {
  if (seconds === null) return copy(locale, "No sample", "暂无样本");
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatPercent(value: number, locale: string) {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US").format(
    Math.round(value)
  );
}

function MetricCard({
  title,
  value,
  description,
  icon: Icon,
  tone = "default",
  delay = 0,
}: {
  title: string;
  value: string;
  description: string;
  icon: typeof Activity;
  tone?: "default" | "success" | "warning" | "danger";
  // 入场错峰延迟(毫秒),纯展示;配合 animationFillMode backwards 避免闪现。
  delay?: number;
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-destructive"
          : "text-muted-foreground";
  // 入场动画放外层、hover 过渡放卡片:两者的 duration 工具类共享同一
  // CSS 变量,同元素叠加会互相覆盖(入场 400ms 与交互 250ms 需求不同)。
  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none"
      style={{ animationDelay: `${delay}ms`, animationFillMode: "backwards" }}
    >
      <Card className="h-full gap-3 rounded-lg py-5 transition-all duration-250 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-whisper">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
          <CardTitle className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            {title}
          </CardTitle>
          <Icon className={`h-4 w-4 ${toneClass}`} />
        </CardHeader>
        <CardContent>
          <div className="font-serif text-3xl font-medium tracking-tight">
            {value}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function SlaCard({
  title,
  description,
  stats,
  locale,
}: {
  title: string;
  description: string;
  stats: GenerationWindowStats;
  locale: string;
}) {
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {copy(locale, "Platform SLA", "平台 SLA")}
            </span>
            <span className="font-medium">
              {formatPercent(stats.platformSla, locale)}
            </span>
          </div>
          <Progress value={Math.round(stats.platformSla * 100)} />
        </div>
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <MiniStat
            label={copy(locale, "Success rate", "生图成功率")}
            value={formatPercent(stats.successRate, locale)}
          />
          <MiniStat
            label={copy(locale, "Produced images", "产出图片")}
            value={formatNumber(stats.producedImages, locale)}
          />
          <MiniStat
            label={copy(locale, "P95 duration", "P95 耗时")}
            value={formatDuration(stats.p95Seconds, locale)}
          />
        </div>
        <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          <span>
            {copy(locale, "Completed", "完成")} {stats.completed}
          </span>
          <span>
            {copy(locale, "Platform errors", "平台错误")} {stats.platformErrors}
          </span>
          <span>
            {copy(locale, "Pending", "处理中")} {stats.pending}
          </span>
          <span>
            {copy(locale, "Moderation blocks", "审核拦截")}{" "}
            {stats.moderationErrors}
          </span>
          <span>
            {copy(locale, "User request errors", "用户请求错误")}{" "}
            {stats.userRequestErrors}
          </span>
          <span>
            {copy(locale, "Avg duration", "平均耗时")}{" "}
            {formatDuration(stats.avgSeconds, locale)}
          </span>
        </div>
        <div className="rounded-md border bg-muted/20 p-3 text-xs">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="font-medium text-foreground">
              {copy(locale, "Prompt repair retries", "审核修剪重试")}
            </span>
            <span className="text-muted-foreground">
              {copy(locale, "Attempts", "尝试")}{" "}
              {stats.moderationPromptRepair.attempted}
            </span>
            <span className="text-muted-foreground">
              {copy(locale, "Succeeded", "成功")}{" "}
              {stats.moderationPromptRepair.succeeded}
            </span>
            <span className="text-muted-foreground">
              {copy(locale, "Failed", "失败")}{" "}
              {stats.moderationPromptRepair.failed}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 text-muted-foreground">
            {stats.moderationPromptRepair.byAttempt.length > 0 ? (
              stats.moderationPromptRepair.byAttempt.map((item) => (
                <span key={item.attempt}>
                  #{item.attempt}: {item.attempted}/{item.succeeded}/
                  {item.failed}
                </span>
              ))
            ) : (
              <span>
                {copy(
                  locale,
                  "No prompt repair retries in the selected range.",
                  "当前范围暂无审核修剪重试。"
                )}
              </span>
            )}
          </div>
        </div>
        <DurationBreakdownTable
          breakdown={stats.durationBreakdown}
          locale={locale}
        />
      </CardContent>
    </Card>
  );
}

function resolutionDurationLabel(
  bucket: ResolutionDurationBucket,
  locale: string
) {
  if (bucket === "custom") return copy(locale, "Custom", "自定义");
  return bucket.toUpperCase();
}

function backendDurationLabel() {
  return "API";
}

function DurationBucketCell({
  stats,
  locale,
}: {
  stats: DurationBucketStats;
  locale: string;
}) {
  if (stats.count === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {copy(locale, "No sample", "暂无样本")}
      </span>
    );
  }

  return (
    <div className="space-y-0.5">
      <div className="font-medium">
        P95 {formatDuration(stats.p95Seconds, locale)}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {copy(locale, "Avg", "平均")} {formatDuration(stats.avgSeconds, locale)}
        {" · n="}
        {formatNumber(stats.count, locale)}
      </div>
    </div>
  );
}

function DurationBreakdownTable({
  breakdown,
  locale,
}: {
  breakdown: DurationBreakdown;
  locale: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">
          {copy(locale, "Duration by size and API backend", "按分辨率和 API 后端耗时")}
        </span>
        <span className="text-xs text-muted-foreground">
          {copy(
            locale,
            "Completed records grouped by the API adapter.",
            "仅统计完成记录，并按 API 适配器分组。"
          )}
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[420px] text-left text-xs">
          <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
            <tr>
              <th className="w-24 px-3 py-2 font-medium">
                {copy(locale, "Size", "分辨率")}
              </th>
              {BACKEND_DURATION_BUCKETS.map((backend) => (
                <th key={backend} className="px-3 py-2 font-medium">
                  {backendDurationLabel()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {RESOLUTION_DURATION_BUCKETS.map((bucket) => (
              <tr
                key={bucket}
                className="transition-colors duration-150 hover:bg-muted/50"
              >
                <td className="px-3 py-2 font-medium">
                  {resolutionDurationLabel(bucket, locale)}
                </td>
                {BACKEND_DURATION_BUCKETS.map((backend) => (
                  <td key={backend} className="px-3 py-2 align-top">
                    <DurationBucketCell
                      stats={breakdown[bucket][backend]}
                      locale={locale}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3 transition-colors duration-150 hover:border-foreground/20">
      <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-serif text-lg font-medium tracking-tight">
        {value}
      </div>
    </div>
  );
}

/** 将调度指标枚举转换为管理页可读标签，未知新值保持原样以便发现协议扩展。 */
function schedulerMetricKeyLabel(
  category: "outcome" | "strategy" | "requestKind",
  key: string,
  locale: string
) {
  if (category === "outcome") {
    const labels: Record<string, [string, string]> = {
      acquired: ["Acquired", "获租"],
      switched: ["Switched", "切换"],
      no_candidate: ["No candidate", "无候选"],
      capacity_rejected: ["Capacity rejected", "容量拒绝"],
      terminal_failure: ["Terminal failure", "终态失败"],
    };
    const label = labels[key];
    return label ? copy(locale, label[0], label[1]) : key;
  }
  if (category === "strategy") {
    const labels: Record<string, [string, string]> = {
      priority: ["Priority", "优先级"],
      least_acquired: ["Least acquired", "最少获租"],
      least_load: ["Least load", "最低负载"],
    };
    const label = labels[key];
    return label ? copy(locale, label[0], label[1]) : key;
  }
  if (key === "image") return copy(locale, "Image", "图片");
  if (key === "video") return copy(locale, "Video", "视频");
  return key;
}

/** 将 7 天指标分布压缩为适合卡片展示的一行文本。 */
function formatSchedulerDistribution(
  values: Array<{ key: string; count: number }>,
  category: "outcome" | "strategy" | "requestKind",
  locale: string
) {
  if (values.length === 0) return copy(locale, "No sample", "暂无样本");
  return values
    .map(
      (item) =>
        `${schedulerMetricKeyLabel(category, item.key, locale)} ${formatNumber(
          item.count,
          locale
        )}`
    )
    .join(" · ");
}

/** 通过 UOL 读取当前管理员可见的历史错误分页结果。 */
async function loadHistoricalGenerationErrors(
  filters: HistoricalErrorFilters,
  principal: {
    type: "user";
    userId: string;
    role: "user" | "observer_admin" | "admin" | "super_admin";
  }
): Promise<AdminStatusErrorListOutput> {
  void principal;
  return requestGoJson<AdminStatusErrorListOutput>(
    "/api/admin/status/errors",
    {
      method: "POST",
      body: JSON.stringify({
        fromDate: filters.fromDate?.toISOString() ?? null,
        toDate: filters.toDate?.toISOString() ?? null,
        page: filters.page,
        pageSize: filters.pageSize,
      }),
    }
  );
}

function errorCategoryLabel(
  category: HistoricalGenerationErrorRow["category"],
  locale: string
) {
  if (category === "moderation") return copy(locale, "Moderation", "审核");
  if (category === "user_request") {
    return copy(locale, "User request", "用户请求");
  }
  return copy(locale, "Platform", "平台");
}

function describeErrorFilter(
  filters: HistoricalErrorFilters,
  locale: string,
  timeZone: string
) {
  if (filters.range === "all") return copy(locale, "All history", "全部历史");
  if (filters.range === "custom") {
    const from = filters.fromDate
      ? formatDateInput(filters.fromDate, timeZone)
      : copy(locale, "Unbounded", "不限");
    const to = filters.toDate
      ? formatDateInput(filters.toDate, timeZone)
      : copy(locale, "Unbounded", "不限");
    return `${copy(locale, "Custom", "自定义")}：${from} - ${to}`;
  }
  if (filters.range === "24h")
    return copy(locale, "Last 24 hours", "最近24小时");
  if (filters.range === "30d") return copy(locale, "Last 30 days", "最近30天");
  if (filters.range === "90d") return copy(locale, "Last 90 days", "最近90天");
  return copy(locale, "Last 7 days", "最近7天");
}

function HistoricalErrorsCard({
  errors,
  filters,
  locale,
  timeZone,
}: {
  errors: AdminStatusErrorListOutput;
  filters: HistoricalErrorFilters;
  locale: string;
  timeZone: string;
}) {
  const pageSizeOptions = ERROR_PAGE_SIZE_OPTIONS.map((size) => ({
    size,
    href: buildErrorPageSizeHref(filters, size),
  }));

  return (
    <Card id="historical-errors" className="rounded-lg" tabIndex={-1}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" />
          {copy(locale, "Historical Error Records", "历史错误记录")}
        </CardTitle>
        <CardDescription>
          {copy(
            locale,
            "All failed generation records with time filters and pagination.",
            "所有失败的生成记录，支持按时间筛选和分页查看。"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="grid gap-3 rounded-md border bg-muted/20 p-3 md:grid-cols-[160px_180px_180px_auto] md:items-end">
          {filters.pageSize !== 20 ? (
            <input
              name="errorPageSize"
              type="hidden"
              value={filters.pageSize}
            />
          ) : null}
          <label className="grid gap-1 text-sm">
            <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              {copy(locale, "Range", "时间范围")}
            </span>
            <select
              name="errorRange"
              defaultValue={filters.range}
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            >
              <option value="24h">
                {copy(locale, "Last 24 hours", "最近24小时")}
              </option>
              <option value="7d">
                {copy(locale, "Last 7 days", "最近7天")}
              </option>
              <option value="30d">
                {copy(locale, "Last 30 days", "最近30天")}
              </option>
              <option value="90d">
                {copy(locale, "Last 90 days", "最近90天")}
              </option>
              <option value="all">
                {copy(locale, "All history", "全部历史")}
              </option>
              <option value="custom">{copy(locale, "Custom", "自定义")}</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              {copy(locale, "From", "开始日期")}
            </span>
            <input
              type="date"
              name="errorFrom"
              defaultValue={filters.fromInput}
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              {copy(locale, "To", "结束日期")}
            </span>
            <input
              type="date"
              name="errorTo"
              defaultValue={filters.toInput}
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
            />
          </label>
          <Button type="submit" className="md:w-fit">
            {copy(locale, "Filter", "筛选")}
          </Button>
          <p className="text-xs text-muted-foreground md:col-span-4">
            {copy(
              locale,
              "Date inputs are applied when the range is Custom. Fixed ranges ignore manual dates.",
              "日期输入仅在选择自定义时生效；固定时间范围会忽略手动日期。"
            )}
          </p>
        </form>

        <div className="flex flex-col gap-3 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
          <div>
            {describeErrorFilter(filters, locale, timeZone)} ·{" "}
            {copy(locale, "Total", "共")}{" "}
            {formatNumber(errors.totalCount, locale)}{" "}
            {copy(locale, "records", "条")}
          </div>
          <UrlPageSizeSelect
            itemSuffix={copy(locale, " records", " 条")}
            label={copy(locale, "Rows per page", "每页条数")}
            options={pageSizeOptions}
            value={errors.pageSize}
          />
        </div>

        {errors.records.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {copy(
              locale,
              "No failed records in this range.",
              "该时间范围内没有失败记录。"
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="w-[210px] px-3 py-2 font-medium">
                    {copy(locale, "Time", "时间")}
                  </th>
                  <th className="w-[140px] px-3 py-2 font-medium">
                    {copy(locale, "Category", "类型")}
                  </th>
                  <th className="w-[220px] px-3 py-2 font-medium">
                    {copy(locale, "User", "用户")}
                  </th>
                  <th className="w-[170px] px-3 py-2 font-medium">
                    {copy(locale, "Request", "请求")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {copy(locale, "Error", "错误")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {errors.records.map((item) => {
                  const userDisplay =
                    item.userEmail || item.userName || item.userId || "-";
                  const prompt = truncateText(item.prompt, 180);
                  const message = item.error || "Unknown error";

                  return (
                    <tr
                      key={item.id}
                      className="align-top transition-colors duration-150 hover:bg-muted/50"
                    >
                      <td className="px-3 py-3">
                        <div className="font-medium">
                          {formatDateTime(item.createdAt, locale, timeZone)}
                        </div>
                        {item.completedAt && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {copy(locale, "Completed", "结束")}{" "}
                            {formatDateTime(item.completedAt, locale, timeZone)}
                          </div>
                        )}
                        <div className="mt-1 break-all text-xs text-muted-foreground">
                          {item.id}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <Badge
                          variant={
                            item.category === "platform"
                              ? "destructive"
                              : item.category === "moderation"
                                ? "secondary"
                                : "outline"
                          }
                          className="w-fit"
                        >
                          {errorCategoryLabel(item.category, locale)}
                        </Badge>
                      </td>
                      <td className="px-3 py-3">
                        <div className="break-all font-medium">
                          {userDisplay}
                        </div>
                        {userDisplay !== item.userId && (
                          <div className="mt-1 break-all text-xs text-muted-foreground">
                            {item.userId}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-medium">
                          {item.model || "-"}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {item.size || "-"} ·{" "}
                          {formatCredits(item.creditsConsumed)}
                        </div>
                        {prompt && (
                          <div className="mt-2 break-words text-xs text-muted-foreground">
                            {prompt}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="whitespace-pre-wrap break-words text-muted-foreground">
                          {message}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-col gap-3 border-t pt-4 md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-muted-foreground">
            {copy(locale, "Page", "第")} {formatNumber(errors.page, locale)} /{" "}
            {formatNumber(errors.totalPages, locale)}{" "}
            {copy(locale, "page", "页")}
          </p>
          <UrlPaginationControls
            ariaLabel={copy(
              locale,
              "Historical error records pagination",
              "历史错误记录分页"
            )}
            focusTargetId="historical-errors"
            pageLabelTemplate={copy(
              locale,
              "Go to page {page}",
              "前往第 {page} 页"
            )}
            currentPageLabelTemplate={copy(
              locale,
              "Page {page}, current page",
              "第 {page} 页，当前页"
            )}
            names={ERROR_PAGINATION_NAMES}
            nextLabel={copy(locale, "Next", "下一页")}
            page={errors.page}
            pageSelectLabel={copy(locale, "Select page", "选择页码")}
            previousLabel={copy(locale, "Previous", "上一页")}
            totalPages={errors.totalPages}
          />
        </div>
      </CardContent>
    </Card>
  );
}

async function loadStatusData() {
  return requestGoJson<any>("/api/admin/status/overview");
}

// 聚合由 Go 后端按请求会话执行，避免在 Next 缓存包装器内读取 cookies。
const getCachedStatusData = loadStatusData;

export default async function GlobalStatusPage({
  searchParams,
}: GlobalStatusPageProps) {
  const session = await getServerSession();
  const locale = await getLocale();
  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const role = await getUserRoleById(session.user.id);
  if (!canViewImageBackendPool(role)) {
    redirect(`/${locale}/dashboard`);
  }

  const params = await searchParams;
  const timeZone = getAppTimeZone();
  const errorFilters = parseHistoricalErrorFilters(params, timeZone);
  const [data, historicalErrors] = await Promise.all([
    getCachedStatusData(),
    loadHistoricalGenerationErrors(errorFilters, {
      type: "user",
      userId: session.user.id,
      role,
    }),
  ]);
  const generationTotals = data.generationTotals;
  const creditBalance = data.credits.balance;
  const backendTotal = data.backend.api.total;
  const backendCooling = data.backend.api.cooling;
  const backendErrors = data.backend.api.error;

  return (
    <div className="container mx-auto space-y-8 px-4 py-6 md:px-6">
      <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-serif text-2xl font-medium tracking-tight">
            {copy(locale, "Global Status", "全局状态")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {copy(
              locale,
              "Read-only operational overview for image generation, credits, users, and backend health.",
              "只读运营总览：生图、积分、用户与后端池健康状态。"
            )}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
          <RefreshStatusButton
            label={copy(locale, "Refresh", "刷新")}
            refreshingLabel={copy(locale, "Refreshing", "刷新中")}
            errorLabel={copy(locale, "Refresh failed", "刷新失败")}
          />
          <Badge variant="outline" className="w-fit">
            {copy(locale, "Updated", "更新时间")}{" "}
            {formatDateTime(new Date(data.now), locale, timeZone)}
          </Badge>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title={copy(locale, "24h Platform SLA", "24小时平台 SLA")}
          value={formatPercent(data.stats24h.platformSla, locale)}
          description={copy(
            locale,
            "Completed / completed plus platform errors",
            "完成数 / 完成数 + 平台错误"
          )}
          icon={Activity}
          tone={data.stats24h.platformSla >= 0.95 ? "success" : "warning"}
          delay={0}
        />
        <MetricCard
          title={copy(locale, "24h Images", "24小时产出图片")}
          value={formatNumber(data.stats24h.producedImages, locale)}
          description={`${formatNumber(data.stats24h.completed, locale)} ${copy(
            locale,
            "completed generation records",
            "条完成记录"
          )}`}
          icon={ImageIcon}
          tone="success"
          delay={60}
        />
        <MetricCard
          title={copy(locale, "Credit Consumption 24h", "24小时积分消耗")}
          value={formatCredits(data.credits.ledger24h.consumption)}
          description={`${copy(locale, "Refund", "退款")} ${formatCredits(
            data.credits.ledger24h.refund
          )} · ${copy(locale, "Expired", "过期核销")} ${formatCredits(
            data.credits.ledger24h.expiration
          )}`}
          icon={Coins}
          delay={120}
        />
        <MetricCard
          title={copy(locale, "Backend Health", "后端池健康")}
          value={`${formatNumber(backendCooling, locale)} ${copy(
            locale,
            "cooling",
            "冷却中"
          )}`}
          description={`${formatNumber(backendTotal, locale)} ${copy(
            locale,
            "members",
            "成员"
          )} · ${formatNumber(backendErrors, locale)} ${copy(
            locale,
            "errors",
            "错误"
          )}`}
          icon={Server}
          tone={backendErrors > 0 || backendCooling > 0 ? "warning" : "success"}
          delay={180}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SlaCard
          title={copy(locale, "Recent SLA: last 24 hours", "最近 SLA：24 小时")}
          description={copy(
            locale,
            "SLA excludes moderation blocks and user request errors from the platform denominator.",
            "SLA 分母不包含审核拦截和用户请求错误，只看平台侧可用性。"
          )}
          stats={data.stats24h}
          locale={locale}
        />
        <SlaCard
          title={copy(locale, "Recent SLA: last 7 days", "最近 SLA：7 天")}
          description={copy(
            locale,
            "Use this window to spot sustained backend or upstream instability.",
            "用于观察持续性的后端或上游波动。"
          )}
          stats={data.stats7d}
          locale={locale}
        />
      </div>

      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle>{copy(locale, "Scheduler Routing", "调度路由")}</CardTitle>
          <CardDescription>
            {copy(
              locale,
              "Unified member acquisition, switching, rejection outcomes, and scheduler efficiency.",
              "统一成员获租、失败切换、拒绝结果与调度效率。"
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <MiniStat
            label={copy(locale, "24h acquisitions", "24小时获租")}
            value={formatNumber(data.scheduler24h.acquiredCount, locale)}
          />
          <MiniStat
            label={copy(locale, "24h backend switches", "24小时后端切换")}
            value={formatNumber(data.scheduler24h.switchCount, locale)}
          />
          <MiniStat
            label={copy(locale, "24h no candidate", "24小时无候选")}
            value={formatNumber(data.scheduler24h.noCandidateCount, locale)}
          />
          <MiniStat
            label={copy(locale, "24h capacity rejected", "24小时容量拒绝")}
            value={formatNumber(
              data.scheduler24h.capacityRejectedCount,
              locale
            )}
          />
          <MiniStat
            label={copy(locale, "24h avg candidates", "24小时平均候选")}
            value={
              data.scheduler24h.avgCandidateCount === null
                ? copy(locale, "No sample", "暂无样本")
                : formatNumber(data.scheduler24h.avgCandidateCount, locale)
            }
          />
          <MiniStat
            label={copy(
              locale,
              "24h avg routing latency",
              "24小时平均调度耗时"
            )}
            value={
              data.scheduler24h.avgLatencyMs === null
                ? copy(locale, "No sample", "暂无样本")
                : `${Math.round(data.scheduler24h.avgLatencyMs)}ms`
            }
          />
          <MiniStat
            label={copy(locale, "7d outcome distribution", "7天结果分布")}
            value={formatSchedulerDistribution(
              data.scheduler7d.byOutcome,
              "outcome",
              locale
            )}
          />
          <MiniStat
            label={copy(locale, "7d strategy distribution", "7天策略分布")}
            value={formatSchedulerDistribution(
              data.scheduler7d.byStrategy,
              "strategy",
              locale
            )}
          />
          <MiniStat
            label={copy(locale, "7d request distribution", "7天请求分布")}
            value={formatSchedulerDistribution(
              data.scheduler7d.byRequestKind,
              "requestKind",
              locale
            )}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="rounded-lg xl:col-span-2">
          <CardHeader>
            <CardTitle>
              {copy(locale, "Image Generation", "生图总览")}
            </CardTitle>
            <CardDescription>
              {copy(
                locale,
                "All-time records and recent production output.",
                "累计记录和近期产出。"
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MiniStat
              label={copy(locale, "Total records", "累计记录")}
              value={formatNumber(generationTotals.total, locale)}
            />
            <MiniStat
              label={copy(locale, "Completed records", "完成记录")}
              value={formatNumber(generationTotals.completed, locale)}
            />
            <MiniStat
              label={copy(locale, "Completed images", "累计完成图片")}
              value={formatNumber(generationTotals.completedImages, locale)}
            />
            <MiniStat
              label={copy(locale, "Pending records", "处理中")}
              value={formatNumber(generationTotals.pending, locale)}
            />
            <MiniStat
              label={copy(locale, "Failed records", "失败记录")}
              value={formatNumber(generationTotals.failed, locale)}
            />
            <MiniStat
              label={copy(locale, "7d image output", "7天图片产出")}
              value={formatNumber(data.stats7d.producedImages, locale)}
            />
            <MiniStat
              label={copy(locale, "7d credits on records", "7天记录积分")}
              value={formatCredits(data.stats7d.creditsConsumed)}
            />
            <MiniStat
              label={copy(locale, "All-time record credits", "累计记录积分")}
              value={formatCredits(generationTotals.creditsConsumed)}
            />
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>
              {copy(locale, "Users & Support", "用户与工单")}
            </CardTitle>
            <CardDescription>
              {copy(
                locale,
                "Account growth and unresolved ticket pressure.",
                "账号增长和未处理工单压力。"
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <MiniStat
              label={copy(locale, "Total users", "用户总数")}
              value={formatNumber(data.users.total, locale)}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <MiniStat
                label={copy(locale, "New users 24h", "24小时新增")}
                value={formatNumber(data.users.new24h, locale)}
              />
              <MiniStat
                label={copy(locale, "New users 7d", "7天新增")}
                value={formatNumber(data.users.new7d, locale)}
              />
              <MiniStat
                label={copy(locale, "Banned users", "封禁用户")}
                value={formatNumber(data.users.banned, locale)}
              />
              <MiniStat
                label={copy(locale, "Unresolved tickets", "未处理工单")}
                value={formatNumber(data.tickets.unresolved, locale)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {copy(locale, "Admin roles", "管理员角色")}：observer{" "}
              {data.users.observers} · admin {data.users.admins} · super{" "}
              {data.users.superAdmins}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>{copy(locale, "Credits", "积分账本")}</CardTitle>
            <CardDescription>
              {copy(
                locale,
                "Consumption, refunds, grants, and expired write-off.",
                "消耗、退款、发放和过期核销。"
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <MiniStat
                label={copy(locale, "Current balance", "当前余额")}
                value={formatCredits(creditBalance.totalBalance)}
              />
              <MiniStat
                label={copy(locale, "Total earned", "累计获得")}
                value={formatCredits(creditBalance.totalEarned)}
              />
              <MiniStat
                label={copy(locale, "Total spent", "累计消费")}
                value={formatCredits(creditBalance.totalSpent)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <MiniStat
                label={copy(locale, "7d consumption", "7天消耗")}
                value={formatCredits(data.credits.ledger7d.consumption)}
              />
              <MiniStat
                label={copy(locale, "7d refunds", "7天退款")}
                value={formatCredits(data.credits.ledger7d.refund)}
              />
              <MiniStat
                label={copy(locale, "7d grants/purchases", "7天发放/购买")}
                value={formatCredits(data.credits.ledger7d.grants)}
              />
              <MiniStat
                label={copy(locale, "7d expired write-off", "7天过期核销")}
                value={formatCredits(data.credits.ledger7d.expiration)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {copy(locale, "Active batch remaining", "有效批次剩余")}{" "}
              {formatCredits(data.credits.batches.activeRemaining)} ·{" "}
              {copy(locale, "Consumed batches", "已用尽批次")}{" "}
              {formatCredits(data.credits.batches.consumedAmount)} ·{" "}
              {copy(locale, "Expired batches", "已过期批次")}{" "}
              {formatCredits(data.credits.batches.expiredAmount)} ·{" "}
              {copy(locale, "Frozen balances", "冻结余额账户")}{" "}
              {formatNumber(creditBalance.frozen, locale)}
            </p>
          </CardContent>
        </Card>

        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>{copy(locale, "Backend Pool", "后端池")}</CardTitle>
            <CardDescription>
              {copy(
                locale,
                "API members with shared health semantics.",
                "API 成员的统一健康状态。"
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <BackendHealthBlock
                title={copy(locale, "API members", "API 成员")}
                stats={data.backend.api}
                locale={locale}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <VideoGenerationCard stats={data.video7d} locale={locale} />

      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            {copy(
              locale,
              "Top Failed Reasons: last 24 hours",
              "24小时高频失败原因"
            )}
          </CardTitle>
          <CardDescription>
            {copy(
              locale,
              "Grouped by normalized error message.",
              "按归一化错误信息聚合。"
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.topErrors24h.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {copy(
                locale,
                "No failures in the last 24 hours.",
                "24小时内没有失败记录。"
              )}
            </div>
          ) : (
            <div className="divide-y overflow-hidden rounded-lg border">
              {data.topErrors24h.map((item: any) => (
                <div
                  key={item.message}
                  className="grid gap-3 p-3 text-sm md:grid-cols-[120px_140px_1fr]"
                >
                  <div className="font-medium">
                    {formatNumber(item.count, locale)}x
                  </div>
                  <Badge
                    variant={
                      item.category === "platform" ? "destructive" : "secondary"
                    }
                    className="w-fit"
                  >
                    {item.category === "platform"
                      ? copy(locale, "Platform", "平台")
                      : item.category === "moderation"
                        ? copy(locale, "Moderation", "审核")
                        : copy(locale, "User request", "用户请求")}
                  </Badge>
                  <div className="min-w-0 break-words text-muted-foreground">
                    {item.message}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <HistoricalErrorsCard
        errors={historicalErrors}
        filters={errorFilters}
        locale={locale}
        timeZone={timeZone}
      />
    </div>
  );
}

// 视频生成独立统计区块。读 video_generation 表近 7 天聚合，
// 展示总数/完成/失败/进行中、成功率、累计积分与时长，以及按真实模型明细。
// 无任何样本时优雅降级为"暂无视频生成样本"。
function VideoGenerationCard({
  stats,
  locale,
}: {
  stats: VideoGenerationStats;
  locale: string;
}) {
  // 仅展示有过样本的真实模型，避免空表全是 0 行；无样本时整体走空态。
  const modelRows = stats.byModel.filter((item) => item.total > 0);

  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Video className="h-4 w-4 text-muted-foreground" />
          {copy(
            locale,
            "Video Generation",
            "视频生成"
          )}
        </CardTitle>
        <CardDescription>
          {copy(
            locale,
            "Independent pipeline from video_generation, last 7 days. Not folded into image stats.",
            "独立于生图管线,读 video_generation 表,最近 7 天;不计入生图统计。"
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {stats.total === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {copy(locale, "No video generation samples.", "暂无视频生成样本")}
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MiniStat
                label={copy(locale, "Total", "总数")}
                value={formatNumber(stats.total, locale)}
              />
              <MiniStat
                label={copy(locale, "Completed", "完成")}
                value={formatNumber(stats.completed, locale)}
              />
              <MiniStat
                label={copy(locale, "Failed", "失败")}
                value={formatNumber(stats.failed, locale)}
              />
              <MiniStat
                label={copy(locale, "Running", "进行中")}
                value={formatNumber(stats.running + stats.pending, locale)}
              />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {copy(locale, "Success rate", "成功率")}
                </span>
                <span className="font-medium">
                  {formatPercent(stats.successRate, locale)}
                </span>
              </div>
              <Progress value={Math.round(stats.successRate * 100)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <MiniStat
                label={copy(locale, "Credits consumed", "消耗积分")}
                value={formatCredits(stats.creditsConsumed)}
              />
              <MiniStat
                label={copy(locale, "Video seconds", "累计时长")}
                value={`${formatNumber(stats.totalVideoSeconds, locale)}s`}
              />
              <MiniStat
                label={copy(locale, "Avg generation time", "平均生成耗时")}
                value={formatDuration(stats.avgLatencySeconds, locale)}
              />
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[360px] text-left text-xs">
                <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">
                      {copy(locale, "Model", "真实模型")}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {copy(locale, "Total", "总数")}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {copy(locale, "Completed", "完成")}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {copy(locale, "Failed", "失败")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {modelRows.map((item) => (
                    <tr
                      key={item.model}
                      className="transition-colors duration-150 hover:bg-muted/50"
                    >
                      <td className="px-3 py-2 font-medium">{item.model}</td>
                      <td className="px-3 py-2">
                        {formatNumber(item.total, locale)}
                      </td>
                      <td className="px-3 py-2">
                        {formatNumber(item.completed, locale)}
                      </td>
                      <td className="px-3 py-2">
                        {formatNumber(item.failed, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BackendHealthBlock({
  title,
  stats,
  locale,
}: {
  title: string;
  stats: BackendHealthStats;
  locale: string;
}) {
  const availability =
    stats.enabled > 0 ? Math.max(0, stats.active / stats.enabled) : 1;
  const healthText = stats.healthStates
    .slice(0, 4)
    .map(
      (item) =>
        `${backendHealthLabel(item.health, locale)} ${formatNumber(
          item.count,
          locale
        )}`
    )
    .join(" · ");
  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium">{title}</div>
        <Badge variant="outline">{formatPercent(availability, locale)}</Badge>
      </div>
      <Progress value={Math.round(availability * 100)} />
      <div className="grid gap-2 text-xs text-muted-foreground">
        <span>
          {copy(locale, "Total", "总数")} {stats.total} ·{" "}
          {copy(locale, "Enabled", "启用")} {stats.enabled}
        </span>
        <span>
          {copy(locale, "Active", "可用")} {stats.active} ·{" "}
          {copy(locale, "Limited", "限流")} {stats.limited} ·{" "}
          {copy(locale, "Cooling", "冷却")} {stats.cooling} ·{" "}
          {copy(locale, "Error", "错误")} {stats.error}
        </span>
        <span>
          {copy(locale, "Success", "成功")} {stats.successCount} ·{" "}
          {copy(locale, "Failed", "失败")} {stats.failCount}
        </span>
        {healthText && <span>{healthText}</span>}
      </div>
    </div>
  );
}

/** 将统一成员健康枚举翻译为状态页标签，未知值原样展示以便运维发现。 */
function backendHealthLabel(health: string, locale: string) {
  if (health === "healthy") return copy(locale, "Healthy", "健康");
  if (health === "degraded") return copy(locale, "Degraded", "降级");
  if (health === "unhealthy") return copy(locale, "Unhealthy", "不健康");
  return health;
}
