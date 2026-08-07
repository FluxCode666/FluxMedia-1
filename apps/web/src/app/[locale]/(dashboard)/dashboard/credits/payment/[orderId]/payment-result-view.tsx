"use client";

/**
 * 统一积分支付结果视图。
 *
 * 使用方：积分购买流程的最终状态页。关键依赖：受保护的订单状态操作与积分余额
 * action。浏览器从第三方回跳、刷新或打开旧链接时都只查询本地订单；不会触发履约。
 */
import { getMyCreditsBalance } from "@repo/shared/credits/actions";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Separator } from "@repo/ui/components/separator";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import Image from "next/image";
import { useLocale } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";

import { getCreditPaymentStatusAction } from "@/features/payment/credit-top-up-actions";
import { Link, useRouter } from "@/i18n/routing";

type CreditPaymentStatus = {
  orderId: string;
  provider: "alipay_f2f" | "epay" | "creem";
  status:
    | "waiting_payment"
    | "payment_confirmed"
    | "fulfilled"
    | "failed"
    | "expired";
  currency: string;
  amount: number;
  creditsAmount: number;
  qrCode: string | null;
  expiresAt: string | null;
  fulfilledAt: string | null;
};

type CreditPaymentResultViewProps = {
  orderId: string;
};

/** 将订单金额格式化为当前语言对应的货币展示。 */
function formatCurrency(amount: number, currency: string, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(amount);
}

/** 根据支付通道返回用户可识别的名称。 */
function getProviderName(
  provider: CreditPaymentStatus["provider"],
  isZh: boolean
) {
  if (provider === "alipay_f2f") return "支付宝当面付";
  if (provider === "epay") return isZh ? "易支付" : "Epay";
  return "Creem";
}

/** 映射服务端状态为可访问的界面文案和颜色。 */
function getStatusPresentation(
  status: CreditPaymentStatus["status"],
  isZh: boolean
) {
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  switch (status) {
    case "fulfilled":
      return {
        label: copy("Credits delivered", "积分已到账"),
        title: copy("Payment complete", "支付完成"),
        description: copy(
          "The server has confirmed your payment and added the credits to your account.",
          "服务端已确认支付，并已将积分发放到你的账户。"
        ),
        icon: CheckCircle2,
      };
    case "payment_confirmed":
      return {
        label: copy("Payment confirmed", "支付已确认"),
        title: copy("Issuing credits", "正在发放积分"),
        description: copy(
          "Your payment is confirmed. Please keep this page open while credits are issued.",
          "支付已确认，正在发放积分。请保留此页面，系统会自动更新结果。"
        ),
        icon: Loader2,
      };
    case "failed":
      return {
        label: copy("Payment not completed", "支付未完成"),
        title: copy("This payment could not be completed", "该笔支付未能完成"),
        description: copy(
          "No credits were added. Please start a new purchase if you still need credits.",
          "本次没有发放积分。如仍需购买，请重新发起支付。"
        ),
        icon: AlertCircle,
      };
    case "expired":
      return {
        label: copy("Order expired", "订单已过期"),
        title: copy("Payment took too long", "支付等待时间过长"),
        description: copy(
          "No confirmed payment was received before this order expired. Please create a new order.",
          "该订单在等待期内未收到已确认的支付，请重新创建订单。"
        ),
        icon: Clock3,
      };
    default:
      return {
        label: copy("Waiting for payment", "等待支付"),
        title: copy("Complete your payment", "请完成支付"),
        description: copy(
          "After payment, this page will update automatically when the server confirms and issues credits.",
          "完成支付后，服务端确认并发放积分时，本页会自动更新。"
        ),
        icon: Clock3,
      };
  }
}

/**
 * 展示服务端支付状态并在未结束时轮询。
 *
 * 轮询仅用于读取订单；fulfilled、failed、expired 或组件卸载时立即停止，避免
 * 无限请求。超过两分钟仍未结束时给出明确说明和手动刷新入口。
 */
