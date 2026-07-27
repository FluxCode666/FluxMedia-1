"use client";

/**
 * 管理端充值订单列表容器。
 *
 * 使用方：订单管理 Server Component。负责筛选控件、只读表格和签名 cursor 导航；
 * 数据权限、查询条件与财务字段白名单均由 UOL 及仓储保证。
 */
import type { AdminPaymentOrder } from "@repo/shared/payment/admin-contract";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { cn } from "@repo/ui/utils";
import {
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ReceiptText,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Link } from "@/i18n/routing";

import { formatPaymentAmount } from "./admin-payment-format";
import {
  type AdminPaymentOrderQueryState,
  buildAdminPaymentOrdersHref,
  hasAdminPaymentOrderFilters,
} from "./admin-payment-query";
import { PaymentOrderFilters } from "./payment-order-filters";

type PaymentOrderManagementProps = {
  initialUserOptions: Array<{ id: string; email: string }>;
  nextCursor: string | null;
  previousCursor: string | null;
  records: AdminPaymentOrder[];
  state: AdminPaymentOrderQueryState;
  timeZone: string;
};

/** 返回持久支付状态对应的语义徽标样式。 */
function getStatusClassName(status: AdminPaymentOrder["status"]): string {
  if (status === "fulfilled") return "bg-success/10 text-success";
  if (status === "failed") return "bg-destructive/10 text-destructive";
  if (status === "fulfilling") return "bg-warning/10 text-warning";
  return "bg-muted text-muted-foreground";
}

/** 在部署报告时区格式化完整日期，异常值回退原字符串。 */
function formatOrderDate(
  value: string | null,
  locale: string,
  timeZone: string
): string {
  if (!value) return "—";
  try {
    return formatDateInTimeZone(
      value,
      locale,
      {
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
        year: "numeric",
      },
      timeZone
    );
  } catch {
    return value;
  }
}

/** 渲染响应式订单表、空状态与双向 keyset 分页。 */
export function PaymentOrderManagement({
  initialUserOptions,
  nextCursor,
  previousCursor,
  records,
  state,
  timeZone,
}: PaymentOrderManagementProps) {
  const locale = useLocale();
  const t = useTranslations("AdminPayments.orders");

  return (
    <div className="space-y-4">
      <PaymentOrderFilters
        initialUserOptions={initialUserOptions}
        state={state}
      />

      {records.length === 0 ? (
        <section className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-20 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-muted">
            <ReceiptText
              className="size-6 text-muted-foreground"
              strokeWidth={1.4}
            />
          </div>
          <h2 className="mt-5 font-serif text-lg font-medium">
            {hasAdminPaymentOrderFilters(state)
              ? t("noMatchingOrders")
              : t("noOrders")}
          </h2>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            {hasAdminPaymentOrderFilters(state)
              ? t("noMatchingOrdersDescription")
              : t("noOrdersDescription")}
          </p>
        </section>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] border-collapse text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                  <th className="px-4 py-3 font-medium">{t("order")}</th>
                  <th className="px-4 py-3 font-medium">{t("user")}</th>
                  <th className="px-4 py-3 font-medium">{t("channel")}</th>
                  <th className="px-4 py-3 font-medium">{t("amount")}</th>
                  <th className="px-4 py-3 font-medium">{t("credits")}</th>
                  <th className="px-4 py-3 font-medium">{t("status")}</th>
                  <th className="px-4 py-3 font-medium">{t("createdAt")}</th>
                  <th className="px-4 py-3 font-medium">{t("fulfilledAt")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {records.map((order) => (
                  <tr
                    className="transition-colors hover:bg-muted/40"
                    key={order.id}
                  >
                    <td className="max-w-[240px] px-4 py-3 align-top">
                      <p
                        className="truncate font-mono text-xs font-medium"
                        title={order.id}
                      >
                        {order.id}
                      </p>
                      <p
                        className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                        title={order.providerTradeNo ?? undefined}
                      >
                        {order.providerTradeNo ?? t("noTradeNumber")}
                      </p>
                    </td>
                    <td className="max-w-[230px] px-4 py-3 align-top">
                      <p className="truncate" title={order.userEmail}>
                        {order.userEmail}
                      </p>
                      <p
                        className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                        title={order.userId}
                      >
                        {order.userId}
                      </p>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <p>{t(`providerLabels.${order.provider}`)}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {t(`purposeLabels.${order.purpose}`)}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 align-top font-medium tabular-nums">
                      <span className="inline-flex items-center gap-1.5">
                        <CircleDollarSign className="size-3.5 text-muted-foreground" />
                        {formatPaymentAmount(
                          order.amountMinor,
                          order.currency,
                          locale
                        )}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 align-top tabular-nums">
                      {order.creditsAmount.toLocaleString(locale)}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <Badge
                        className={cn(
                          "border-0 font-normal",
                          getStatusClassName(order.status)
                        )}
                        variant="secondary"
                      >
                        {t(`statusLabels.${order.status}`)}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 align-top text-xs text-muted-foreground">
                      {formatOrderDate(order.createdAt, locale, timeZone)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 align-top text-xs text-muted-foreground">
                      {formatOrderDate(order.fulfilledAt, locale, timeZone)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {records.length > 0 ? (
        <nav
          aria-label={t("pagination")}
          className="flex items-center justify-between gap-3"
        >
          <Button
            asChild={Boolean(previousCursor)}
            disabled={!previousCursor}
            variant="outline"
          >
            {previousCursor ? (
              <Link
                href={buildAdminPaymentOrdersHref({
                  ...state,
                  cursor: previousCursor,
                })}
              >
                <ChevronLeft />
                {t("previousPage")}
              </Link>
            ) : (
              <span>
                <ChevronLeft />
                {t("previousPage")}
              </span>
            )}
          </Button>
          <p className="text-xs text-muted-foreground">{t("pageHint")}</p>
          <Button
            asChild={Boolean(nextCursor)}
            disabled={!nextCursor}
            variant="outline"
          >
            {nextCursor ? (
              <Link
                href={buildAdminPaymentOrdersHref({
                  ...state,
                  cursor: nextCursor,
                })}
              >
                {t("nextPage")}
                <ChevronRight />
              </Link>
            ) : (
              <span>
                {t("nextPage")}
                <ChevronRight />
              </span>
            )}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
