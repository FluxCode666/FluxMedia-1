"use client";

/**
 * 使用记录页面的 URL 驱动筛选栏。
 *
 * 使用方：HistoryClient。组件只维护尚未提交的控件值，应用或清空时通过国际化
 * router 更新白名单 URL，并同时清除当前签名 cursor。
 */

import { formatAdobeModelIdForDisplay } from "@repo/shared/adobe";
import { Button } from "@repo/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { cn } from "@repo/ui/utils";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { useLocale } from "next-intl";
import { useEffect, useMemo, useState, useTransition } from "react";
import { requestNavigationFeedback } from "@/features/navigation/navigation-feedback-event";
import { useRouter } from "@/i18n/routing";

import { HistoryDateRangePicker } from "./history-date-range-picker";
import {
  buildHistoryHref,
  type HistoryQueryState,
  type HistoryStatusFilter,
  type HistoryTypeFilter,
  hasActiveHistoryFilters,
} from "./history-query";

type HistoryFiltersProps = {
  modelOptions: string[];
  state: HistoryQueryState;
  historyPath?: string;
  showUserEmailFilter?: boolean;
  userOptions?: Array<{ id: string; email: string }>;
};

const ALL_VALUE = "all";

// 全局页比个人页多一个用户条件；auto-fit 按筛选容器的实际宽度重新分列，侧边栏
// 压缩内容区时会把放不下的条件排到下一行，避免固定六列横向溢出。
const GLOBAL_HISTORY_FILTER_GRID =
  "xl:grid-cols-[repeat(auto-fit,minmax(190px,1fr))]";

/**
 * 渲染日期、模型、状态与产物类型筛选。
 *
 * @param props 服务端规范化后的 URL 状态和本人历史模型选项。
 * @returns 可访问、响应式筛选控件；不会自行请求数据。
 * @sideEffects 应用或清空筛选时触发同源客户端导航。
 */
