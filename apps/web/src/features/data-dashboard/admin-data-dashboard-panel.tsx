/**
 * 管理端数据看板客户端状态机与页面主体。
 *
 * 使用方：`/dashboard/admin/analytics`。日期范围、快照竞态和失败保留行为与用户看板
 * 保持一致，并增加名称/邮箱用户筛选；数据通过管理员 UOL Action 刷新。
 */
"use client";

import type {
  AdminDataDashboardInput,
  AdminDataDashboardUserOption,
  DataDashboardOutput,
} from "@repo/shared/analytics/contracts";
import { Button } from "@repo/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/ui/components/popover";
import { cn } from "@repo/ui/utils";
import {
  Check,
  ChevronsUpDown,
  Loader2,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { useRouter } from "@/i18n/routing";

import {
  refreshAdminDataDashboardAction,
  searchAdminDataDashboardUsersAction,
} from "./admin-actions";
import type { AdminDataDashboardActionResult } from "./admin-actions";
import {
  buildAdminDataDashboardHref,
  selectAdminDataDashboardRangeInput,
} from "./admin-data-dashboard-query";
import { DataDashboardChartsLazy } from "./charts/data-dashboard-charts-lazy";
import { DataDashboardDateRangePicker } from "./data-dashboard-date-range-picker";
import { DataDashboardMetricGrid } from "./data-dashboard-metric-grid";
import { DataDashboardPending } from "./data-dashboard-pending";
import {
  applyDataDashboardActionResult,
  createDataDashboardRequestGate,
  type DataDashboardFailureStatus,
  type DataDashboardViewState,
} from "./data-dashboard-state";
import {
  type DataDashboardAppliedRange,
  isDefaultDataDashboardRange,
} from "./data-dashboard-query";

type AdminDataDashboardPanelProps = {
  initialSnapshot: DataDashboardOutput | null;
  initialRequestedInput: AdminDataDashboardInput;
  initialSelectedUser: AdminDataDashboardUserOption | null;
  initialFailureStatus?: DataDashboardFailureStatus;
  invalidDeepLinkHref?: string | null;
  invalidSelectedUser?: boolean;
};

/** 合并搜索结果并确保当前选择不会因去抖搜索消失。 */
function mergeUserOptions(
  options: AdminDataDashboardUserOption[],
  selectedUser: AdminDataDashboardUserOption | null
): AdminDataDashboardUserOption[] {
  const byId = new Map(options.map((option) => [option.id, option]));
  if (selectedUser) byId.set(selectedUser.id, selectedUser);
  return [...byId.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

/** 将快照 asOf 格式化到管理员应用时区。 */
function formatSnapshotTime(snapshot: DataDashboardOutput, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: snapshot.timeZone,
  }).format(new Date(snapshot.asOf));
}

/**
 * 渲染可按用户和日期筛选、刷新并从失败恢复的管理员看板。
 *
 * @param props RSC 首屏快照、原筛选、已选用户、初始失败和非法深链提示。
 * @returns 管理员指标、图表、用户搜索和日期范围交互。
 */
export function AdminDataDashboardPanel({
  initialSnapshot,
  initialRequestedInput,
  initialSelectedUser,
  initialFailureStatus = null,
  invalidDeepLinkHref = null,
  invalidSelectedUser = false,
}: AdminDataDashboardPanelProps) {
  const locale = useLocale();
  const t = useTranslations("AdminDataDashboard");
  const router = useRouter();
  const [appliedUser, setAppliedUser] =
    useState<AdminDataDashboardUserOption | null>(initialSelectedUser);
  const [draftUser, setDraftUser] =
    useState<AdminDataDashboardUserOption | null>(initialSelectedUser);
  const [isUserOpen, setIsUserOpen] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [isSearchingUsers, setIsSearchingUsers] = useState(false);
  const [userSearchError, setUserSearchError] = useState(false);
  const [userOptions, setUserOptions] = useState<
    AdminDataDashboardUserOption[]
  >(() =>
    mergeUserOptions(
      initialSelectedUser ? [initialSelectedUser] : [],
      initialSelectedUser
    )
  );
  const initialAppliedRange = initialSnapshot
    ? {
        startDate: initialSnapshot.range.startDate,
        endDate: initialSnapshot.range.endDate,
      }
    : null;
  const [view, setView] = useState<DataDashboardViewState>({
    snapshot: initialSnapshot,
    appliedRange: initialAppliedRange,
    requestStatus: initialSnapshot ? "idle" : "error",
    failureStatus: initialSnapshot
      ? null
      : (initialFailureStatus ?? "unavailable"),
  });
  const [draftRange, setDraftRange] = useState({
    startDate: initialAppliedRange?.startDate ?? "",
    endDate: initialAppliedRange?.endDate ?? "",
  });
  const [liveMessage, setLiveMessage] = useState(
    invalidDeepLinkHref
      ? t(
          invalidSelectedUser
            ? "state.invalidUserDeepLink"
            : "state.invalidDeepLink"
        )
      : ""
  );
  const requestGate = useRef(createDataDashboardRequestGate());
  const appliedUserId = appliedUser?.id ?? null;

  useEffect(() => {
    if (!isUserOpen) return;
    let active = true;
    const timeout = window.setTimeout(async () => {
      setIsSearchingUsers(true);
      setUserSearchError(false);
      try {
        const result = await searchAdminDataDashboardUsersAction({
          query: userSearch,
          limit: 20,
        });
        if (active && result?.data) {
          setUserOptions(mergeUserOptions(result.data.users, draftUser));
        } else if (active) {
          setUserSearchError(true);
        }
      } catch {
        if (active) setUserSearchError(true);
      } finally {
        if (active) setIsSearchingUsers(false);
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timeout);
      setIsSearchingUsers(false);
    };
  }, [draftUser, isUserOpen, userSearch]);

  useEffect(() => {
    if (!invalidDeepLinkHref) return;
    router.replace(invalidDeepLinkHref, { scroll: false });
  }, [invalidDeepLinkHref, router]);

  /** 提交自定义范围或刷新已应用范围，并只允许最新请求提交状态。 */
  async function requestSnapshot(
    range: DataDashboardAppliedRange | Record<string, never>,
    user: AdminDataDashboardUserOption | null = appliedUser
  ): Promise<void> {
    const userId = user?.id ?? null;
    const requestId = requestGate.current.begin();
    setView((current) => ({
      ...current,
      requestStatus: "loading",
      failureStatus: null,
    }));
    setLiveMessage(t("state.loadingDescription"));
    let actionResult: AdminDataDashboardActionResult;
    try {
      const input: AdminDataDashboardInput = {
        ...range,
        ...(userId ? { userId } : {}),
      };
      const result = await refreshAdminDataDashboardAction(input);
      actionResult = result?.data ?? { status: "unavailable" as const };
    } catch {
      actionResult = { status: "unavailable" as const };
    }
    if (!requestGate.current.isLatest(requestId)) return;
    setView((current) => applyDataDashboardActionResult(current, actionResult));
    if (actionResult.status === "ready") {
      const nextRange = {
        startDate: actionResult.snapshot.range.startDate,
        endDate: actionResult.snapshot.range.endDate,
      };
      setDraftRange(nextRange);
      setAppliedUser(user);
      setDraftUser(user);
      const href = buildAdminDataDashboardHref(
        isDefaultDataDashboardRange(nextRange, actionResult.snapshot.today)
          ? userId
            ? { userId }
            : {}
          : { ...nextRange, ...(userId ? { userId } : {}) }
      );
      router.replace(href, { scroll: false });
      setLiveMessage(t("state.updated"));
      return;
    }
    setLiveMessage(t(`state.failure.${actionResult.status}`));
  }

  /** 手动刷新始终查询已应用范围，不读取未提交草稿。 */
  function refreshAppliedRange(): void {
    void requestSnapshot(view.appliedRange ?? {}, appliedUser);
  }

  /** 应用用户草稿并查询当前已应用日期范围。 */
  function applyUserFilter(): void {
    setIsUserOpen(false);
    void requestSnapshot(view.appliedRange ?? {}, draftUser);
  }

  /** 首屏失败重试保留原用户与日期；用户信息未解析时重载同一深链。 */
  function retryInitialLoad(): void {
    const requestedUserId =
      "userId" in initialRequestedInput
        ? initialRequestedInput.userId
        : undefined;
    if (requestedUserId && !initialSelectedUser) {
      window.location.reload();
      return;
    }
    void requestSnapshot(
      selectAdminDataDashboardRangeInput(initialRequestedInput),
      initialSelectedUser
    );
  }

  const isLoading = view.requestStatus === "loading";
  if (!view.snapshot || !view.appliedRange) {
    return (
      <div aria-busy={isLoading} className="space-y-6">
        <header>
          <h1 className="font-serif text-2xl font-medium tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </header>
        <DataDashboardPending
          failureStatus={view.failureStatus}
          isLoading={isLoading}
          onRetry={retryInitialLoad}
        />
        <p aria-live="polite" className="sr-only">
          {liveMessage}
        </p>
      </div>
    );
  }

  const snapshot = view.snapshot;
  const normalizedUserSearch = userSearch.trim().toLocaleLowerCase();
  const visibleUserOptions = userOptions.filter(
    (option) =>
      !normalizedUserSearch ||
      option.name.toLocaleLowerCase().includes(normalizedUserSearch) ||
      option.email.toLocaleLowerCase().includes(normalizedUserSearch)
  );
  return (
    <div aria-busy={isLoading} className="space-y-8">
      <header className="space-y-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="font-serif text-2xl font-medium tracking-tight">
              {t("title")}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {t("description")}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("snapshotMeta", {
                timeZone: snapshot.timeZone,
                asOf: formatSnapshotTime(snapshot, locale),
              })}
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Popover onOpenChange={setIsUserOpen} open={isUserOpen}>
              <PopoverTrigger asChild>
                <Button
                  aria-label={t("userFilter.label")}
                  aria-expanded={isUserOpen}
                  className="h-auto min-h-9 min-w-0 justify-between gap-2 px-3 py-2 font-normal sm:min-w-[240px]"
                  disabled={isLoading}
                  role="combobox"
                  type="button"
                  variant="outline"
                >
                  <span className="min-w-0 truncate text-left">
                    {appliedUser
                      ? `${appliedUser.name} · ${appliedUser.email}`
                      : t("userFilter.allUsers")}
                  </span>
                  <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0"
              >
                <div className="flex items-center gap-2 border-b px-3">
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    aria-label={t("userFilter.searchLabel")}
                    autoComplete="off"
                    className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    onChange={(event) => setUserSearch(event.target.value)}
                    placeholder={t("userFilter.searchPlaceholder")}
                    type="search"
                    value={userSearch}
                  />
                  {isSearchingUsers ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : userSearch ? (
                    <button
                      aria-label={t("userFilter.clearSearch")}
                      className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setUserSearch("")}
                      type="button"
                    >
                      <X className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                <div
                  aria-label={t("userFilter.options")}
                  className="max-h-64 overflow-y-auto p-1"
                  role="listbox"
                >
                  <button
                    aria-selected={!draftUser}
                    className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setDraftUser(null)}
                    role="option"
                    type="button"
                  >
                    <span>{t("userFilter.allUsers")}</span>
                    <Check className={cn("size-4", draftUser && "invisible")} />
                  </button>
                  {visibleUserOptions.map((option) => (
                    <button
                      aria-selected={draftUser?.id === option.id}
                      className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      key={option.id}
                      onClick={() => setDraftUser(option)}
                      role="option"
                      type="button"
                    >
                      <span className="min-w-0 truncate">
                        <span className="block truncate">{option.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {option.email}
                        </span>
                      </span>
                      <Check
                        className={cn(
                          "size-4 shrink-0",
                          draftUser?.id !== option.id && "invisible"
                        )}
                      />
                    </button>
                  ))}
                  {userSearchError ? (
                    <p className="px-2 py-4 text-center text-sm text-destructive">
                      {t("userFilter.searchError")}
                    </p>
                  ) : null}
                  {!isSearchingUsers &&
                  !userSearchError &&
                  visibleUserOptions.length === 0 ? (
                    <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                      {t("userFilter.empty")}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-3 border-t px-3 py-3">
                  <p className="min-h-4 text-xs text-muted-foreground">
                    {draftUser?.id !== appliedUserId
                      ? t("userFilter.unapplied")
                      : ""}
                  </p>
                  <Button
                    disabled={isLoading || draftUser?.id === appliedUserId}
                    onClick={applyUserFilter}
                    size="sm"
                    type="button"
                  >
                    <Check />
                    {t("userFilter.apply")}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            <DataDashboardDateRangePicker
              appliedRange={view.appliedRange}
              disabled={isLoading}
              draftRange={draftRange}
              isApplying={isLoading}
              onApply={(range) => void requestSnapshot(range)}
              onDraftChange={setDraftRange}
              today={snapshot.today}
            />
            <Button
              aria-label={t("actions.refresh")}
              className="shrink-0"
              disabled={isLoading}
              onClick={refreshAppliedRange}
              type="button"
            >
              <RefreshCw
                className={cn(
                  isLoading && "animate-spin motion-reduce:animate-none"
                )}
              />
              {t("actions.refresh")}
            </Button>
          </div>
        </div>
        {view.requestStatus === "stale" && view.failureStatus ? (
          <div
            className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            role="alert"
          >
            <span className="flex items-center gap-2">
              <TriangleAlert aria-hidden="true" className="size-4" />
              {t(`state.failure.${view.failureStatus}`)}
            </span>
            <Button
              onClick={refreshAppliedRange}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("actions.retry")}
            </Button>
          </div>
        ) : null}
      </header>

      <DataDashboardMetricGrid
        namespace="AdminDataDashboard"
        snapshot={snapshot}
      />

      <section
        aria-labelledby="admin-data-dashboard-charts-title"
        className="space-y-3"
      >
        <h2
          className="font-serif text-lg font-medium tracking-tight"
          id="admin-data-dashboard-charts-title"
        >
          {t("charts.title")}
        </h2>
        <DataDashboardChartsLazy
          namespace="AdminDataDashboard"
          snapshot={snapshot}
        />
      </section>
      <p aria-live="polite" className="sr-only">
        {liveMessage}
      </p>
    </div>
  );
}
