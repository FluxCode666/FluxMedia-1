/**
 * 用户与管理员共用的客服工单分页页。
 *
 * 使用方：控制台支持中心。页面只解析公开 URL、调用 UOL Action 并组合卡片；
 * 工单归属、管理员范围、精确计数和页码收敛由统一接口层负责。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { isAdminRole } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Plus, Search, Ticket } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { UrlPaginationControls } from "@/features/pagination/pagination-controls";
import { loadPaginationConfig } from "@/features/pagination/server";
import { UrlPageSizeSelect } from "@/features/pagination/url-page-size-select";
import { listTicketsAction } from "@/features/support/ticket-actions";
import {
  buildTicketCriteriaHref,
  buildTicketPageHref,
  buildTicketPageSizeHref,
  parseTicketListQuery,
  TICKET_PAGINATION_NAMES,
  type TicketSearchParams,
} from "@/features/support/ticket-query";

type SupportPageProps = { searchParams: Promise<TicketSearchParams> };

/** 返回状态徽章的稳定视觉样式。 */
function getStatusClassName(status: string): string {
  const classMap: Record<string, string> = {
    open: "border-foreground/40 text-foreground",
    in_progress: "border-transparent bg-foreground text-background",
    resolved: "text-muted-foreground",
    closed: "text-muted-foreground/70",
  };
  return classMap[status] ?? classMap.closed ?? "text-muted-foreground";
}

/** 返回优先级徽章的稳定视觉样式。 */
function getPriorityClassName(priority: string): string {
  const classMap: Record<string, string> = {
    low: "text-muted-foreground/70",
    medium: "text-muted-foreground",
    high: "border-destructive/40 text-destructive",
  };
  return classMap[priority] ?? classMap.medium ?? "text-muted-foreground";
}

