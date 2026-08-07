"use client";

/**
 * 充值订单 URL 驱动筛选器。
 *
 * 使用方：PaymentOrderManagement。用户邮箱通过独立 UOL Action 服务端去抖搜索，
 * 订单号和状态只在提交时导航；筛选变化后始终清除签名 cursor。
 */
import {
  ADMIN_PAYMENT_ORDER_DEFAULT_DAYS,
  ADMIN_PAYMENT_ORDER_STATUSES,
  type AdminPaymentOrderStatus,
} from "@repo/shared/payment/admin-contract";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
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
import { Check, ChevronsUpDown, Loader2, Search, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useTransition } from "react";
import { requestNavigationFeedback } from "@/features/navigation/navigation-feedback-event";
import { useRouter } from "@/i18n/routing";
import { searchAdminPaymentOrderUsersAction } from "./actions";
import {
  type AdminPaymentOrderQueryState,
  buildAdminPaymentOrdersHref,
  buildRecentCalendarDaysRange,
} from "./admin-payment-query";
import { PaymentOrderDateRangePicker } from "./payment-order-date-range-picker";

type PaymentOrderFiltersProps = {
  initialUserOptions: Array<{ id: string; email: string }>;
  state: AdminPaymentOrderQueryState;
  today: string;
};

const ALL_STATUSES = "all";

/** 合并邮箱选项并按邮箱去重，确保当前已选用户始终可见。 */
function mergeUserOptions(
  options: Array<{ id: string; email: string }>,
  selectedEmail: string
): Array<{ id: string; email: string }> {
  const byEmail = new Map(options.map((option) => [option.email, option]));
  if (selectedEmail && !byEmail.has(selectedEmail)) {
    byEmail.set(selectedEmail, { id: selectedEmail, email: selectedEmail });
  }
  return [...byEmail.values()].sort((left, right) =>
    left.email.localeCompare(right.email)
  );
}

