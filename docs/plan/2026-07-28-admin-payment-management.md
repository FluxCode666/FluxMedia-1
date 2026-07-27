# 管理端支付概览与充值订单管理

- 文档日期：2026-07-28
- 状态：已实现
- 页面：`/dashboard/admin/payments`、`/dashboard/admin/payments/orders`

## 范围

本模块管理统一支付订单上线后的积分充值记录，只包含 `payment_order` 中：

- `purpose = credit_top_up` 的按金额充值；
- `purpose = credit_package` 的积分套餐购买。

不包含订阅收入、渠道手续费、拒付、退款净额，也不回填统一支付订单上线前只存在于
`epay_order`、积分批次或第三方平台中的历史记录。因此页面文案使用“已履约充值收入”，
不使用“全站总收入”或“渠道净结算收入”。

## 统计口径

- 收入只统计 `status = fulfilled` 且 `fulfilled_at` 非空的订单；充值订单数量统计全部支付状态。
- 自然日与日期范围边界固定使用部署级 `APP_TIME_ZONE`，不同管理员看到相同报表边界。
- 收入按 `fulfilled_at` 归属自然日，充值订单数量按 `created_at` 归属自然日。
- 金额始终以 `amount_minor` 最小货币单位整数跨接口传递与累加。
- 不同币种分别汇总和绘线，禁止把 CNY、USD 等金额直接相加。
- 支持选择包含首尾日期的任意范围，单次最多 366 天；默认选择当前完整自然月。
- 开始日期不能晚于报告时区中的今天，结束日期不能超过当前自然月最后一天；尚未发生的日期补零但不会读取未来时间戳。

## 统一接口层

三个操作均为 `payment` 域、`admin/super_admin`、`human-only`、只读自然幂等：

| Operation | 说明 |
| --- | --- |
| `payment.getAdminOverview` | 读取日期范围内每日已履约收入与全部充值订单数量 |
| `payment.listAdminOrders` | 按邮箱、订单号、状态读取签名 keyset 订单列表 |
| `payment.searchAdminOrderUsers` | 服务端搜索存在充值订单的用户邮箱 |

Server Action 只负责输入解析、构造管理员 Principal 与 `invokeOperation` 调用。报表时区、
连续日期、cursor 签名与数据库查询位于 UOL binding 和支付应用服务中。

## 分页与查询

- 列表排序固定为 `(created_at DESC, id DESC)`。
- cursor 使用 HMAC 绑定管理员 ID、筛选条件、快照 `asOf` 与完整排序键。
- 订单号按本地 `payment_order.id` 精确查询；第三方交易号仅展示，不参与本次筛选。
- 用户邮箱下拉调用独立搜索 operation，250ms 去抖并限制最多返回 20 项。
- 页面不返回 `provider_payload`、`pricing_snapshot` 或 `client_request_id`。

## 数据库索引

迁移 `0067_admin_payment_order_indexes.sql` 增加：

- 全局创建时间 keyset 索引；
- 状态与创建时间复合索引；
- 已履约充值订单 `fulfilled_at` 部分索引。

## 验证

- DB-free 服务测试覆盖日期范围时区、DST、未来查询截断、多币种补零、收入/订单独立
  口径、重复聚合拒绝、cursor 前后页、篡改与跨筛选拒绝。
- UOL 契约测试覆盖人工管理员权限、只读/自然幂等和伪造身份字段拒绝。
- URL 查询测试覆盖起止日期、范围上限、邮箱、订单号、状态与 cursor 白名单。