export function HistoryFilters({
  modelOptions,
  state,
  historyPath,
  showUserEmailFilter = false,
  userOptions = [],
}: HistoryFiltersProps) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const router = useRouter();
  const [isNavigating, startTransition] = useTransition();
  const [createdFrom, setCreatedFrom] = useState(state.createdFrom ?? "");
  const [createdTo, setCreatedTo] = useState(state.createdTo ?? "");
  const [model, setModel] = useState(state.model ?? "");
  const [status, setStatus] = useState<HistoryStatusFilter | null>(
    state.status
  );
  const [type, setType] = useState<HistoryTypeFilter | null>(state.type);
  const [userEmail, setUserEmail] = useState(state.userEmail ?? "");
  const [modelSearch, setModelSearch] = useState("");
  const [isModelOpen, setIsModelOpen] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [isUserOpen, setIsUserOpen] = useState(false);
  const [dateError, setDateError] = useState<string | null>(null);

  useEffect(() => {
    setCreatedFrom(state.createdFrom ?? "");
    setCreatedTo(state.createdTo ?? "");
    setModel(state.model ?? "");
    setStatus(state.status);
    setType(state.type);
    setUserEmail(state.userEmail ?? "");
    setDateError(null);
  }, [state]);

  const sortedModels = useMemo(() => {
    const uniqueModels = new Set(
      modelOptions.map((option) => option.trim()).filter(Boolean)
    );
    if (state.model) uniqueModels.add(state.model);
    return [...uniqueModels].sort((left, right) =>
      left.localeCompare(right, locale)
    );
  }, [locale, modelOptions, state.model]);
  const normalizedModelSearch = modelSearch.trim().toLocaleLowerCase(locale);
  const visibleModels = normalizedModelSearch
    ? sortedModels.filter((option) =>
        option.toLocaleLowerCase(locale).includes(normalizedModelSearch)
      )
    : sortedModels;
  const sortedUsers = useMemo(() => {
    const usersByEmail = new Map<string, { id: string; email: string }>();
    for (const user of userOptions) {
      const email = user.email.trim();
      if (email) usersByEmail.set(email, { id: user.id, email });
    }
    return [...usersByEmail.values()].sort((left, right) =>
      left.email.localeCompare(right.email, locale)
    );
  }, [locale, userOptions]);
  const normalizedUserSearch = userSearch.trim().toLocaleLowerCase(locale);
  const visibleUsers = normalizedUserSearch
    ? sortedUsers.filter((user) =>
        user.email.toLocaleLowerCase(locale).includes(normalizedUserSearch)
      )
    : sortedUsers;

  /** 以新筛选替换 URL；筛选变化后必须从 keyset 首屏重新开始。 */
  function navigateWithFilters(next: {
    createdFrom: string;
    createdTo: string;
    model: string;
    status: HistoryStatusFilter | null;
    type: HistoryTypeFilter | null;
    userEmail: string;
  }): void {
    const href = buildHistoryHref(
      {
        createdFrom: next.createdFrom || null,
        createdTo: next.createdTo || null,
        cursor: null,
        model: next.model.trim() || null,
        status: next.status,
        type: next.type,
        userEmail: next.userEmail.trim() || null,
      },
      { path: historyPath }
    );
    startTransition(() => {
      requestNavigationFeedback(href);
      router.push(href);
    });
  }

  /** 校验日期顺序并提交当前控件值。 */
  function applyFilters(): void {
    if (createdFrom && createdTo && createdFrom > createdTo) {
      setDateError(
        copy(
          "The start date cannot be later than the end date.",
          "开始日期不能晚于结束日期。"
        )
      );
      return;
    }
    setDateError(null);
    navigateWithFilters({
      createdFrom,
      createdTo,
      model,
      status,
      type,
      userEmail,
    });
  }

  /** 清空全部业务筛选并返回使用记录首屏。 */
  function clearFilters(): void {
    setCreatedFrom("");
    setCreatedTo("");
    setModel("");
    setStatus(null);
    setType(null);
    setUserEmail("");
    setUserSearch("");
    setDateError(null);
    navigateWithFilters({
      createdFrom: "",
      createdTo: "",
      model: "",
      status: null,
      type: null,
      userEmail: "",
    });
  }

  return (
    <section
      aria-label={copy("Usage records filters", "使用记录筛选")}
      className="rounded-lg border border-border bg-background p-4"
    >
      <div
        className={cn(
          "grid gap-3 md:grid-cols-2 xl:items-end",
          showUserEmailFilter
            ? GLOBAL_HISTORY_FILTER_GRID
            : "xl:grid-cols-[minmax(280px,1.4fr)_minmax(190px,1fr)_150px_140px_auto]"
        )}
      >
        <HistoryDateRangePicker
          createdFrom={createdFrom}
          createdTo={createdTo}
          disabled={isNavigating}
          isZh={isZh}
          onRangeChange={({
            createdFrom: nextCreatedFrom,
            createdTo: nextCreatedTo,
          }) => {
            setCreatedFrom(nextCreatedFrom);
            setCreatedTo(nextCreatedTo);
            setDateError(null);
          }}
        />

        <div className="grid min-w-0 gap-2 text-xs font-medium text-muted-foreground">
          <span id="history-model-filter-label">{copy("Model", "模型")}</span>
          <Popover onOpenChange={setIsModelOpen} open={isModelOpen}>
            <PopoverTrigger asChild>
              <Button
                aria-expanded={isModelOpen}
                aria-labelledby="history-model-filter-label"
                className="min-w-0 justify-between font-normal text-foreground"
                disabled={isNavigating}
                type="button"
                variant="outline"
              >
                <span className="truncate">
                  {model
                    ? formatAdobeModelIdForDisplay(model)
                    : copy("All models", "全部模型")}
                </span>
                <ChevronsUpDown className="text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0"
            >
              <div className="flex items-center gap-2 border-b border-border px-3">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  aria-label={copy("Search models", "搜索模型")}
                  className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder={copy("Search models", "搜索模型")}
                  type="search"
                  value={modelSearch}
                />
                {modelSearch ? (
                  <button
                    aria-label={copy("Clear model search", "清空模型搜索")}
                    className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setModelSearch("")}
                    type="button"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
              <div
                aria-label={copy("Available models", "可选模型")}
                className="max-h-64 overflow-y-auto p-1"
                role="listbox"
              >
                <button
                  aria-selected={!model}
                  className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setModel("");
                    setIsModelOpen(false);
                    setModelSearch("");
                  }}
                  role="option"
                  type="button"
                >
                  <span>{copy("All models", "全部模型")}</span>
                  <Check className={cn("size-4", model && "invisible")} />
                </button>
                {visibleModels.map((option) => (
                  <button
                    aria-selected={model === option}
                    className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    key={option}
                    onClick={() => {
                      setModel(option);
                      setIsModelOpen(false);
                      setModelSearch("");
                    }}
                    role="option"
                    type="button"
                  >
                    <span className="min-w-0 break-all font-mono text-xs">
                      {formatAdobeModelIdForDisplay(option)}
                    </span>
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        model !== option && "invisible"
                      )}
                    />
                  </button>
                ))}
                {visibleModels.length === 0 ? (
                  <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                    {copy("No matching models", "没有匹配的模型")}
                  </p>
                ) : null}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {showUserEmailFilter ? (
          <div className="grid min-w-0 gap-2 text-xs font-medium text-muted-foreground">
            <span id="history-user-filter-label">
              {copy("User email", "用户邮箱")}
            </span>
            <Popover onOpenChange={setIsUserOpen} open={isUserOpen}>
              <PopoverTrigger asChild>
                <Button
                  aria-expanded={isUserOpen}
                  aria-labelledby="history-user-filter-label"
                  className="min-w-0 justify-between font-normal text-foreground"
                  disabled={isNavigating}
                  type="button"
                  variant="outline"
                >
                  <span className="truncate">
                    {userEmail || copy("All users", "全部用户")}
                  </span>
                  <ChevronsUpDown className="text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0"
              >
                <div className="flex items-center gap-2 border-b border-border px-3">
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    aria-label={copy("Search user emails", "搜索用户邮箱")}
                    className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    onChange={(event) => setUserSearch(event.target.value)}
                    placeholder={copy("Search user emails", "搜索用户邮箱")}
                    type="search"
                    value={userSearch}
                  />
                  {userSearch ? (
                    <button
                      aria-label={copy(
                        "Clear user email search",
                        "清空用户邮箱搜索"
                      )}
                      className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setUserSearch("")}
                      type="button"
                    >
                      <X className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                <div
                  aria-label={copy("Available users", "可选用户")}
                  className="max-h-64 overflow-y-auto p-1"
                  role="listbox"
                >
                  <button
                    aria-selected={!userEmail}
                    className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      setUserEmail("");
                      setIsUserOpen(false);
                      setUserSearch("");
                    }}
                    role="option"
                    type="button"
                  >
                    <span>{copy("All users", "全部用户")}</span>
                    <Check className={cn("size-4", userEmail && "invisible")} />
                  </button>
                  {visibleUsers.map((user) => (
                    <button
                      aria-selected={userEmail === user.email}
                      className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      key={user.id}
                      onClick={() => {
                        setUserEmail(user.email);
                        setIsUserOpen(false);
                        setUserSearch("");
                      }}
                      role="option"
                      type="button"
                    >
                      <span className="min-w-0 truncate">{user.email}</span>
                      <Check
                        className={cn(
                          "size-4 shrink-0",
                          userEmail !== user.email && "invisible"
                        )}
                      />
                    </button>
                  ))}
                  {visibleUsers.length === 0 ? (
                    <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                      {copy("No matching users", "没有匹配的用户")}
                    </p>
                  ) : null}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        ) : null}

        <div className="grid gap-2 text-xs font-medium text-muted-foreground">
          <span id="history-status-filter-label">{copy("Status", "状态")}</span>
          <Select
            disabled={isNavigating}
            onValueChange={(value) =>
              setStatus(
                value === ALL_VALUE ? null : (value as HistoryStatusFilter)
              )
            }
            value={status ?? ALL_VALUE}
          >
            <SelectTrigger
              aria-labelledby="history-status-filter-label"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_VALUE}>
                {copy("All statuses", "全部状态")}
              </SelectItem>
              <SelectItem value="processing">
                {copy("Processing", "处理中")}
              </SelectItem>
              <SelectItem value="completed">
                {copy("Completed", "已完成")}
              </SelectItem>
              <SelectItem value="failed">{copy("Failed", "失败")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2 text-xs font-medium text-muted-foreground">
          <span id="history-type-filter-label">{copy("Type", "类型")}</span>
          <Select
            disabled={isNavigating}
            onValueChange={(value) =>
              setType(value === ALL_VALUE ? null : (value as HistoryTypeFilter))
            }
            value={type ?? ALL_VALUE}
          >
            <SelectTrigger
              aria-labelledby="history-type-filter-label"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_VALUE}>
                {copy("All types", "全部类型")}
              </SelectItem>
              <SelectItem value="image">{copy("Image", "图片")}</SelectItem>
              <SelectItem value="video">{copy("Video", "视频")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-2 md:col-span-2 xl:col-span-1">
          <Button
            className="flex-1 xl:flex-none"
            disabled={isNavigating}
            onClick={applyFilters}
            type="button"
          >
            {copy("Apply", "查询")}
          </Button>
          {hasActiveHistoryFilters(state) ? (
            <Button
              disabled={isNavigating}
              onClick={clearFilters}
              type="button"
              variant="outline"
            >
              {copy("Clear", "清空")}
            </Button>
          ) : null}
        </div>
      </div>
      {dateError ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {dateError}
        </p>
      ) : null}
    </section>
  );
}
