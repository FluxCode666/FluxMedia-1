/**
 * 钱包最近充值订单列表。
 *
 * 使用方：用户钱包页。只消费本人 UOL 返回的安全订单摘要；每行链接到统一支付
 * 结果页，支付状态仍以服务端查询为准。
 */

import { amountMinorToMajor } from "@repo/shared/credits/top-up";
import type {
  UserPaymentOrder,
  UserPaymentOrderListOutput,
} from "@repo/shared/payment/user-order-contract";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { Badge } from "@repo/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { cn } from "@repo/ui/utils";
import { ArrowUpRight, ReceiptText } from "lucide-react";

import { Link } from "@/i18n/routing";

import type { WalletDataSection } from "../wallet-page-data";
import type { WalletCopy } from "./wallet-copy";

type WalletRecentOrdersProps = {
  copy: WalletCopy;
  locale: string;
  recentOrders: WalletDataSection<UserPaymentOrderListOutput>;
};

/** 返回用户态订单状态对应的徽标样式。 */
function getStatusClassName(status: UserPaymentOrder["status"]): string {
  if (status === "fulfilled") return "bg-success/10 text-success";
  if (status === "failed") return "bg-destructive/10 text-destructive";
  if (status === "payment_confirmed") return "bg-warning/10 text-warning";
  if (status === "expired") return "bg-muted text-muted-foreground";
  return "bg-primary/10 text-primary";
}

/** 格式化最小货币单位，异常币种回退为可读的数值文本。 */
function formatOrderAmount(
  amountMinor: number,
  currency: string,
  locale: string
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 3,
    }).format(amountMinorToMajor(amountMinor, currency));
  } catch {
    return `${currency} ${amountMinorToMajor(
      amountMinor,
      currency
    ).toLocaleString(locale)}`;
  }
}

/** 格式化订单创建时间，异常时间回退原始值。 */
function formatOrderDate(
  value: string,
  locale: string,
  timeZone: string
): string {
  const formatted = formatDateInTimeZone(
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
  return formatted || value;
}

/** 渲染最近订单区块，明确区分加载失败、空列表和实际记录。 */
export function WalletRecentOrders({
  copy,
  locale,
  recentOrders,
}: WalletRecentOrdersProps) {
  return (
    <section aria-labelledby="wallet-recent-orders-title">
      <Card>
        <CardHeader className="border-b">
          <CardTitle
            className="font-serif text-xl font-medium"
            id="wallet-recent-orders-title"
          >
            {copy.recentOrdersTitle}
          </CardTitle>
          <CardDescription>{copy.recentOrdersDescription}</CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6">
          {recentOrders.status === "error" ? (
            <p
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
              role="alert"
            >
              {copy.recentOrdersError}
            </p>
          ) : recentOrders.data.records.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-5 py-12 text-center">
              <div className="flex size-11 items-center justify-center rounded-full bg-muted">
                <ReceiptText
                  className="size-5 text-muted-foreground"
                  strokeWidth={1.5}
                />
              </div>
              <p className="mt-4 text-sm text-muted-foreground">
                {copy.recentOrdersEmpty}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {recentOrders.data.records.map((order) => (
                <OrderRow
                  copy={copy}
                  key={order.id}
                  locale={locale}
                  order={order}
                  timeZone={recentOrders.data.timeZone}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** 渲染一条响应式订单摘要，在窄屏下保持关键金额与状态可见。 */
function OrderRow({
  copy,
  locale,
  order,
  timeZone,
}: {
  copy: WalletCopy;
  locale: string;
  order: UserPaymentOrder;
  timeZone: string;
}) {
  return (
    <Link
      className="group block rounded-lg border p-4 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href={`/dashboard/credits/payment/${encodeURIComponent(order.id)}`}
      title={copy.viewOrder}
    >
      <div className="flex flex-col gap-4 sm:grid sm:grid-cols-[minmax(0,1.4fr)_minmax(7rem,0.8fr)_minmax(7rem,0.8fr)_auto] sm:items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p
              className="truncate font-mono text-xs font-medium"
              title={order.id}
            >
              {order.id}
            </p>
            <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{formatOrderDate(order.createdAt, locale, timeZone)}</span>
            <span>
              {order.purpose === "credit_top_up"
                ? copy.topUpOrder
                : copy.packageOrder}
            </span>
            <span>
              {copy.provider}: {copy.providerLabels[order.provider]}
            </span>
          </div>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{copy.orderCredits}</p>
          <p className="mt-1 font-medium tabular-nums">
            {order.creditsAmount.toLocaleString(locale)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{copy.orderAmount}</p>
          <p className="mt-1 font-medium tabular-nums">
            {formatOrderAmount(order.amountMinor, order.currency, locale)}
          </p>
        </div>
        <Badge
          className={cn(
            "border-0 font-normal sm:justify-self-end",
            getStatusClassName(order.status)
          )}
          variant="secondary"
        >
          {copy.orderStatus[order.status]}
        </Badge>
      </div>
    </Link>
  );
}
