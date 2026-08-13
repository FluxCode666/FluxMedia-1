/**
 * 当前用户公告完整列表页。
 *
 * 页面解析 URL 分页状态，通过 UOL 读取精确总数和当前页，并以独立集合 mutation
 * 标记全部活跃公告已读；读取失败时显示可重试错误，不伪装为空列表。
 */

import { getUserRoleById } from "@repo/shared/auth/role-server";
import { getServerSession } from "@repo/shared/auth/server";
import { logError } from "@repo/shared/logger";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { Badge } from "@repo/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { cn } from "@repo/ui/utils";
import { CheckCircle2, Megaphone, Pin } from "lucide-react";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import {
  loadMyAnnouncementPage,
  markAllMyAnnouncementsRead,
} from "@/features/announcements/announcement-page-data";
import {
  type AnnouncementSearchParams,
  buildAnnouncementHref,
  parseAnnouncementPagination,
} from "@/features/announcements/announcement-pagination";
import { UrlPaginationControls } from "@/features/pagination/pagination-controls";
import { createPaginationUrlParamNames } from "@/features/pagination/url-adapter";
import { UrlPageSizeSelect } from "@/features/pagination/url-page-size-select";
import { Link } from "@/i18n/routing";

/**
 * 公告级别视觉映射：单色为主，仅 success/warning/critical 用语义色 token
 * （--color-success/--color-warning 已入 @theme，直接用标准工具类）。
 */
function getSeverityMeta(severity: string) {
  switch (severity) {
    case "success":
      return {
        label: "更新",
        badgeClassName: "border-success/40 text-success",
        borderClassName: "border-l-success",
      };
    case "warning":
      return {
        label: "重要",
        badgeClassName: "border-warning/40 text-warning",
        borderClassName: "border-l-warning",
      };
    case "critical":
      return {
        label: "紧急",
        badgeClassName: "border-destructive/40 text-destructive",
        borderClassName: "border-l-destructive",
      };
    default:
      return {
        label: "公告",
        badgeClassName: "text-muted-foreground",
        borderClassName: "border-l-foreground/30",
      };
  }
}

function formatDateTime(
  value: Date | string | null | undefined,
  locale: string,
  timeZone: string
) {
  return formatDateInTimeZone(
    value,
    locale,
    {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    },
    timeZone
  );
}

type DashboardAnnouncementsPageProps = {
  searchParams: Promise<AnnouncementSearchParams>;
};

