/** 钱包购买区：只展示一次性积分充值，不承载支付履约状态机。 */
"use client";

import type { WalletTopUpOptions } from "@repo/shared/credits/wallet-contract";

import { TopUpPurchasePanel } from "@/features/payment/components/top-up-purchase-panel";
import type { WalletDataSection } from "../wallet-page-data";
import type { WalletCopy } from "./wallet-copy";

type WalletPurchaseSectionProps = {
  copy: WalletCopy;
  locale: string;
  topUp: WalletDataSection<WalletTopUpOptions>;
};

/** 根据一次性充值能力渲染购买内容；确认关闭时隐藏，读取失败时显式报错。 */
export function WalletPurchaseSection({
  copy,
  locale,
  topUp,
}: WalletPurchaseSectionProps) {
  if (topUp.status === "ready" && !topUp.data.enabled) return null;

  return (
    <section aria-labelledby="wallet-purchase-title" className="space-y-5">
      <div>
        <h2
          className="font-serif text-xl font-medium"
          id="wallet-purchase-title"
        >
          {copy.purchaseTitle}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {copy.purchaseDescription}
        </p>
      </div>

      {topUp.status === "error" ? (
        <p
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          role="alert"
        >
          {copy.purchaseError}
        </p>
      ) : null}

      {topUp.status === "ready" ? (
        <TopUpPurchasePanel copy={copy} locale={locale} options={topUp.data} />
      ) : null}
    </section>
  );
}
