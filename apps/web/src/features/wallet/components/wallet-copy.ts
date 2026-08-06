/** 钱包页面的中英文文案契约，由服务端按 locale 生成后传给交互组件。 */

export type WalletCopy = ReturnType<typeof createWalletCopy>;

/** 按当前语言创建钱包可见文案；不读取运行时配置或用户数据。 */
export function createWalletCopy(isZh: boolean) {
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  return {
    title: copy("Wallet", "钱包"),
    description: copy(
      "Review your credit balance and add credits as needed.",
      "查看积分资产，并按需补充积分。"
    ),
    balance: copy("Current balance", "当前余额"),
    netSpent: copy("Total consumed", "总消耗"),
    overviewError: copy(
      "Balance information is temporarily unavailable. No value has been replaced with zero.",
      "余额信息暂时不可用，页面不会用 0 替代真实数据。"
    ),
    purchaseTitle: copy("Add credits", "补充积分"),
    purchaseDescription: copy(
      "Buy credits once and use them based on actual consumption.",
      "一次性购买积分，并按照实际用量消耗。"
    ),
    purchaseError: copy(
      "This purchase option could not be loaded. Please refresh and try again.",
      "该购买方式加载失败，请刷新后重试。"
    ),
    amount: copy("Amount", "充值金额"),
    creditsEstimate: copy("Estimated credits", "预计获得积分"),
    pay: copy("Continue to payment", "前往支付"),
    invalidAmount: copy(
      "Enter an amount within the allowed range.",
      "请输入允许范围内的金额。"
    ),
    topUpFailed: copy("Unable to create top-up order", "创建充值订单失败"),
    recentOrdersTitle: copy("Recent top-up orders", "最近充值订单"),
    recentOrdersDescription: copy(
      "Review your latest credit top-ups and payment status.",
      "查看最近的积分充值记录和支付状态。"
    ),
    recentOrdersError: copy(
      "Recent top-up orders are temporarily unavailable.",
      "最近充值订单暂时不可用。"
    ),
    recentOrdersEmpty: copy(
      "Your recent top-up orders will appear here.",
      "最近充值后，订单记录会显示在这里。"
    ),
    orderAmount: copy("Amount", "金额"),
    orderCredits: copy("Credits", "积分"),
    topUpOrder: copy("Pay as you go", "按量充值"),
    packageOrder: copy("Credit package", "积分包"),
    provider: copy("Provider", "支付渠道"),
    providerLabels: {
      alipay_f2f: copy("Alipay", "支付宝"),
      creem: "Creem",
      epay: copy("Epay", "易支付"),
    },
    orderStatus: {
      waiting_payment: copy("Waiting for payment", "待支付"),
      payment_confirmed: copy("Processing", "处理中"),
      fulfilled: copy("Completed", "已到账"),
      failed: copy("Failed", "失败"),
      expired: copy("Expired", "已过期"),
    },
    viewOrder: copy("View order", "查看订单"),
    unavailable: copy("Currently unavailable", "当前不可购买"),
    paymentNotice: {
      success: copy(
        "Payment completed. Your balance may take a moment to update.",
        "支付已完成，余额可能需要片刻更新。"
      ),
      processing: copy(
        "Payment confirmed and is being processed.",
        "支付已确认，正在处理中。"
      ),
      pending: copy("Payment is still pending.", "支付仍在等待确认。"),
      fail: copy(
        "Payment was not completed. No wallet change was made here.",
        "支付未完成，本页不会据此修改钱包资产。"
      ),
      canceled: copy("Payment was canceled.", "支付已取消。"),
    },
  };
}