/** 渲染 URL 驱动且失败可恢复的客服工单列表。 */
export default async function SupportPage({ searchParams }: SupportPageProps) {
  const [session, locale, rawSearchParams, paginationConfig] =
    await Promise.all([
      getServerSession(),
      getLocale(),
      searchParams,
      loadPaginationConfig(),
    ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);

  const [t, role, timeZone] = await Promise.all([
    getTranslations("Support"),
    getUserRoleById(session.user.id),
    getUserTimeZone(session.user.id),
  ]);
  const isAdmin = isAdminRole(role);
  const state = parseTicketListQuery(rawSearchParams, paginationConfig);
  const pathname = `/${locale}/dashboard/support`;
  const retryHref = buildTicketCriteriaHref(pathname, rawSearchParams, {
    search: state.search || null,
    status: state.status === "all" ? null : state.status,
  });
  const result = await listTicketsAction(state);
  const data = result?.data;
  if (data && data.page !== state.page) {
    redirect(
      buildTicketPageHref(pathname, rawSearchParams, data.page, "ticket")
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-serif text-2xl font-medium tracking-tight">
            {t("title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {isAdmin ? t("adminSubtitle") : t("subtitle")}
          </p>
        </div>
        <Link href={`/${locale}/dashboard/support/new`}>
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            {t("newTicket")}
          </Button>
        </Link>
      </div>

      <form className="grid gap-3 rounded-lg border bg-muted/20 p-4 sm:grid-cols-[1fr_180px_auto] sm:items-end">
        {state.pageSize !== 20 ? (
          <input name="pageSize" type="hidden" value={state.pageSize} />
        ) : null}
        <label className="grid gap-1 text-sm" htmlFor="ticket-search">
          <span className="font-medium">{t("searchLabel")}</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              defaultValue={state.search}
              id="ticket-search"
              maxLength={200}
              name="search"
              placeholder={
                isAdmin ? t("adminSearchPlaceholder") : t("searchPlaceholder")
              }
            />
          </div>
        </label>
        <div className="grid gap-1 text-sm">
          <span className="font-medium">{t("statusFilter")}</span>
          <Select defaultValue={state.status} name="status">
            <SelectTrigger aria-label={t("statusFilter")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allStatuses")}</SelectItem>
              {(["open", "in_progress", "resolved", "closed"] as const).map(
                (status) => (
                  <SelectItem key={status} value={status}>
                    {t(`statuses.${status}`)}
                  </SelectItem>
                )
              )}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit">{t("filter")}</Button>
      </form>

      {!data ? (
        <section
          aria-live="assertive"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center"
          role="alert"
        >
          <h3 className="font-serif text-lg font-medium">{t("loadError")}</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("loadErrorDescription")}
          </p>
          <Link
            className="mt-4 inline-block text-sm font-medium underline"
            href={retryHref}
          >
            {t("retry")}
          </Link>
        </section>
      ) : (
        <section aria-labelledby="ticket-list-heading" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p
              aria-live="polite"
              className="text-sm text-muted-foreground"
              id="ticket-list-heading"
              tabIndex={-1}
            >
              {t("totalRecords", { count: data.totalCount })}
            </p>
            <UrlPageSizeSelect
              itemSuffix={t("pageSizeSuffix")}
              label={t("rowsPerPage")}
              options={[10, 20, 50].map((pageSize) => ({
                size: pageSize,
                href: buildTicketPageSizeHref(
                  pathname,
                  rawSearchParams,
                  pageSize,
                  "ticket"
                ),
              }))}
              value={data.pageSize}
            />
          </div>

          {data.records.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Ticket className="mb-4 h-12 w-12 text-muted-foreground/50" />
                <h3 className="font-serif text-lg font-medium">
                  {t("noTickets")}
                </h3>
                <p className="mb-4 text-muted-foreground">
                  {state.search || state.status !== "all"
                    ? t("noFilteredTicketsDescription")
                    : t("noTicketsDescription")}
                </p>
                {!isAdmin && !state.search && state.status === "all" ? (
                  <Link href={`/${locale}/dashboard/support/new`}>
                    <Button>
                      <Plus className="mr-2 h-4 w-4" />
                      {t("createFirst")}
                    </Button>
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {data.records.map((item, index) => (
                <Link
                  className="block"
                  href={`/${locale}/dashboard/support/${item.id}`}
                  key={item.id}
                >
                  <Card
                    className="cursor-pointer animate-in fade-in slide-in-from-bottom-2 transition-[border-color,box-shadow,translate] duration-250 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-whisper motion-reduce:animate-none motion-reduce:transition-none"
                    style={{
                      animationDelay: `${(index % 12) * 50}ms`,
                      animationDuration: "400ms",
                      animationFillMode: "backwards",
                    }}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                          <CardTitle className="flex items-center gap-2 font-serif text-base font-medium">
                            {item.unread ? (
                              <span className="h-2 w-2 rounded-full bg-destructive" />
                            ) : null}
                            <span>{item.subject}</span>
                            {item.unread ? (
                              <Badge
                                className="text-[10px] uppercase tracking-wider"
                                variant="destructive"
                              >
                                {t("newActivity")}
                              </Badge>
                            ) : null}
                          </CardTitle>
                          <p className="text-sm text-muted-foreground">
                            {t(`categories.${item.category}`)} ·{" "}
                            {formatDateInTimeZone(
                              item.createdAt,
                              locale,
                              {
                                year: "numeric",
                                month: "2-digit",
                                day: "2-digit",
                              },
                              timeZone
                            )}
                            {isAdmin && item.userEmail
                              ? ` · ${item.userName || t("unknownUser")} (${item.userEmail})`
                              : ""}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge
                            className={`text-[10px] uppercase tracking-wider ${getPriorityClassName(item.priority)}`}
                            variant="outline"
                          >
                            {t(`priorities.${item.priority}`)}
                          </Badge>
                          <Badge
                            className={`text-[10px] uppercase tracking-wider ${getStatusClassName(item.status)}`}
                            variant="outline"
                          >
                            {t(`statuses.${item.status}`)}
                          </Badge>
                        </div>
                      </div>
                    </CardHeader>
                  </Card>
                </Link>
              ))}
            </div>
          )}

          <UrlPaginationControls
            ariaLabel={t("pagination")}
            className="justify-end"
            focusTargetId="ticket-list-heading"
            getPageLabel={(page, current) =>
              current
                ? t("currentPageLabel", { page })
                : t("pageLabel", { page })
            }
            names={TICKET_PAGINATION_NAMES}
            nextLabel={t("nextPage")}
            page={data.page}
            pageSelectLabel={t("pageSelect")}
            previousLabel={t("previousPage")}
            totalPages={data.totalPages}
          />
        </section>
      )}
    </div>
  );
}
