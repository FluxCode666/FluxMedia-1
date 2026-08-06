/**
 * 钱包页面。
 *
 * 使用方：用户侧独立资产与购买入口。页面通过单次本人 UOL 聚合读取余额、最近充值
 * 订单和一次性充值能力；不展示退款记录或价格趋势，也不在页面层处理支付履约。
 */
import { getServerSession } from "@repo/shared/auth/server";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { getMyWalletPageDataAction } from "@/features/wallet/actions";
import { createWalletCopy } from "@/features/wallet/components/wallet-copy";
import { WalletOverview } from "@/features/wallet/components/wallet-overview";
import { WalletPaymentNotice } from "@/features/wallet/components/wallet-payment-notice";
import { WalletPurchaseSection } from "@/features/wallet/components/wallet-purchase-section";
import { WalletRecentOrders } from "@/features/wallet/components/wallet-recent-orders";
import { isWalletPaymentResultStatus } from "@/features/wallet/redirects";
import type { WalletPageData } from "@/features/wallet/wallet-page-data";

export const metadata = {
  title: "Wallet | FluxMedia",
  description: "Review your credit balance and available purchase options.",
};

type WalletPageProps = {
  searchParams: Promise<{
    pay?: string;
    purchase?: string;
    success?: string;
  }>;
};

/** 当聚合 Action 在传输层失败时保留明确失败状态，禁止用空或零资产替代。 */
function createUnavailableWalletPageData(): WalletPageData {
  return {
    balance: { status: "error" },
    recentOrders: { status: "error" },
    topUp: { status: "error" },
  };
}

/** 渲染钱包资产和按能力条件显示的购买区。 */
export default async function WalletPage({ searchParams }: WalletPageProps) {
  const [session, locale, params] = await Promise.all([
    getServerSession(),
    getLocale(),
    searchParams,
  ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);

  const actionResult = await getMyWalletPageDataAction();
  const pageData = actionResult?.data ?? createUnavailableWalletPageData();
  const copy = createWalletCopy(locale === "zh");
  const paymentNotice = isWalletPaymentResultStatus(params.pay)
    ? params.pay
    : params.success === "true"
      ? "success"
      : null;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header>
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {copy.title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
      </header>

      {paymentNotice ? (
        <WalletPaymentNotice message={copy.paymentNotice[paymentNotice]} />
      ) : null}

      <WalletOverview balance={pageData.balance} copy={copy} />
      <WalletPurchaseSection
        copy={copy}
        locale={locale}
        topUp={pageData.topUp}
      />
      <WalletRecentOrders
        copy={copy}
        locale={locale}
        recentOrders={pageData.recentOrders}
      />
    </div>
  );
}