/** 渲染邮箱下拉、订单号输入、状态选择及应用/清除动作。 */
export function PaymentOrderFilters({
  initialUserOptions,
  state,
  today,
}: PaymentOrderFiltersProps) {
  const locale = useLocale();
  const t = useTranslations("AdminPayments.orders");
  const router = useRouter();
  const [isNavigating, startTransition] = useTransition();
  const [startDate, setStartDate] = useState(state.startDate);
  const [endDate, setEndDate] = useState(state.endDate);
  const [userEmail, setUserEmail] = useState(state.userEmail ?? "");
  const [orderId, setOrderId] = useState(state.orderId ?? "");
  const [status, setStatus] = useState<AdminPaymentOrderStatus | null>(
    state.status
  );
  const [isUserOpen, setIsUserOpen] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const [isSearchingUsers, setIsSearchingUsers] = useState(false);
  const [userSearchError, setUserSearchError] = useState<string | null>(null);
  const [userOptions, setUserOptions] = useState(() =>
    mergeUserOptions(initialUserOptions, state.userEmail ?? "")
  );

  useEffect(() => {
    setStartDate(state.startDate);
    setEndDate(state.endDate);
    setUserEmail(state.userEmail ?? "");
    setOrderId(state.orderId ?? "");
    setStatus(state.status);
    setUserOptions((current) =>
      mergeUserOptions(
        [...initialUserOptions, ...current],
        state.userEmail ?? ""
      )
    );
  }, [initialUserOptions, state]);

  useEffect(() => {
    if (!isUserOpen) return;
    let active = true;
    const timeout = window.setTimeout(async () => {
      setIsSearchingUsers(true);
      setUserSearchError(null);
      try {
        const result = await searchAdminPaymentOrderUsersAction({
          query: userSearch,
          limit: 20,
        });
        if (active && result?.data) {
          setUserOptions(mergeUserOptions(result.data.users, userEmail));
        } else if (active) {
          setUserSearchError(t("userSearchError"));
        }
      } catch {
        if (active) setUserSearchError(t("userSearchError"));
      } finally {
        if (active) setIsSearchingUsers(false);
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [isUserOpen, t, userEmail, userSearch]);

  const sortedUserOptions = useMemo(
    () =>
      [...userOptions].sort((left, right) =>
        left.email.localeCompare(right.email, locale)
      ),
    [locale, userOptions]
  );

  /** 使用当前控件值替换 URL，并从 keyset 首屏重新查询。 */
  function applyFilters(): void {
    startTransition(() => {
      requestNavigationFeedback();
      router.push(
        buildAdminPaymentOrdersHref({
          cursor: null,
          endDate,
          orderId: orderId.trim() || null,
          pageSize: state.pageSize,
          startDate,
          status,
          userEmail: userEmail || null,
        })
      );
    });
  }

  /** 清空业务筛选并返回订单首屏。 */
  function clearFilters(): void {
    const defaultRange = buildRecentCalendarDaysRange(
      today,
      ADMIN_PAYMENT_ORDER_DEFAULT_DAYS
    );
    setStartDate(defaultRange.startDate);
    setEndDate(defaultRange.endDate);
    setUserEmail("");
    setOrderId("");
    setStatus(null);
    setUserSearch("");
    startTransition(() => {
      requestNavigationFeedback();
      router.push(
        buildAdminPaymentOrdersHref({
          cursor: null,
          endDate: defaultRange.endDate,
          orderId: null,
          pageSize: state.pageSize,
          startDate: defaultRange.startDate,
          status: null,
          userEmail: null,
        })
      );
    });
  }

  return (
    <form
      aria-label={t("filters")}
      className="rounded-lg border bg-background p-4"
      onSubmit={(event) => {
        event.preventDefault();
        applyFilters();
      }}
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(250px,1.15fr)_minmax(240px,1.1fr)_minmax(220px,1fr)_180px_auto] xl:items-end">
        <div className="grid min-w-0 gap-2 text-xs font-medium text-muted-foreground">
          <span>{t("dateRange")}</span>
          <PaymentOrderDateRangePicker
            disabled={isNavigating}
            endDate={endDate}
            onRangeChange={(range) => {
              setStartDate(range.startDate);
              setEndDate(range.endDate);
            }}
            startDate={startDate}
            today={today}
          />
        </div>
        <div className="grid min-w-0 gap-2 text-xs font-medium text-muted-foreground">
          <span id="payment-order-user-filter-label">{t("userEmail")}</span>
          <Popover onOpenChange={setIsUserOpen} open={isUserOpen}>
            <PopoverTrigger asChild>
              <Button
                aria-expanded={isUserOpen}
                aria-labelledby="payment-order-user-filter-label"
                className="min-w-0 justify-between font-normal text-foreground"
                disabled={isNavigating}
                type="button"
                variant="outline"
              >
                <span className="truncate">{userEmail || t("allUsers")}</span>
                <ChevronsUpDown className="text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0"
            >
              <div className="flex items-center gap-2 border-b px-3">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  aria-label={t("searchUserEmail")}
                  autoComplete="off"
                  className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  onChange={(event) => setUserSearch(event.target.value)}
                  placeholder={t("searchUserEmail")}
                  type="search"
                  value={userSearch}
                />
                {isSearchingUsers ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : userSearch ? (
                  <button
                    aria-label={t("clearUserSearch")}
                    className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setUserSearch("")}
                    type="button"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
              <div
                aria-label={t("availableUsers")}
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
                  <span>{t("allUsers")}</span>
                  <Check className={cn("size-4", userEmail && "invisible")} />
                </button>
                {sortedUserOptions.map((option) => (
                  <button
                    aria-selected={userEmail === option.email}
                    className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    key={option.email}
                    onClick={() => {
                      setUserEmail(option.email);
                      setIsUserOpen(false);
                      setUserSearch("");
                    }}
                    role="option"
                    type="button"
                  >
                    <span className="min-w-0 truncate">{option.email}</span>
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        userEmail !== option.email && "invisible"
                      )}
                    />
                  </button>
                ))}
                {!isSearchingUsers && sortedUserOptions.length === 0 ? (
                  <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                    {t("noUsers")}
                  </p>
                ) : null}
                {userSearchError ? (
                  <p
                    aria-live="polite"
                    className="px-2 py-3 text-center text-xs text-destructive"
                    role="status"
                  >
                    {userSearchError}
                  </p>
                ) : null}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div className="grid min-w-0 gap-2 text-xs font-medium text-muted-foreground">
          <label htmlFor="payment-order-id-filter">{t("orderId")}</label>
          <Input
            disabled={isNavigating}
            id="payment-order-id-filter"
            maxLength={128}
            onChange={(event) => setOrderId(event.target.value)}
            placeholder={t("orderIdPlaceholder")}
            type="search"
            value={orderId}
          />
        </div>

        <div className="grid min-w-0 gap-2 text-xs font-medium text-muted-foreground">
          <label htmlFor="payment-order-status-filter">{t("status")}</label>
          <Select
            disabled={isNavigating}
            onValueChange={(value) =>
              setStatus(
                value === ALL_STATUSES
                  ? null
                  : (value as AdminPaymentOrderStatus)
              )
            }
            value={status ?? ALL_STATUSES}
          >
            <SelectTrigger id="payment-order-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>{t("allStatuses")}</SelectItem>
              {ADMIN_PAYMENT_ORDER_STATUSES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`statusLabels.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-2">
          <Button className="flex-1" disabled={isNavigating} type="submit">
            {isNavigating ? <Loader2 className="animate-spin" /> : <Search />}
            {t("apply")}
          </Button>
          <Button
            aria-label={t("clear")}
            disabled={isNavigating}
            onClick={clearFilters}
            size="icon"
            type="button"
            variant="outline"
          >
            <X />
          </Button>
        </div>
      </div>
    </form>
  );
}
