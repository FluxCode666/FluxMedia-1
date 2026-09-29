/**
 * 钱包一次性支付结果提示。
 *
 * 使用方：钱包 Server Component。首次渲染保留回跳结果文案，挂载后
 * 只替换地址栏中的一次性参数，避免刷新或收藏后重复提示。
 */

import { useEffect } from "react";

import { removeWalletPaymentNoticeParams } from "./wallet-payment-notice-url";

type WalletPaymentNoticeProps = {
  message: string;
};

/**
 * 展示已通过服务端白名单解析的支付结果。
 *
 * @param props.message 本地化后的安全提示文案。
 * @returns 可被辅助技术感知的状态提示。
 * @sideEffects 挂载后通过 history.replaceState 清理 pay/success。
 */
export function WalletPaymentNotice({ message }: WalletPaymentNoticeProps) {
  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    const currentHref = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
    const nextHref = removeWalletPaymentNoticeParams(currentUrl);
    if (nextHref !== currentHref) {
      window.history.replaceState(window.history.state, "", nextHref);
    }
  }, []);

  return (
    <p
      aria-live="polite"
      className="rounded-xl border bg-muted/40 px-4 py-3 text-sm"
      role="status"
    >
      {message}
    </p>
  );
}
