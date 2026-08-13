"use client";

/**
 * 账号池管理页的受控筛选工具栏。
 *
 * 使用方：ImageBackendPoolAdminPanel。组件复用 shadcn/ui Input、Select、Calendar
 * 与 Button，只回传筛选草稿并展示结果计数；名称、凭据健康、模型和日期的匹配
 * 语义集中在纯视图模型。
 */
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Search, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import {
  type BackendMemberCredentialFilter,
  type BackendMemberFilters,
  EMPTY_BACKEND_MEMBER_FILTERS,
  hasBackendGroupFilter,
  hasBackendMemberFilters,
} from "./admin-pool-view-model";
import { ADOBE_CREDENTIAL_HEALTH_STATUSES } from "./adobe-credential-health-status";
import { BackendMemberDateRangePicker } from "./backend-member-date-range-picker";

/** 供应商账号模型筛选的一条可读选项。 */
export interface BackendMemberFilterModelOption {
  id: string;
  label: string;
}

const CREDENTIAL_FILTERS = [
  "all",
  ...ADOBE_CREDENTIAL_HEALTH_STATUSES,
  "unhealthy",
  "not_applicable",
] as const satisfies readonly BackendMemberCredentialFilter[];

/** 将 Radix Select 的字符串值收窄为已声明凭据筛选。 */
function parseCredentialFilter(value: string): BackendMemberCredentialFilter {
  return CREDENTIAL_FILTERS.find((status) => status === value) ?? "all";
}

/**
 * 渲染供应商账号名称、凭据健康、模型与创建日期范围筛选。
 *
 * @param props 当前筛选值、模型选项、结果计数、日期合法性与更新回调。
 * @returns 可键盘操作且在窄屏纵向排列的筛选工具栏。
 * @sideEffects 输入变化时同步通知父组件；清除按钮恢复全部空筛选。
 */
export function BackendMemberFilterBar({
  filters,
  modelOptions,
  resultCount,
  totalCount,
  timeZone,
  invalidDateRange,
  onChange,
}: {
  filters: BackendMemberFilters;
  modelOptions: readonly BackendMemberFilterModelOption[];
  resultCount: number;
  totalCount: number;
  timeZone: string;
  invalidDateRange: boolean;
  onChange: (filters: BackendMemberFilters) => void;
}) {
  const [nameDraft, setNameDraft] = useState(filters.name);
  const hasFilters =
    hasBackendMemberFilters(filters) || Boolean(nameDraft.trim());

  useEffect(() => setNameDraft(filters.name), [filters.name]);

  /** 提交名称草稿，避免每个按键都写入浏览器历史和触发读取。 */
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onChange({ ...filters, name: nameDraft });
  }

  return (
    <form
      aria-label="筛选供应商账号"
      className="rounded-lg border bg-background p-4"
      onSubmit={handleSubmit}
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(220px,1.2fr)_minmax(180px,0.8fr)_minmax(220px,1fr)_minmax(240px,1fr)]">
        <label
          className="grid min-w-0 gap-2 text-xs font-medium text-muted-foreground"
          htmlFor="backend-member-name-filter"
        >
          账号名称
          <span className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
            />
            <Input
              className="pl-9"
              id="backend-member-name-filter"
              onChange={(event) => setNameDraft(event.target.value)}
              placeholder="输入名称片段"
              type="search"
              value={nameDraft}
            />
          </span>
        </label>
        <div className="grid min-w-0 gap-2 text-xs font-medium text-muted-foreground">
          <span id="backend-member-credential-filter-label">
            凭据状态（Adobe Direct）
          </span>
          <Select
            onValueChange={(value) =>
              onChange({
                ...filters,
                credentialStatus: parseCredentialFilter(value),
              })
            }
            value={filters.credentialStatus}
          >
            <SelectTrigger
              aria-labelledby="backend-member-credential-filter-label"
              className="w-full text-foreground"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部凭据状态</SelectItem>
              <SelectItem value="pending">待首次检查</SelectItem>
              <SelectItem value="healthy">健康</SelectItem>
              <SelectItem value="unhealthy">不健康（全部）</SelectItem>
              <SelectItem value="degraded">待复检</SelectItem>
              <SelectItem value="isolated">已隔离</SelectItem>
              <SelectItem value="overdue">探测失约</SelectItem>
              <SelectItem value="not_applicable">
                不适用（非 Adobe Direct）
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-0 gap-2 text-xs font-medium text-muted-foreground">
          <span id="backend-member-model-filter-label">支持的模型</span>
          <Select
            onValueChange={(modelId) => onChange({ ...filters, modelId })}
            value={filters.modelId}
          >
            <SelectTrigger
              aria-labelledby="backend-member-model-filter-label"
              className="w-full text-foreground"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部模型</SelectItem>
              {modelOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <BackendMemberDateRangePicker
          createdFrom={filters.createdFrom}
          createdTo={filters.createdTo}
          invalid={invalidDateRange}
          onRangeChange={(range) => onChange({ ...filters, ...range })}
        />
      </div>
      <div className="mt-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
        <p
          aria-live="polite"
          className={
            invalidDateRange
              ? "text-xs text-destructive"
              : "text-xs tabular-nums text-muted-foreground"
          }
        >
          {invalidDateRange
            ? "创建日期起点不能晚于终点"
            : hasFilters
              ? `${resultCount} / ${totalCount} 个账号 · 日期按 ${timeZone} 统计`
              : `共 ${totalCount} 个账号 · 日期按 ${timeZone} 统计`}
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" type="submit" variant="outline">
            搜索
          </Button>
          {hasFilters ? (
            <Button
              onClick={() => {
                setNameDraft("");
                onChange(EMPTY_BACKEND_MEMBER_FILTERS);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              <X />
              清除筛选
            </Button>
          ) : null}
        </div>
      </div>
    </form>
  );
}

/**
 * 渲染分组名称模糊搜索与结果计数。
 *
 * @param props 当前名称、结果计数、总数和变更回调。
 * @returns 响应式名称搜索栏。
 * @sideEffects 输入和清除操作通知父组件更新受控状态。
 */
export function BackendGroupFilterBar({
  name,
  resultCount,
  totalCount,
  onChange,
}: {
  name: string;
  resultCount: number;
  totalCount: number;
  onChange: (name: string) => void;
}) {
  const hasFilter = hasBackendGroupFilter(name);
  const [nameDraft, setNameDraft] = useState(name);

  useEffect(() => setNameDraft(name), [name]);

  return (
    <form
      aria-label="筛选账号池分组"
      className="flex flex-col gap-3 rounded-lg border bg-background p-4 sm:flex-row sm:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        onChange(nameDraft);
      }}
    >
      <label
        className="relative min-w-0 flex-1"
        htmlFor="backend-group-name-filter"
      >
        <span className="sr-only">按分组名称搜索</span>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          className="pl-9"
          id="backend-group-name-filter"
          onChange={(event) => setNameDraft(event.target.value)}
          placeholder="按分组名称模糊搜索"
          type="search"
          value={nameDraft}
        />
      </label>
      <span
        aria-live="polite"
        className="shrink-0 text-xs tabular-nums text-muted-foreground"
      >
        {hasFilter
          ? `${resultCount} / ${totalCount} 个分组`
          : `共 ${totalCount} 个分组`}
      </span>
      <Button className="shrink-0" size="sm" type="submit" variant="outline">
        搜索
      </Button>
      {hasFilter ? (
        <Button
          className="shrink-0"
          onClick={() => onChange("")}
          size="sm"
          type="button"
          variant="ghost"
        >
          <X />
          清除搜索
        </Button>
      ) : null}
    </form>
  );
}
