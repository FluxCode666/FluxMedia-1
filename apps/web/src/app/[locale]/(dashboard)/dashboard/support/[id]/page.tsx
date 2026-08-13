/**
 * 客服工单详情与消息分页页。
 *
 * 使用方：普通用户查看本人工单、管理员处理任意工单。页面只调用 UOL Action；
 * 消息读取与已读维护写入严格分离，失败不会伪装为空对话。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { isAdminRole } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { AdminTicketReplyForm } from "@repo/shared/support/components/admin-ticket-reply-form";
import { AdminTicketStatusSelect } from "@repo/shared/support/components/admin-ticket-status-select";
import { TicketMessageForm } from "@repo/shared/support/components/ticket-message-form";
import {
  ticketCategories,
  ticketPriorities,
  ticketStatuses,
} from "@repo/shared/support/schemas";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/ui/components/avatar";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { UrlPaginationControls } from "@/features/pagination/pagination-controls";
import { loadPaginationConfig } from "@/features/pagination/server";
import { UrlPageSizeSelect } from "@/features/pagination/url-page-size-select";
import { MarkTicketSeen } from "@/features/support/mark-ticket-seen";
import { listTicketMessagesAction } from "@/features/support/ticket-actions";
import {
  buildTicketPageHref,
  buildTicketPageSizeHref,
  MESSAGE_PAGINATION_NAMES,
  parseTicketMessageQuery,
  type TicketSearchParams,
} from "@/features/support/ticket-query";

type TicketDetailPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<TicketSearchParams>;
};

/** 返回展示名的至多两个大写首字母。 */
function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/** 渲染分页消息历史与工单交互。 */
export default async function TicketDetailPage({
  params,
  searchParams,
}: TicketDetailPageProps) {
  const [{ id }, rawSearchParams, session, locale, paginationConfig] =
    await Promise.all([
      params,
      searchParams,
      getServerSession(),
      getLocale(),
      loadPaginationConfig(),
    ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);

  const [role, timeZone] = await Promise.all([
    getUserRoleById(session.user.id),
    getUserTimeZone(session.user.id),
  ]);
  const isAdmin = isAdminRole(role);
  const state = parseTicketMessageQuery(rawSearchParams, paginationConfig);
  const result = await listTicketMessagesAction({ ticketId: id, ...state });
  if (result?.serverError === "Ticket not found") notFound();
  const data = result?.data;
  const pathname = `/${locale}/dashboard/support/${id}`;
  if (data && data.messages.page !== state.page) {
    redirect(
      buildTicketPageHref(
        pathname,
        rawSearchParams,
        data.messages.page,
        "message"
      )
    );
  }

  if (!data) {
    return (
      <section
        aria-live="assertive"
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center"
        role="alert"
      >
        <h2 className="font-serif text-xl font-medium">
          {locale === "zh"
            ? "工单消息加载失败"
            : "Ticket messages could not be loaded"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {locale === "zh"
            ? "请稍后重试，当前页面不会被标记为已读。"
            : "Try again later. This ticket has not been marked as read."}
        </p>
        <Link
          className="mt-4 inline-block text-sm font-medium underline"
          href={pathname}
        >
          {locale === "zh" ? "重试" : "Retry"}
        </Link>
      </section>
    );
  }

  const ticketData = data.ticket;
  const ticketUser = data.ticketUser;
  const messages = data.messages;
  const statusConfig = ticketStatuses.find(
    (item) => item.value === ticketData.status
  );
  const priorityConfig = ticketPriorities.find(
    (item) => item.value === ticketData.priority
  );
  const categoryConfig = ticketCategories.find(
    (item) => item.value === ticketData.category
  );
  const isClosed = ticketData.status === "closed";

  return (
    <div className="space-y-6">
      <MarkTicketSeen ticketId={id} />
      <div className="flex items-center gap-4">
        <Link href={`/${locale}/dashboard/support`}>
          <Button size="icon" variant="ghost">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h2 className="font-serif text-2xl font-medium tracking-tight">
            {ticketData.subject}
          </h2>
          <p className="text-sm text-muted-foreground">
            {categoryConfig?.label || ticketData.category} ·{" "}
            {locale === "zh" ? "创建于" : "Created"}{" "}
            {formatDateInTimeZone(
              ticketData.createdAt,
              locale,
              { year: "numeric", month: "2-digit", day: "2-digit" },
              timeZone
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            className={`text-[10px] uppercase tracking-wider ${ticketData.priority === "high" ? "border-destructive/40 text-destructive" : "text-muted-foreground"}`}
            variant="outline"
          >
            {priorityConfig?.label || ticketData.priority}
          </Badge>
          <Badge
            className={`text-[10px] uppercase tracking-wider ${ticketData.status === "in_progress" ? "border-transparent bg-foreground text-background" : "text-muted-foreground"}`}
            variant="outline"
          >
            {statusConfig?.label || ticketData.status}
          </Badge>
        </div>
      </div>

      {isAdmin ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-xs font-medium uppercase tracking-[1.2px] text-muted-foreground">
                {locale === "zh" ? "用户信息" : "User"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <Avatar className="h-12 w-12">
                  <AvatarImage
                    src={ticketUser?.image || undefined}
                    alt={ticketUser?.name || "User"}
                  />
                  <AvatarFallback className="bg-foreground text-background">
                    {ticketUser?.name ? getInitials(ticketUser.name) : "U"}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">
                    {ticketUser?.name ||
                      (locale === "zh" ? "未知用户" : "Unknown user")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {ticketUser?.email}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-xs font-medium uppercase tracking-[1.2px] text-muted-foreground">
                {locale === "zh" ? "工单状态" : "Ticket status"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <AdminTicketStatusSelect
                ticketId={ticketData.id}
                currentStatus={ticketData.status}
              />
            </CardContent>
          </Card>
        </div>
      ) : null}

      <section aria-labelledby="ticket-messages-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/60 pb-2">
          <div>
            <h3
              className="text-xs font-medium uppercase tracking-[1.2px] text-muted-foreground"
              id="ticket-messages-heading"
              tabIndex={-1}
            >
              {locale === "zh" ? "对话记录" : "Conversation"}
            </h3>
            <p
              aria-live="polite"
              className="mt-1 text-xs text-muted-foreground"
            >
              {locale === "zh"
                ? `共 ${messages.totalCount} 条消息`
                : `${messages.totalCount} messages`}
            </p>
          </div>
          <UrlPageSizeSelect
            itemSuffix={locale === "zh" ? " 条/页" : " / page"}
            label={locale === "zh" ? "每页消息数" : "Messages per page"}
            options={[10, 20, 50].map((pageSize) => ({
              size: pageSize,
              href: buildTicketPageSizeHref(
                pathname,
                rawSearchParams,
                pageSize,
                "message"
              ),
            }))}
            value={messages.pageSize}
          />
        </div>
        <div className="space-y-4">
          {messages.records.map((message, index) => (
            <div
              className={`flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none ${message.isAdminResponse ? "" : "flex-row-reverse"}`}
              key={message.id}
              style={{
                animationDelay: `${Math.min(index, 8) * 50}ms`,
                animationFillMode: "backwards",
              }}
            >
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarImage
                  src={message.user?.image || undefined}
                  alt={message.user?.name || "User"}
                />
                <AvatarFallback className="bg-foreground text-xs text-background">
                  {message.user?.name ? getInitials(message.user.name) : "U"}
                </AvatarFallback>
              </Avatar>
              <div
                className={`flex max-w-[85%] flex-col gap-1 sm:max-w-[70%] ${message.isAdminResponse ? "items-start" : "items-end"}`}
              >
                <div className="flex items-center gap-2 px-1">
                  <span className="text-xs font-medium">
                    {message.user?.name || "User"}
                  </span>
                  {message.isAdminResponse ? (
                    <Badge
                      className="text-[10px] uppercase tracking-wider text-muted-foreground"
                      variant="outline"
                    >
                      {locale === "zh" ? "客服" : "Support"}
                    </Badge>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {formatDateInTimeZone(
                      message.createdAt,
                      locale,
                      {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      },
                      timeZone
                    )}
                  </span>
                </div>
                <div
                  className={
                    message.isAdminResponse
                      ? "rounded-lg border border-border bg-background px-4 py-3"
                      : "rounded-lg rounded-br-[5px] bg-secondary px-4 py-3"
                  }
                >
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {message.content}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
        <UrlPaginationControls
          ariaLabel={locale === "zh" ? "消息分页" : "Message pagination"}
          className="justify-end"
          focusTargetId="ticket-messages-heading"
          getPageLabel={(page, current) =>
            locale === "zh"
              ? current
                ? `当前第 ${page} 页`
                : `前往第 ${page} 页`
              : current
                ? `Current page ${page}`
                : `Go to page ${page}`
          }
          names={MESSAGE_PAGINATION_NAMES}
          nextLabel={locale === "zh" ? "下一页" : "Next"}
          page={messages.page}
          pageSelectLabel={
            locale === "zh" ? "选择消息页" : "Select message page"
          }
          previousLabel={locale === "zh" ? "上一页" : "Previous"}
          totalPages={messages.totalPages}
        />
      </section>

      {isAdmin ? (
        <AdminTicketReplyForm ticketId={id} isClosed={isClosed} />
      ) : isClosed ? (
        <Card className="border-dashed">
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            {locale === "zh"
              ? "此工单已关闭，无法添加新消息"
              : "This ticket is closed and cannot receive new messages."}
          </CardContent>
        </Card>
      ) : (
        <TicketMessageForm ticketId={id} />
      )}
    </div>
  );
}
