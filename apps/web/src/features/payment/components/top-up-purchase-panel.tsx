/**
 * 钱包按金额充值面板。
 *
 * 使用方：钱包购买区。组件复用现有带 clientRequestId 的充值 Action，快捷金额和
 * 手工输入最终都转换为最小货币单位；重复提交同一报价时复用同一幂等键。
 */
"use client";

import { amountMinorToMajor } from "@repo/shared/credits/top-up";
import type { WalletTopUpOptions } from "@repo/shared/credits/wallet-contract";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Loader2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { requestNavigationFeedback } from "@/features/navigation/navigation-feedback-event";
import { createCreditTopUpCheckoutAction } from "@/features/payment/credit-top-up-actions";
import type { WalletCopy } from "@/features/wallet/components/wallet-copy";
import { useRouter } from "@/i18n/routing";
import {
  formatTopUpInputAmount,
  getTopUpQuickAmounts,
  parseTopUpAmountMinor,
} from "./top-up-purchase-panel-logic";

type TopUpPurchasePanelProps = {
  copy: WalletCopy;
  locale: string;
  options: WalletTopUpOptions;
};

type PendingTopUpRequest = {
  clientRequestId: string;
  quoteKey: string;
};

/** 渲染快捷金额、手工输入与现有二维码充值入口。 */
export function TopUpPurchasePanel({
  copy,
  locale,
  options,
}: TopUpPurchasePanelProps) {
  const router = useRouter();
  const amountInputId = useId();
  const [currency, setCurrency] = useState(options.defaultCurrency);
  const selected =
    options.currencies.find((item) => item.currency === currency) ??
    options.currencies[0];
  const [amount, setAmount] = useState(
    selected
      ? formatTopUpInputAmount(
          getTopUpQuickAmounts(selected)[0] ?? selected.minAmountMinor,
          selected.currency
        )
      : ""
  );
  const requestRef = useRef<PendingTopUpRequest | null>(null);
  const amountMinor = selected
    ? parseTopUpAmountMinor(amount, selected.currency)
    : null;
  const isValid = Boolean(
    selected &&
      amountMinor &&
      amountMinor >= selected.minAmountMinor &&
      amountMinor <= selected.maxAmountMinor
  );
  const estimatedCredits =
    selected && amountMinor
      ? amountMinorToMajor(amountMinor, selected.currency) *
        selected.creditsPerMajorUnit
      : 0;
  const quickAmounts = useMemo(() => {
    if (!selected) return [];
    return getTopUpQuickAmounts(selected);
  }, [selected]);
  const { execute, isPending } = useAction(createCreditTopUpCheckoutAction, {
    onSuccess: ({ data }) => {
      if (data) {
        requestNavigationFeedback();
        router.push(`/dashboard/credits/payment/${data.orderId}`);
      }
    },
    onError: ({ error }) => {
      toast.error(error.serverError ?? copy.topUpFailed);
    },
  });

  /** 切换币种并把输入重置到该币种允许的首个快捷或最低金额。 */
  function changeCurrency(nextCurrency: string): void {
    const next = options.currencies.find(
      (item) => item.currency === nextCurrency
    );
    if (!next) return;
    setCurrency(next.currency);
    setAmount(
      formatTopUpInputAmount(
        getTopUpQuickAmounts(next)[0] ?? next.minAmountMinor,
        next.currency
      )
    );
    requestRef.current = null;
  }

  /** 复用同报价幂等键并调用现有充值 Action；校验失败只更新界面提示。 */
  function submitTopUp(): void {
    if (!selected || !amountMinor || !isValid) return;
    const quoteKey = `${selected.currency}:${amountMinor}`;
    const existing = requestRef.current;
    const clientRequestId =
      existing?.quoteKey === quoteKey
        ? existing.clientRequestId
        : crypto.randomUUID();
    requestRef.current = { clientRequestId, quoteKey };
    execute({
      amountMinor,
      clientRequestId,
      currency: selected.currency,
      provider: "alipay_f2f",
    });
  }

  if (!selected) return null;

  return (
    <div className="space-y-5 rounded-xl border bg-card p-5">
      {options.currencies.length > 1 ? (
        <label className="block space-y-2 text-sm font-medium">
          <span>{copy.amount}</span>
          <select
            className="h-10 w-full rounded-md border bg-background px-3"
            onChange={(event) => changeCurrency(event.target.value)}
            value={selected.currency}
          >
            {options.currencies.map((item) => (
              <option key={item.currency} value={item.currency}>
                {item.currency}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">{copy.amount}</legend>
        {quickAmounts.map((quickAmountMinor) => (
          <Button
            key={quickAmountMinor}
            onClick={() => {
              setAmount(
                formatTopUpInputAmount(quickAmountMinor, selected.currency)
              );
              requestRef.current = null;
            }}
            type="button"
            variant={amountMinor === quickAmountMinor ? "default" : "outline"}
          >
            {new Intl.NumberFormat(locale, {
              currency: selected.currency,
              style: "currency",
            }).format(amountMinorToMajor(quickAmountMinor, selected.currency))}
          </Button>
        ))}
      </fieldset>

      <label
        className="block space-y-2 text-sm font-medium"
        htmlFor={amountInputId}
      >
        <span>{copy.amount}</span>
        <Input
          aria-invalid={Boolean(amount) && !isValid}
          id={amountInputId}
          inputMode="decimal"
          onChange={(event) => {
            setAmount(event.target.value);
            requestRef.current = null;
          }}
          value={amount}
        />
      </label>
      {!isValid ? (
        <p className="text-sm text-destructive" role="alert">
          {copy.invalidAmount}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {copy.creditsEstimate}: {estimatedCredits.toLocaleString(locale)}
        </p>
      )}
      <Button
        className="w-full"
        disabled={!isValid || isPending}
        onClick={submitTopUp}
        type="button"
      >
        {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        {copy.pay}
      </Button>
    </div>
  );
}
