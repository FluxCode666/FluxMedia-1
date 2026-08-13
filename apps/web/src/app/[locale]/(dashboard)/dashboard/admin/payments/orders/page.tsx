/**
 * 管理端充值订单管理页。
 *
 * 页面解析公开筛选、复查人工管理员角色，并并行调用订单列表与用户邮箱搜索 UOL
 * Action；全局数据作用域、精确订单号、状态筛选和 cursor 绑定都在统一接口层完成。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { canAccessAdminArea } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { formatDateInputInTimeZone } from "@repo/shared/time-zone";
import { getAppTimeZone } from "@repo/shared/time-zone/server";
import { Button } from "@repo/ui/components/button";
import { ChartNoAxesCombined } from "lucide-react";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { loadPaginationConfig } from "@/features/pagination/server";
import {
  listAdminPaymentOrdersAction,
  searchAdminPaymentOrderUsersAction,
} from "@/features/payment/admin/actions";
import {
  type AdminPaymentSearchParams,
  buildAdminPaymentOrdersHref,
  parseAdminPaymentOrderQuery,
} from "@/features/payment/admin/admin-payment-query";
import { PaymentOrderFilters } from "@/features/payment/admin/payment-order-filters";
import { PaymentOrderManagement } from "@/features/payment/admin/payment-order-management";
import { Link } from "@/i18n/routing";

export const metadata = {
  title: "Order management | FluxMedia",
  description: "Search and review credit top-up payment orders.",
};

type AdminPaymentOrdersPageProps = {
  searchParams: Promise<AdminPaymentSearchParams>;
};

/** 渲染全站充值订单筛选、列表和双向 keyset 分页。 */
export default async function AdminPaymentOrdersPage({
  searchParams,
}: AdminPaymentOrdersPageProps) {
  const [session, locale, rawSearchParams, t] = await Promise.all([
    getServerSession(),
    getLocale(),
    searchParams,
    getTranslations("AdminPayments.orders"),
  ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);
  const role = await getUserRoleById(session.user.id);
  if (!canAccessAdminArea(role)) redirect(`/${locale}/dashboard`);

  const paginationConfig = await loadPaginationConfig();
  const timeZone = getAppTimeZone();
  const today = formatDateInputInTimeZone(new Date(), timeZone);
  const state = parseAdminPaymentOrderQuery(
    rawSearchParams,
    today,
    paginationConfig
  );
  const [ordersResult, usersResult] = await Promise.allSettled([
    listAdminPaymentOrdersAction({
      cursor: state.cursor ?? undefined,
      endDate: state.endDate,
      page: state.page,
      pageSize: state.pageSize,
      orderId: state.orderId ?? undefined,
      startDate: state.startDate,
      status: state.status ?? undefined,
      userEmail: state.userEmail ?? undefined,
    }),
    searchAdminPaymentOrderUsersAction({
      query: state.userEmail ?? "",
      limit: 20,
    }),
  ]);
  const ordersActionResult =
    ordersResult.status === "fulfilled" ? ordersResult.value : null;
  const usersActionResult =
    usersResult.status === "fulfilled" ? usersResult.value : null;
  const orders = ordersActionResult?.data;
  const initialUserOptions = usersActionResult?.data?.users ?? [];

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
          <Link href="/dashboard/admin/payments">
            <ChartNoAxesCombined />
            {t("viewOverview")}
          </Link>
        </Button>
      </header>

      {orders ? (
        <PaymentOrderManagement
          initialUserOptions={initialUserOptions}
          nextCursor={orders.nextCursor}
          page={orders.page}
          pageSizeOptions={paginationConfig.pageSizeOptions}
          previousCursor={orders.previousCursor}
          records={orders.records}
          state={state}
          timeZone={timeZone}
          today={today}
          totalCount={orders.totalCount}
        />
      ) : (
        <div className="space-y-4">
          <PaymentOrderFilters
            initialUserOptions={initialUserOptions}
            state={state}
            today={today}
          />
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
              <Link
                href={buildAdminPaymentOrdersHref({ ...state, cursor: null })}
              >
                {t("retry")}
              </Link>
            </Button>
          </section>
        </div>
      )}
    </div>
  );
}