export function CreditPaymentResultView({
  orderId,
}: CreditPaymentResultViewProps) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const router = useRouter();
  const [payment, setPayment] = useState<CreditPaymentStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasLongWait, setHasLongWait] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const copy = useCallback(
    (en: string, zh: string) => (isZh ? zh : en),
    [isZh]
  );
  const { execute: fetchPayment, isPending: isRefreshing } = useAction(
    getCreditPaymentStatusAction,
    {
      onSuccess: ({ data }) => {
        if (data) {
          setPayment(data);
          setErrorMessage(null);
        }
      },
      onError: ({ error }) => {
        setErrorMessage(
          error.serverError ??
            copy("Unable to load this payment order", "无法读取该支付订单")
        );
      },
    }
  );
  const { execute: fetchBalance } = useAction(getMyCreditsBalance, {
    onSuccess: ({ data }) => {
      if (data) setBalance(data.balance);
    },
  });

  const refreshPayment = useCallback(() => {
    fetchPayment({ orderId });
  }, [fetchPayment, orderId]);

  useEffect(() => {
    refreshPayment();
  }, [refreshPayment]);

  useEffect(() => {
    if (
      payment?.status === "fulfilled" ||
      payment?.status === "failed" ||
      payment?.status === "expired"
    ) {
      return;
    }
    const timer = window.setInterval(refreshPayment, 3_000);
    return () => window.clearInterval(timer);
  }, [payment?.status, refreshPayment]);

  useEffect(() => {
    if (
      payment?.status !== "waiting_payment" &&
      payment?.status !== "payment_confirmed"
    ) {
      setHasLongWait(false);
      return;
    }
    const timer = window.setTimeout(() => setHasLongWait(true), 120_000);
    return () => window.clearTimeout(timer);
  }, [payment?.status]);

  useEffect(() => {
    if (payment?.status !== "fulfilled") return;
    fetchBalance();
    router.refresh();
  }, [fetchBalance, payment?.status, router]);

  useEffect(() => {
    if (!payment?.qrCode) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(payment.qrCode, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 256,
    })
      .then((value) => {
        if (!cancelled) setQrDataUrl(value);
      })
      .catch(() => {
        if (!cancelled) {
          setErrorMessage(
            copy("Unable to render the payment QR code", "无法生成支付二维码")
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [copy, payment?.qrCode]);

  const presentation = payment
    ? getStatusPresentation(payment.status, isZh)
    : getStatusPresentation("waiting_payment", isZh);
  const StatusIcon = presentation.icon;
  const isTerminal =
    payment?.status === "fulfilled" ||
    payment?.status === "failed" ||
    payment?.status === "expired";
  const shouldShowQr =
    payment?.provider === "alipay_f2f" &&
    payment?.status === "waiting_payment" &&
    qrDataUrl;

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="mb-5 gap-2 text-muted-foreground"
      >
        <Link href="/dashboard/wallet?purchase=top-up">
          <ArrowLeft className="h-4 w-4" />
          {copy("Back to buy credits", "返回购买积分")}
        </Link>
      </Button>

      <Card className="border-foreground/20 shadow-whisper">
        <CardHeader className="space-y-4 text-center">
          <div className="flex justify-center">
            <div className="rounded-full border border-border bg-muted/40 p-3">
              <StatusIcon
                className={`h-7 w-7 ${
                  payment?.status === "payment_confirmed" || !payment
                    ? "animate-spin"
                    : ""
                }`}
                aria-hidden="true"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Badge variant="secondary">{presentation.label}</Badge>
            <CardTitle className="font-serif text-2xl font-medium">
              {presentation.title}
            </CardTitle>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {presentation.description}
            </p>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {errorMessage && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {errorMessage}
            </p>
          )}

          {payment && (
            <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">
                  {copy("Payment channel", "支付渠道")}
                </span>
                <span className="font-medium">
                  {getProviderName(payment.provider, isZh)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">
                  {copy("Order amount", "订单金额")}
                </span>
                <span className="font-medium">
                  {formatCurrency(payment.amount, payment.currency, locale)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">
                  {copy("Credits", "获得积分")}
                </span>
                <span className="font-medium">
                  {payment.creditsAmount.toLocaleString(locale)} Credits
                </span>
              </div>
              {payment.status === "fulfilled" && balance !== null && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">
                    {copy("Current balance", "当前可用积分")}
                  </span>
                  <span className="font-medium">
                    {balance.toLocaleString(locale)} Credits
                  </span>
                </div>
              )}
            </div>
          )}

          {shouldShowQr && (
            <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-muted/30 p-4 text-center">
              <Image
                src={qrDataUrl}
                width={256}
                height={256}
                alt={copy("Alipay payment QR code", "支付宝支付二维码")}
                unoptimized
              />
              <p className="text-sm text-muted-foreground">
                {copy(
                  "Scan with Alipay, then return here to wait for confirmation.",
                  "请使用支付宝扫码付款，支付后留在此页等待服务端确认。"
                )}
              </p>
            </div>
          )}

          {hasLongWait && !isTerminal && (
            <p className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
              {copy(
                "Payment confirmation is taking longer than usual. If you have already paid, keep this page open and refresh the status. Do not pay the same order twice.",
                "支付确认时间较长。如已付款，请保留此页面并刷新状态，请勿对同一订单重复付款。"
              )}
            </p>
          )}
        </CardContent>

        <Separator />
        <CardFooter className="flex flex-col gap-3 pt-6 sm:flex-row">
          {!isTerminal && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={isRefreshing}
              onClick={refreshPayment}
            >
              {isRefreshing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {copy("I have paid, refresh status", "我已支付，刷新状态")}
            </Button>
          )}
          {payment?.status === "fulfilled" && (
            <>
              <Button asChild className="w-full">
                <Link href="/dashboard/generate">
                  {copy("Start creating", "立即创作")}
                </Link>
              </Button>
              <Button asChild variant="outline" className="w-full">
                <Link href="/dashboard/history">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  {copy("View usage records", "查看使用记录")}
                </Link>
              </Button>
            </>
          )}
          {(payment?.status === "failed" || payment?.status === "expired") && (
            <Button asChild className="w-full">
              <Link href="/dashboard/wallet?purchase=top-up">
                {copy("Buy credits again", "重新发起充值")}
              </Link>
            </Button>
          )}
        </CardFooter>
      </Card>
    </main>
  );
}
