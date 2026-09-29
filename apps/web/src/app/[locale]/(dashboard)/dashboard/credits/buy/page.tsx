/**
 * 旧积分购买入口的兼容重定向页。
 *
 * 使用方：历史书签和尚未迁移的余额不足 CTA。购买能力已集中到钱包，本页不再
 * 挂载旧购买组件，也不触发订单或支付副作用。
 */
import { redirect } from "@repo/shared/platform/navigation";

type BuyCreditsPageProps = {
  params: Promise<{ locale: string }>;
};

/** 保留当前 locale，并把旧购买入口定位到钱包按量充值模块。 */
export default async function BuyCreditsPage({ params }: BuyCreditsPageProps) {
  const { locale } = await params;
  redirect(`/${locale}/dashboard/wallet?purchase=top-up`);
}
