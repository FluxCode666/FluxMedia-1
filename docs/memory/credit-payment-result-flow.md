# 统一积分支付结果流程

最后更新：2026-07-28

## 目标

积分到账只能由服务端已验签的 webhook 履约确认；浏览器从 Creem、易支付返回或用户刷新页面，均不可直接发放积分或显示“积分已到账”。

## 订单与状态

- 支付宝按金额充值继续使用 `payment_order`，`purpose=credit_top_up`。
- Creem 和易支付的积分套餐购买也会先创建 `payment_order`，`purpose=credit_package`；无需新增数据库迁移。
- 统一结果页：`/[locale]/dashboard/credits/payment/[orderId]`。
- 面向用户的状态：`waiting_payment`、`payment_confirmed`、`fulfilled`、`failed`、`expired`。
- `payment_confirmed` 对应服务端 `fulfilling`；只有 `fulfilled` 才允许显示积分到账和当前余额。
- `expiresAt` 仅控制界面重试提示。已验签通知即使延迟到达，也必须按订单快照继续履约，不能因前端显示过期而拒绝已付款订单。

## 通道约定

- 支付宝：购买页创建本地订单后直接进入结果页，结果页展示二维码并每 3 秒查询状态。
- 支付宝通知地址：后台只需填写协议加域名，运行时自动追加 `/api/webhooks/alipay`；已填写完整路径的旧配置保持兼容。允许 `http` 与 `https` 以兼容本地开发隧道，但生产环境应优先使用 HTTPS。
- 易支付：`epay_order.metadata.paymentOrderId` 关联本地订单；签名 return route 验签后重定向到统一结果页。易支付订单状态改为 `pending → fulfilling → success`，避免先显示成功后发积分。
- Creem：创建 Checkout 时将 `paymentOrderId` 放入 metadata，`success_url` 指向统一结果页。webhook 用该 ID 领取本地履约租约，随后用 `creem:<paymentOrderId>` 作为积分批次幂等键。

## 幂等与故障恢复

- 本地 `payment_order` 以 `(user_id, client_request_id)` 保证同一浏览器重试复用订单。
- webhook 以订单状态 CAS 和 5 分钟履约租约避免并发发放；积分账本继续以 `credits_batch(source_type, source_ref)` 作为最终幂等兜底。
- 临时履约错误会将订单释放回 `pending`，让上游 webhook 重试；金额校验等不可恢复失败可标记 `failed`。

## 接口

- UOL operation：`credits.getPaymentStatus`。
- 钱包最近充值订单 UOL operation：`payment.listMyRecentOrders`，默认读取最近 8 笔，
  最多 20 笔。
- Server Action：`getCreditPaymentStatusAction`。
- 查询必须按当前 `userId` 过滤，未命中统一返回“积分支付订单不存在”，防止 IDOR 枚举。
- 最近订单列表同样只从 Principal 派生 `userId`，仅返回本地订单号、通道、充值类型、
  用户态状态、金额、积分和时间，不返回渠道交易号或支付快照。
