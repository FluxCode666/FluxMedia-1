/**
 * 管理端支付概览页。
 *
 * 页面只解析自然月 URL、复查人工管理员角色并调用支付 UOL Action；收入定义、币种
 * 隔离、自然日补零和数据库查询全部位于统一接口层及其绑定中。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { canAccessAdminArea } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { formatDateInputInTimeZone } from "@repo/shared/time-zone";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { CalendarDays, CircleDollarSign, ReceiptText } from "lucide-react";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { getAdminPaymentOverviewAction } from "@/features/payment/admin/actions";
import { formatPaymentAmount } from "@/features/payment/admin/admin-payment-format";
import {
  type AdminPaymentSearchParams,
  buildAdminPaymentOverviewHref,
  parseAdminPaymentMonth,
} from "@/features/payment/admin/admin-payment-query";
import { PaymentMonthNavigator } from "@/features/payment/admin/payment-month-navigator";
import { PaymentOverviewChartLazy } from "@/features/payment/admin/payment-overview-chart-lazy";
import { Link } from "@/i18n/routing";

export const metadata = {
  title: "Payment overview | FluxMedia",
  description: "Review credit top-up revenue and created order volume.",
};

type AdminPaymentOverviewPageProps = {
  searchParams: Promise<AdminPaymentSearchParams>;
};

/** 渲染按部署时区自然月统计的充值支付概览。 */
export default async function AdminPaymentOverviewPage({
  searchParams,
}: AdminPaymentOverviewPageProps) {
  const [session, locale, rawSearchParams, t] = await Promise.all([
    getServerSession(),
    getLocale(),
    searchParams,
    getTranslations("AdminPayments.overview"),
  ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);
  const role = await getUserRoleById(session.user.id);
  if (!canAccessAdminArea(role)) redirect(`/${locale}/dashboard`);

  const requestedMonth = parseAdminPaymentMonth(rawSearchParams);
  const appTimeZone = getAppTimeZone();
  const maxMonth = formatDateInputInTimeZone(new Date(), appTimeZone).slice(
    0,
    7
  );
  const result = await getAdminPaymentOverviewAction({
    month: requestedMonth ?? undefined,
  });
  const overview = result?.data;
  const retryMonth = requestedMonth ?? maxMonth;

  return (
    <div className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {t("eyebrow")}
          </p>
          <h1 className="mt-2 font-serif text-2xl font-medium tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/dashboard/admin/payments/orders">
            <ReceiptText />
            {t("viewOrders")}
          </Link>
        </Button>
      </header>

      {overview ? (
        <>
          <section className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {t("reportMonth")}
              </p>
              <p className="mt-1 font-serif text-lg font-medium">
                {t("monthValue", { month: overview.month })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("timeZone", { timeZone: overview.timeZone })}
              </p>
            </div>
            <PaymentMonthNavigator maxMonth={maxMonth} month={overview.month} />
          </section>

          <section className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-sm font-medium">
                  {t("fulfilledRevenue")}
                </CardTitle>
                <CircleDollarSign className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                {overview.revenueTotals.length > 0 ? (
                  <div className="space-y-1.5">
                    {overview.revenueTotals.map((total) => (
                      <p
                        className="font-serif text-2xl font-medium tabular-nums"
                        key={total.currency}
                      >
                        {formatPaymentAmount(
                          total.amountMinor,
                          total.currency,
                          locale
                        )}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="font-serif text-2xl font-medium">—</p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("fulfilledRevenueHint")}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-sm font-medium">
                  {t("rechargeOrders")}
                </CardTitle>
                <ReceiptText className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <p className="font-serif text-2xl font-medium tabular-nums">
                  {overview.rechargeOrderCount.toLocaleString(locale)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("rechargeOrdersHint")}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-sm font-medium">
                  {t("activeDays")}
                </CardTitle>
                <CalendarDays className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <p className="font-serif text-2xl font-medium tabular-nums">
                  {overview.revenueDayCount.toLocaleString(locale)}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("activeDaysHint", { days: overview.daily.length })}
                </p>
              </CardContent>
            </Card>
          </section>

          <Card className="overflow-hidden">
            <CardHeader className="border-b">
              <CardTitle className="font-serif text-lg font-medium tracking-tight">
                {t("chartTitle")}
              </CardTitle>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("chartDescription")}
              </p>
            </CardHeader>
            <CardContent className="pt-6">
              <PaymentOverviewChartLazy overview={overview} />
            </CardContent>
          </Card>

          <p className="rounded-lg border border-dashed px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            {t("scopeNote")}
          </p>
        </>
      ) : (
        <section
          aria-live="assertive"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center"
          role="alert"
        >
          <h2 className="font-serif text-xl font-medium">{t("loadError")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("loadErrorDescription")}
          </p>
          <Button asChild className="mt-4" variant="outline">
            <Link href={buildAdminPaymentOverviewHref(retryMonth)}>
              {t("retry")}
            </Link>
          </Button>
        </section>
      )}
    </div>
  );
}
