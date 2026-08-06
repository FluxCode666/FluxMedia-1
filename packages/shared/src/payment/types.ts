/**
 * 一次性支付的传输无关类型。
 *
 * 使用方：充值结账适配器和支付订单服务。历史周期账本由数据库历史读模型独立读取，
 * 不通过支付配置类型传播。
 */

/** 支付订单类型；当前业务只允许一次性充值。 */
export enum PaymentType {
  ONE_TIME = "one-time",
}

/** 一次性商品报价。 */
export interface PriceConfig {
  type: PaymentType.ONE_TIME;
  priceId: string;
  amount: number;
  currency?: string;
}

/** 创建一次性结账会话的参数。 */
export interface CreateCheckoutParams {
  priceId: string;
  type?: PaymentType.ONE_TIME;
  successUrl?: string;
  cancelUrl?: string;
  requestId?: string;
}
