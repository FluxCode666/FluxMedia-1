/**
 * 运行时支付通道及产品能力策略。
 *
 * 使用方：运行时配置、Epay 适配器和一次性充值能力。
 * 这里只判断通道产品支持，不读取密钥或系统设置 readiness。
 */
export const RUNTIME_PAYMENT_PROVIDERS = [
  "creem",
  "epay",
  "alipay_f2f",
  "none",
] as const;

export type RuntimePaymentProvider = (typeof RUNTIME_PAYMENT_PROVIDERS)[number];
