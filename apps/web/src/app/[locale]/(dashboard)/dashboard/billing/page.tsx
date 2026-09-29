/**
 * 旧“账单与用量”兼容路由。
 *
 * 使用方：历史书签、旧导航和支付回跳。页面只鉴权并重定向到钱包或使用日志，
 * 不再加载账单、交易记录、价格趋势或任何支付履约逻辑。
 */
import { getServerSession } from "@repo/shared/auth/server";
import { redirect } from "@repo/shared/platform/navigation";
import { getLocale } from "@repo/shared/platform/intl";

import { resolveLegacyBillingRedirect } from "@/features/billing/billing-page-data";

type BillingPageProps = {
  searchParams: Promise<
    Record<string, string | string[] | undefined>
  >;
};

/** 鉴权后把旧入口迁移到职责单一的新页面，并保留安全支付展示参数。 */
export default async function BillingPage({ searchParams }: BillingPageProps) {
  const [session, locale, params] = await Promise.all([
    getServerSession(),
    getLocale(),
    searchParams,
  ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);
  redirect(`/${locale}${resolveLegacyBillingRedirect(params)}`);
}