/** 渲染 URL 驱动的本人公告分页。 */
export default async function DashboardAnnouncementsPage({
  searchParams,
}: DashboardAnnouncementsPageProps) {
  const [session, locale, rawSearchParams] = await Promise.all([
    getServerSession(),
    getLocale(),
    searchParams,
  ]);

  if (!session?.user) {
    redirect(`/${locale}/sign-in`);
  }

  const pagination = parseAnnouncementPagination(rawSearchParams);
  const role = await getUserRoleById(session.user.id);
  const principal = { userId: session.user.id, role };
  const retryHref = buildAnnouncementHref(pagination);
  const [announcementResult, timeZoneResult] = await Promise.allSettled([
    loadMyAnnouncementPage(principal, pagination),
    getUserTimeZone(session.user.id),
  ]);
  const announcementPage =
    announcementResult.status === "fulfilled" ? announcementResult.value : null;
  const timeZone =
    timeZoneResult.status === "fulfilled" ? timeZoneResult.value : "UTC";

  if (announcementPage) {
    if (announcementPage.page !== pagination.page) {
      redirect(
        `/${locale}${buildAnnouncementHref({
          page: announcementPage.page,
          pageSize: announcementPage.pageSize as 10 | 20 | 50,
        })}`
      );
    }
    try {
      await markAllMyAnnouncementsRead(principal);
    } catch {
      logError(new Error("Active announcements could not be marked as read"), {
        source: "dashboard-announcements-page",
      });
    }
  }

  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h2
          className="font-serif text-2xl font-medium tracking-tight"
          id="announcements-heading"
          tabIndex={-1}
        >
          {copy("Announcements", "公告")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {copy(
            "System updates, maintenance notices, and platform messages.",
            "系统更新、维护通知和平台消息会集中展示在这里。"
          )}
        </p>
      </div>

      {!announcementPage ? (
        <Card
          aria-live="assertive"
          className="border-destructive/30 bg-destructive/5"
          role="alert"
        >
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div>
              <p className="font-serif font-medium">
                {copy("Announcements could not be loaded", "公告加载失败")}
              </p>
              <p className="text-sm text-muted-foreground">
                {copy(
                  "Please check your connection and try again.",
                  "请检查连接后重试。"
                )}
              </p>
              <Link
                className="mt-3 inline-block text-sm font-medium underline"
                href={retryHref}
              >
                {copy("Retry", "重试")}
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : announcementPage.records.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Megaphone className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-serif font-medium">
                {copy("No active announcements", "暂无生效公告")}
              </p>
              <p className="text-sm text-muted-foreground">
                {copy(
                  "New notices will appear here when published.",
                  "有新公告发布后会显示在这里。"
                )}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {announcementPage.records.map((item, index) => {
            const meta = getSeverityMeta(item.severity);
            const wasUnread = !item.isRead;

            return (
              // 公告卡入场错峰：按索引 50ms 递增（12 个一轮回），fill-mode 用
              // backwards 保证延迟期间停留在动画首帧（透明），避免闪现跳变。
              <Card
                key={item.id}
                className={cn(
                  "border-l-4 animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none",
                  meta.borderClassName,
                  wasUnread && "bg-muted/30"
                )}
                style={{
                  animationDelay: `${(index % 12) * 50}ms`,
                  animationFillMode: "backwards",
                }}
              >
                <CardHeader className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] uppercase tracking-wider",
                        meta.badgeClassName
                      )}
                    >
                      {meta.label}
                    </Badge>
                    {item.isPinned && (
                      <Badge
                        variant="outline"
                        className="text-[10px] uppercase tracking-wider text-muted-foreground"
                      >
                        <Pin className="mr-1 h-3 w-3" />
                        {copy("Pinned", "置顶")}
                      </Badge>
                    )}
                    {wasUnread ? (
                      <Badge
                        variant="default"
                        className="text-[10px] uppercase tracking-wider"
                      >
                        {copy("New", "未读")}
                      </Badge>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {copy("Read", "已读")}
                      </span>
                    )}
                  </div>
                  <div>
                    <CardTitle className="font-serif text-xl font-medium leading-snug">
                      {item.title}
                    </CardTitle>
                    <p className="mt-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                      {copy("Published", "发布于")}{" "}
                      {formatDateTime(
                        item.publishedAt ?? item.createdAt,
                        locale,
                        timeZone
                      )}
                      {item.expiresAt
                        ? ` · ${copy("Expires", "过期于")} ${formatDateTime(
                            item.expiresAt,
                            locale,
                            timeZone
                          )}`
                        : ""}
                    </p>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {item.content}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {announcementPage ? (
        <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {copy(
              `Total ${announcementPage.totalCount} records · Page ${announcementPage.page} of ${announcementPage.totalPages}`,
              `共 ${announcementPage.totalCount} 条 · 第 ${announcementPage.page} / ${announcementPage.totalPages} 页`
            )}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <UrlPageSizeSelect
              itemSuffix={copy(" records", " 条")}
              label={copy("Rows per page", "每页条数")}
              options={[10, 20, 50].map((pageSize) => ({
                size: pageSize,
                href: buildAnnouncementHref({
                  page: 1,
                  pageSize: pageSize as 10 | 20 | 50,
                }),
              }))}
              value={announcementPage.pageSize}
            />
            <UrlPaginationControls
              ariaLabel={copy("Announcements pagination", "公告分页")}
              focusTargetId="announcements-heading"
              pageLabelTemplate={copy("Go to page {page}", "前往第 {page} 页")}
              currentPageLabelTemplate={copy(
                "Page {page}, current page",
                "第 {page} 页，当前页"
              )}
              names={createPaginationUrlParamNames()}
              nextLabel={copy("Next", "下一页")}
              page={announcementPage.page}
              pageSelectLabel={copy("Select page", "选择页码")}
              previousLabel={copy("Previous", "上一页")}
              totalPages={announcementPage.totalPages}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
