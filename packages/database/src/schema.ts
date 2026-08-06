import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  json,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Better Auth 核心表 Schema
 *
 * 这些表是 Better Auth 认证系统所必需的核心表结构
 * 参考: https://www.better-auth.com/docs/concepts/database
 */

// ============================================
// 用户角色枚举
// ============================================

/**
 * 用户角色枚举
 */
export const userRoleEnum = pgEnum("user_role", [
  "user",
  "observer_admin",
  "admin",
  "super_admin",
]);

// ============================================
// 用户表 (User)
// ============================================
/**
 * 用户表 - 存储用户基本信息
 *
 * @field id - 用户唯一标识符
 * @field name - 用户显示名称
 * @field email - 用户邮箱 (唯一)
 * @field emailVerified - 邮箱是否已验证
 * @field image - 用户头像 URL
 * @field role - 用户角色 (user/observer_admin/admin/super_admin)
 * @field banned - 是否被封禁
 * @field bannedReason - 封禁原因
 * @field moderationBlockRiskLevelOverride - 仅管理员维护的审核级别覆盖；空值继承全站默认
 * @field imageGenerationConcurrencyOverride - 单用户生图并发覆盖；空值继承系统默认
 * @field timeZone - 用户展示时区；为空时继承部署环境 APP_TIME_ZONE
 * @field customerId - 支付提供商客户 ID (Creem)
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    role: userRoleEnum("role").notNull().default("user"),
    banned: boolean("banned").notNull().default(false),
    bannedReason: text("banned_reason"),
    moderationBlockRiskLevelOverride: text(
      "moderation_block_risk_level_override"
    ),
    imageGenerationConcurrencyOverride: integer(
      "image_generation_concurrency_override"
    ),
    timeZone: text("time_zone"),
    customerId: text("customer_id").unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "user_moderation_block_risk_level_override_check",
      sql`${table.moderationBlockRiskLevelOverride} IS NULL OR ${table.moderationBlockRiskLevelOverride} IN ('low', 'medium', 'high')`
    ),
    check(
      "user_image_generation_concurrency_override_check",
      sql`${table.imageGenerationConcurrencyOverride} IS NULL OR ${table.imageGenerationConcurrencyOverride} BETWEEN 1 AND 10000`
    ),
  ]
);

// ============================================
// 管理员操作审计日志 (Admin Audit Log)
// ============================================
/**
 * 管理员操作审计日志 - 记录高风险后台操作
 *
 * @field id - 记录唯一标识符
 * @field adminUserId - 执行操作的管理员用户 ID
 * @field targetUserId - 被操作的目标用户 ID（可为空，用于全局操作）
 * @field action - 操作类型
 * @field reason - 管理员填写的操作原因
 * @field before - 操作前快照
 * @field after - 操作后快照
 * @field metadata - 扩展元数据
 * @field createdAt - 创建时间
 */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: text("id").primaryKey(),
    adminUserId: text("admin_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    targetUserId: text("target_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    reason: text("reason"),
    before: json("before").$type<Record<string, unknown>>(),
    after: json("after").$type<Record<string, unknown>>(),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("admin_audit_log_action_created_at_idx").on(
      table.action,
      table.createdAt
    ),
    index("admin_audit_log_target_user_id_created_at_idx").on(
      table.targetUserId,
      table.createdAt
    ),
  ]
);

// ============================================
// 注册邮箱账本 (Registration Identity)
// ============================================
/**
 * 注册邮箱账本 - 永久记录已经注册过的邮箱
 *
 * 即使用户后续删除账号，也保留邮箱占位，防止重复注册领取新用户奖励。
 *
 * @field id - 记录唯一标识符
 * @field email - 规范化邮箱 (小写，唯一)
 * @field userId - 首次注册关联用户 ID (用户硬删后可为空)
 * @field firstRegisteredAt - 首次注册时间
 * @field lastSeenAt - 最近一次确认时间
 * @field deletedAt - 账号删除时间 (可为空)
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const registrationIdentity = pgTable("registration_identity", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  firstRegisteredAt: timestamp("first_registered_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// 会话表 (Session)
// ============================================
/**
 * 会话表 - 存储用户登录会话
 *
 * @field id - 会话唯一标识符
 * @field expiresAt - 会话过期时间
 * @field token - 会话令牌 (用于验证)
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 * @field ipAddress - 登录 IP 地址
 * @field userAgent - 用户代理 (浏览器信息)
 * @field userId - 关联的用户 ID
 */
export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

// ============================================
// 账户表 (Account)
// ============================================
/**
 * 账户表 - 存储 OAuth 提供商关联信息
 *
 * 当用户使用 GitHub、Google 等第三方登录时，
 * 此表存储该提供商的账户信息
 *
 * @field id - 账户唯一标识符
 * @field accountId - 提供商返回的账户 ID
 * @field providerId - 提供商标识符 (如 "github", "google")
 * @field userId - 关联的用户 ID
 * @field accessToken - 访问令牌
 * @field refreshToken - 刷新令牌
 * @field idToken - ID 令牌 (OpenID Connect)
 * @field accessTokenExpiresAt - 访问令牌过期时间
 * @field refreshTokenExpiresAt - 刷新令牌过期时间
 * @field scope - 授权范围
 * @field password - 密码哈希 (用于邮箱密码登录)
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// 验证表 (Verification)
// ============================================
/**
 * 验证表 - 存储邮箱验证和密码重置令牌
 *
 * @field id - 验证记录唯一标识符
 * @field identifier - 标识符 (通常是邮箱地址)
 * @field value - 验证值/令牌
 * @field expiresAt - 过期时间
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// 订阅表 (Subscription)
// ============================================
/**
 * 订阅表 - 存储用户的订阅信息
 *
 * @field id - 订阅记录唯一标识符
 * @field userId - 关联的用户 ID
 * @field subscriptionId - 支付提供商订阅 ID (唯一)
 * @field priceId - 支付提供商价格/产品 ID
 * @field status - 订阅状态 (active, canceled, past_due, etc.)
 * @field currentPeriodStart - 当前计费周期开始时间
 * @field currentPeriodEnd - 当前计费周期结束时间
 * @field cancelAtPeriodEnd - 是否在周期结束时取消
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const subscription = pgTable("subscription", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  subscriptionId: text("subscription_id").notNull().unique(),
  priceId: text("price_id").notNull(),
  status: text("status").notNull().default("incomplete"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// 类型导出
// ============================================
/**
 * 从 Schema 推断的类型
 * 用于在应用中保持类型安全
 */
export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

export type AdminAuditLog = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditLog = typeof adminAuditLog.$inferInsert;

export type RegistrationIdentity = typeof registrationIdentity.$inferSelect;
export type NewRegistrationIdentity = typeof registrationIdentity.$inferInsert;

export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;

export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;

export type Verification = typeof verification.$inferSelect;
export type NewVerification = typeof verification.$inferInsert;

export type Subscription = typeof subscription.$inferSelect;
export type NewSubscription = typeof subscription.$inferInsert;

// ============================================
// Epay 订单表
// ============================================
/**
 * 易支付订单表 - 本地保存业务元数据，避免把长 param 透传给支付网关。
 */
export const epayOrder = pgTable("epay_order", {
  outTradeNo: text("out_trade_no").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  businessType: text("business_type").notNull(),
  amount: numeric("amount", {
    precision: 12,
    scale: 2,
    mode: "number",
  }).notNull(),
  status: text("status").notNull().default("pending"),
  metadata: json("metadata").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type EpayOrder = typeof epayOrder.$inferSelect;
export type NewEpayOrder = typeof epayOrder.$inferInsert;

// ============================================
// 通用支付订单表
// ============================================
/**
 * 通用支付订单表。
 *
 * 使用方：按金额积分充值及后续支付渠道适配器。
 * WHY：订单在创建时固化金额、币种、兑换比例和积分数量，支付回调只使用快照，
 * 防止管理员在用户付款期间修改充值配置导致少发、多发或错误拒付。
 */
export const paymentOrder = pgTable(
  "payment_order",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientRequestId: text("client_request_id").notNull(),
    provider: text("provider").notNull(),
    purpose: text("purpose").notNull(),
    status: text("status").notNull().default("pending"),
    currency: text("currency").notNull(),
    amount: numeric("amount", {
      precision: 18,
      scale: 3,
      mode: "number",
    }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    creditsAmount: numeric("credits_amount", {
      precision: 18,
      scale: 2,
      mode: "number",
    }).notNull(),
    pricingSnapshot: json("pricing_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    providerPayload: json("provider_payload").$type<Record<string, unknown>>(),
    providerTradeNo: text("provider_trade_no"),
    expiresAt: timestamp("expires_at"),
    fulfilledAt: timestamp("fulfilled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("payment_order_user_client_request_unique").on(
      table.userId,
      table.clientRequestId
    ),
    uniqueIndex("payment_order_provider_trade_no_unique")
      .on(table.provider, table.providerTradeNo)
      .where(sql`${table.providerTradeNo} is not null`),
    index("payment_order_user_id_created_at_idx").on(
      table.userId,
      table.createdAt
    ),
    index("payment_order_status_idx").on(table.status),
    index("payment_order_admin_created_id_idx").on(
      table.createdAt.desc(),
      table.id.desc()
    ),
    index("payment_order_admin_status_created_id_idx").on(
      table.status,
      table.createdAt.desc(),
      table.id.desc()
    ),
    index("payment_order_admin_fulfilled_at_idx")
      .on(table.fulfilledAt.desc())
      .where(
        sql`${table.status} = 'fulfilled' and ${table.purpose} in ('credit_top_up', 'credit_package') and ${table.fulfilledAt} is not null`
      ),
  ]
);

export type PaymentOrder = typeof paymentOrder.$inferSelect;
export type NewPaymentOrder = typeof paymentOrder.$inferInsert;

// ============================================
// 积分系统枚举
// ============================================

/**
 * 积分账户状态枚举
 */
export const creditsBalanceStatusEnum = pgEnum("credits_balance_status", [
  "active",
  "frozen",
]);

/**
 * 积分批次状态枚举
 */
export const creditsBatchStatusEnum = pgEnum("credits_batch_status", [
  "active",
  "consumed",
  "expired",
]);

/**
 * 积分批次来源类型枚举
 */
export const creditsBatchSourceEnum = pgEnum("credits_batch_source", [
  "purchase",
  "subscription",
  "bonus",
  "refund",
]);

/**
 * 积分交易类型枚举
 */
export const creditsTransactionTypeEnum = pgEnum("credits_transaction_type", [
  "purchase",
  "consumption",
  "monthly_grant",
  "registration_bonus",
  "admin_grant",
  "expiration",
  "refund",
]);

/** 积分用量投影只接受消费与退款两种账本贡献。 */
export const creditUsageContributionKindEnum = pgEnum(
  "credit_usage_contribution_kind",
  ["consumption", "refund"]
);

// ============================================
// 积分余额表 (Credits Balances)
// ============================================
/**
 * 积分余额表 - 存储用户的积分账户信息
 *
 * 采用预计算余额模式，避免每次查询都需要聚合计算
 *
 * @field id - 记录唯一标识符
 * @field userId - 关联的用户 ID（唯一）
 * @field balance - 当前可用积分余额
 * @field totalEarned - 累计获得积分
 * @field totalSpent - 累计消费积分
 * @field totalRefunded - 累计已关联退回的消费积分
 * @field status - 账户状态（active/frozen）
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const creditsBalance = pgTable(
  "credits_balance",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    balance: numeric("balance", { precision: 18, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    totalEarned: numeric("total_earned", {
      precision: 18,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    totalSpent: numeric("total_spent", {
      precision: 18,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    totalRefunded: numeric("total_refunded", {
      precision: 18,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    status: creditsBalanceStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "credits_balance_total_refunded_nonnegative_check",
      sql`${table.totalRefunded} >= 0`
    ),
  ]
);

// ============================================
// 积分批次表 (Credits Batches)
// ============================================
/**
 * 积分批次表 - 积分库存管理
 *
 * 每次获得积分都会创建一个批次记录
 * 用于实现 FIFO (先进先出) 过期机制
 *
 * @field id - 批次唯一标识符
 * @field userId - 关联的用户 ID
 * @field amount - 原始积分数量
 * @field remaining - 剩余积分数量
 * @field issuedAt - 发放时间
 * @field expiresAt - 过期时间
 * @field status - 批次状态（active/consumed/expired）
 * @field sourceType - 来源类型（purchase/subscription/bonus/refund）
 * @field sourceRef - 来源引用（如订单ID、订阅ID等）
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const creditsBatch = pgTable(
  "credits_batch",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    amount: numeric("amount", {
      precision: 18,
      scale: 2,
      mode: "number",
    }).notNull(),
    remaining: numeric("remaining", {
      precision: 18,
      scale: 2,
      mode: "number",
    }).notNull(),
    issuedAt: timestamp("issued_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at"),
    status: creditsBatchStatusEnum("status").notNull().default("active"),
    sourceType: creditsBatchSourceEnum("source_type").notNull(),
    sourceRef: text("source_ref"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // 幂等性约束：同一 (来源类型, 来源引用) 只能发放一次。
    // 关闭支付 webhook 重放 / 并发双发 / 注册奖励farming 等积分双重发放风险。
    // 偏索引：source_ref 为空的批次（如手动调整）不受约束。
    uniqueIndex("credits_batch_source_ref_unique")
      .on(table.sourceType, table.sourceRef)
      .where(sql`${table.sourceRef} is not null`),
  ]
);

// ============================================
// 积分交易表 (Credits Transactions)
// ============================================
/**
 * 积分交易表 - 双重记账账本
 *
 * 记录所有积分变动，采用借贷记账法
 * 每笔交易都有明确的借方(debit)和贷方(credit)账户
 *
 * @field id - 交易唯一标识符
 * @field userId - 关联的用户 ID
 * @field type - 交易类型
 * @field amount - 交易积分数量（始终为正数）
 * @field debitAccount - 借方账户（资金来源）
 * @field creditAccount - 贷方账户（资金去向）
 * @field description - 交易描述
 * @field metadata - 扩展元数据（JSON）
 * @field createdAt - 创建时间
 */
export const creditsTransaction = pgTable(
  "credits_transaction",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: creditsTransactionTypeEnum("type").notNull(),
    amount: numeric("amount", {
      precision: 18,
      scale: 2,
      mode: "number",
    }).notNull(),
    debitAccount: text("debit_account").notNull(),
    creditAccount: text("credit_account").notNull(),
    description: text("description"),
    // 来源引用（幂等键）：同一 (type, source_ref) 只记一次。
    // 用于消费路径的请求级幂等（重试/并发重复扣费防护），对齐发放/退款的幂等设计。
    sourceRef: text("source_ref"),
    // 计费操作上下文与 source_ref 幂等键独立；expand 阶段允许三列全空。
    operationType: text("operation_type"),
    operationId: text("operation_id"),
    operationCreatedAt: timestamp("operation_created_at"),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    // 偏唯一索引：source_ref 为空的交易（绝大多数历史/无幂等需求的扣费）不受约束。
    // 按 (user_id, type, source_ref) 分桶（迁移 0029）：避免跨用户共用同一 source_ref
    // 时幂等查询误命中他人交易回放其 amount/metadata（IDOR，审计 S-L1）。
    uniqueIndex("credits_transaction_user_type_source_ref_unique")
      .on(table.userId, table.type, table.sourceRef)
      .where(sql`${table.sourceRef} is not null`),
    // 账单/用量页与管理员用户详情:'WHERE user_id=? ORDER BY created_at DESC' 的有序索引,
    // 替代此前对 141MB 表的顺序扫(迁移 0036)。
    index("credits_transaction_user_id_created_at_idx").on(
      table.userId,
      table.createdAt
    ),
    check(
      "credits_transaction_operation_context_all_or_none_check",
      sql`(
        (${table.operationType} IS NULL AND ${table.operationId} IS NULL AND ${table.operationCreatedAt} IS NULL)
        OR
        (${table.operationType} IS NOT NULL AND ${table.operationId} IS NOT NULL AND ${table.operationCreatedAt} IS NOT NULL)
      )`
    ),
    check(
      "credits_transaction_credit_usage_operation_required_check",
      sql`(
        ${table.type} NOT IN ('consumption', 'refund')
        OR (
          ${table.operationType} IS NOT NULL
          AND length(btrim(${table.operationType})) > 0
          AND ${table.operationId} IS NOT NULL
          AND length(btrim(${table.operationId})) > 0
          AND ${table.operationCreatedAt} IS NOT NULL
        )
      )`
    ),
  ]
);

/**
 * 每个计费操作的可重建净消耗投影。
 *
 * 初扣、补扣和关联退款使用同一操作主键；账本仍是唯一财务真相。
 */
export const creditUsageOperation = pgTable(
  "credit_usage_operation",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    operationType: text("operation_type").notNull(),
    operationId: text("operation_id").notNull(),
    operationCreatedAt: timestamp("operation_created_at").notNull(),
    grossConsumed: numeric("gross_consumed", {
      precision: 18,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    refunded: numeric("refunded", {
      precision: 18,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    netConsumed: numeric("net_consumed", {
      precision: 18,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "credit_usage_operation_user_type_id_pk",
      columns: [table.userId, table.operationType, table.operationId],
    }),
    index("credit_usage_operation_user_created_at_idx").on(
      table.userId,
      table.operationCreatedAt
    ),
    check(
      "credit_usage_operation_identity_nonempty_check",
      sql`length(btrim(${table.operationType})) > 0 AND length(btrim(${table.operationId})) > 0`
    ),
    check(
      "credit_usage_operation_amounts_check",
      sql`${table.grossConsumed} >= 0
        AND ${table.refunded} >= 0
        AND ${table.refunded} <= ${table.grossConsumed}
        AND ${table.netConsumed} = ${table.grossConsumed} - ${table.refunded}`
    ),
  ]
);

/**
 * 账本交易到计费操作的唯一投影贡献。
 *
 * transaction_id 主键使在线双写、回填与重试对同一账本行至多应用一次。
 */
export const creditUsageProjectionEntry = pgTable(
  "credit_usage_projection_entry",
  {
    transactionId: text("transaction_id")
      .primaryKey()
      .references(() => creditsTransaction.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    contributionKind:
      creditUsageContributionKindEnum("contribution_kind").notNull(),
    amount: numeric("amount", {
      precision: 18,
      scale: 2,
      mode: "number",
    }).notNull(),
    operationType: text("operation_type").notNull(),
    operationId: text("operation_id").notNull(),
    operationCreatedAt: timestamp("operation_created_at").notNull(),
    transactionCreatedAt: timestamp("transaction_created_at").notNull(),
    projectedAt: timestamp("projected_at").notNull().defaultNow(),
  },
  (table) => [
    index("credit_usage_projection_entry_user_operation_idx").on(
      table.userId,
      table.operationType,
      table.operationId
    ),
    check(
      "credit_usage_projection_entry_identity_nonempty_check",
      sql`length(btrim(${table.operationType})) > 0 AND length(btrim(${table.operationId})) > 0`
    ),
    check(
      "credit_usage_projection_entry_amount_positive_check",
      sql`${table.amount} > 0`
    ),
  ]
);

// ============================================
// 系统设置表 (System Settings)
// ============================================
/**
 * 系统设置表 - 存储管理员可配置的运行时配置与密钥
 *
 * @field key - 配置键名
 * @field value - 配置值，密钥也存储在这里但不会在管理界面回显
 * @field isSecret - 是否为密钥类配置
 * @field updatedBy - 最近更新的管理员
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const systemSetting = pgTable("system_setting", {
  key: text("key").primaryKey(),
  value: json("value").$type<unknown>().notNull(),
  isSecret: boolean("is_secret").notNull().default(false),
  updatedBy: text("updated_by").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// Chat 纯文字连续使用状态
// ============================================
/**
 * Chat 纯文字连续使用状态 - 用于限制连续多次对话但不出图的滥用
 */
export const chatNoImageState = pgTable("chat_no_image_state", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  consecutiveCount: integer("consecutive_count").notNull().default(0),
  lastGenerationId: text("last_generation_id"),
  lastPenaltyAt: timestamp("last_penalty_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type SystemSetting = typeof systemSetting.$inferSelect;
export type NewSystemSetting = typeof systemSetting.$inferInsert;

export type ChatNoImageState = typeof chatNoImageState.$inferSelect;
export type NewChatNoImageState = typeof chatNoImageState.$inferInsert;

// ============================================
// 积分系统类型导出
// ============================================

export type CreditsBalance = typeof creditsBalance.$inferSelect;
export type NewCreditsBalance = typeof creditsBalance.$inferInsert;

export type CreditsBatch = typeof creditsBatch.$inferSelect;
export type NewCreditsBatch = typeof creditsBatch.$inferInsert;

export type CreditsTransaction = typeof creditsTransaction.$inferSelect;
export type NewCreditsTransaction = typeof creditsTransaction.$inferInsert;

export type CreditUsageOperation = typeof creditUsageOperation.$inferSelect;
export type NewCreditUsageOperation = typeof creditUsageOperation.$inferInsert;

export type CreditUsageProjectionEntry =
  typeof creditUsageProjectionEntry.$inferSelect;
export type NewCreditUsageProjectionEntry =
  typeof creditUsageProjectionEntry.$inferInsert;

/** 积分账户状态类型 */
export type CreditsBalanceStatus =
  (typeof creditsBalanceStatusEnum.enumValues)[number];

/** 积分批次状态类型 */
export type CreditsBatchStatus =
  (typeof creditsBatchStatusEnum.enumValues)[number];

/** 积分批次来源类型 */
export type CreditsBatchSource =
  (typeof creditsBatchSourceEnum.enumValues)[number];

/** 积分交易类型 */
export type CreditsTransactionType =
  (typeof creditsTransactionTypeEnum.enumValues)[number];

/** 积分用量投影贡献类型。 */
export type CreditUsageContributionKind =
  (typeof creditUsageContributionKindEnum.enumValues)[number];

// ============================================
// Newsletter 订阅表
// ============================================
/**
 * Newsletter 订阅者表 - 存储邮件订阅信息
 *
 * @field id - 记录唯一标识符
 * @field email - 订阅者邮箱 (唯一)
 * @field isSubscribed - 是否订阅中 (用于取消订阅而不删除记录)
 * @field subscribedAt - 订阅时间
 * @field unsubscribedAt - 取消订阅时间 (可为空)
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const newsletterSubscriber = pgTable("newsletter_subscriber", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  isSubscribed: boolean("is_subscribed").notNull().default(true),
  subscribedAt: timestamp("subscribed_at").notNull().defaultNow(),
  unsubscribedAt: timestamp("unsubscribed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// Newsletter 类型导出
// ============================================

export type NewsletterSubscriber = typeof newsletterSubscriber.$inferSelect;
export type NewNewsletterSubscriber = typeof newsletterSubscriber.$inferInsert;

// ============================================
// 公告系统 (Announcements)
// ============================================

/**
 * 公告表 - 存储系统公告、维护通知和活动说明
 *
 * @field id - 公告唯一标识符
 * @field title - 公告标题
 * @field content - 公告正文，按纯文本展示
 * @field severity - 公告等级 (info/success/warning/critical)
 * @field isPublished - 是否发布
 * @field isPinned - 是否置顶
 * @field priority - 排序优先级，数字越大越靠前
 * @field publishedAt - 生效发布时间，可为空
 * @field expiresAt - 过期时间，可为空
 * @field createdByUserId - 创建管理员
 * @field updatedByUserId - 最近更新管理员
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const announcement = pgTable("announcement", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  severity: text("severity").notNull().default("info"),
  isPublished: boolean("is_published").notNull().default(false),
  isPinned: boolean("is_pinned").notNull().default(false),
  priority: integer("priority").notNull().default(0),
  publishedAt: timestamp("published_at"),
  expiresAt: timestamp("expires_at"),
  createdByUserId: text("created_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * 公告已读表 - 记录用户已读公告
 */
export const announcementRead = pgTable(
  "announcement_read",
  {
    id: text("id").primaryKey(),
    announcementId: text("announcement_id")
      .notNull()
      .references(() => announcement.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at").notNull().defaultNow(),
  },
  (table) => ({
    announcementUserUnique: uniqueIndex(
      "announcement_read_user_announcement_unique"
    ).on(table.userId, table.announcementId),
  })
);

export type Announcement = typeof announcement.$inferSelect;
export type NewAnnouncement = typeof announcement.$inferInsert;
export type AnnouncementRead = typeof announcementRead.$inferSelect;
export type NewAnnouncementRead = typeof announcementRead.$inferInsert;

// ============================================
// 工单系统枚举
// ============================================

/**
 * 工单类别枚举
 */
export const ticketCategoryEnum = pgEnum("ticket_category", [
  "billing",
  "technical",
  "bug",
  "feature",
  "other",
]);

/**
 * 工单优先级枚举
 */
export const ticketPriorityEnum = pgEnum("ticket_priority", [
  "low",
  "medium",
  "high",
]);

/**
 * 工单状态枚举
 */
export const ticketStatusEnum = pgEnum("ticket_status", [
  "open",
  "in_progress",
  "resolved",
  "closed",
]);

// ============================================
// 工单表 (Tickets)
// ============================================
/**
 * 工单表 - 存储用户支持工单
 *
 * @field id - 工单唯一标识符
 * @field userId - 创建工单的用户 ID
 * @field subject - 工单主题
 * @field category - 工单类别 (billing/technical/bug/feature/other)
 * @field priority - 优先级 (low/medium/high)
 * @field status - 状态 (open/in_progress/resolved/closed)
 * @field userLastSeenAt - 用户最近查看工单详情时间
 * @field lastAdminActivityAt - 最近一次管理员回复或状态更新时间
 * @field adminLastSeenAt - 管理员最近查看工单详情时间
 * @field lastUserActivityAt - 最近一次用户新建或回复时间
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const ticket = pgTable("ticket", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  category: ticketCategoryEnum("category").notNull().default("other"),
  priority: ticketPriorityEnum("priority").notNull().default("medium"),
  status: ticketStatusEnum("status").notNull().default("open"),
  userLastSeenAt: timestamp("user_last_seen_at").notNull().defaultNow(),
  lastAdminActivityAt: timestamp("last_admin_activity_at"),
  adminLastSeenAt: timestamp("admin_last_seen_at"),
  lastUserActivityAt: timestamp("last_user_activity_at").defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ============================================
// 工单消息表 (Ticket Messages)
// ============================================
/**
 * 工单消息表 - 存储工单对话记录
 *
 * @field id - 消息唯一标识符
 * @field ticketId - 关联的工单 ID
 * @field userId - 发送者用户 ID
 * @field content - 消息内容
 * @field isAdminResponse - 是否为管理员回复 (用于 UI 样式区分)
 * @field createdAt - 创建时间
 */
export const ticketMessage = pgTable("ticket_message", {
  id: text("id").primaryKey(),
  ticketId: text("ticket_id")
    .notNull()
    .references(() => ticket.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  isAdminResponse: boolean("is_admin_response").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ============================================
// Image Backend Pool
// ============================================
export const imageBackendGroup = pgTable(
  "image_backend_group",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    isUserSelectable: boolean("is_user_selectable").notNull().default(true),
    contentSafetyEnabled: boolean("content_safety_enabled"),
    priority: integer("priority").notNull().default(50),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "image_backend_group_priority_check",
      sql`${table.priority} >= 0 AND ${table.priority} <= 10000`
    ),
    index("image_backend_group_default_lookup_idx").on(
      table.isEnabled,
      table.isDefault,
      table.createdAt,
      table.id
    ),
  ]
);

/**
 * 统一媒体后端成员。
 *
 * 调度器只读取本表的公共能力、健康与容量事实；协议和凭据分别保存在一对一配置表。
 * 本表是媒体后端成员的唯一顶层真相，API 与 Adobe 不再拥有并行成员表。
 */
export const imageBackendMember = pgTable(
  "image_backend_member",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    supportedModelIds: json("supported_model_ids").$type<string[]>().notNull(),
    contentSafetyEnabled: boolean("content_safety_enabled")
      .notNull()
      .default(true),
    isEnabled: boolean("is_enabled").notNull().default(true),
    alwaysActive: boolean("always_active").notNull().default(false),
    failureCooldownEnabled: boolean("failure_cooldown_enabled")
      .notNull()
      .default(false),
    priority: integer("priority").notNull().default(50),
    concurrency: integer("concurrency").notNull().default(10),
    leaseAcquiredCount: integer("lease_acquired_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    status: text("status").notNull().default("active"),
    healthStatus: text("health_status").notNull().default("healthy"),
    errorEwma: numeric("error_ewma", {
      precision: 8,
      scale: 7,
      mode: "number",
    })
      .notNull()
      .default(0),
    durationMsEwma: numeric("duration_ms_ewma", {
      precision: 18,
      scale: 2,
      mode: "number",
    }),
    successStreak: integer("success_streak").notNull().default(0),
    failStreak: integer("fail_streak").notNull().default(0),
    lastObservedAt: timestamp("last_observed_at"),
    lastUsedAt: timestamp("last_used_at"),
    lastAcquiredAt: timestamp("last_acquired_at"),
    cooldownUntil: timestamp("cooldown_until"),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at"),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "image_backend_member_type_check",
      sql`${table.type} IN ('api', 'adobe')`
    ),
    check(
      "image_backend_member_supported_models_check",
      sql`media_supported_model_ids_are_valid(${table.supportedModelIds})`
    ),
    check(
      "image_backend_member_priority_check",
      sql`${table.priority} >= 0 AND ${table.priority} <= 10000`
    ),
    check(
      "image_backend_member_concurrency_check",
      sql`${table.concurrency} >= 1 AND ${table.concurrency} <= 10000`
    ),
    check(
      "image_backend_member_counts_check",
      sql`${table.leaseAcquiredCount} >= 0 AND ${table.successCount} >= 0 AND ${table.failCount} >= 0 AND ${table.successStreak} >= 0 AND ${table.failStreak} >= 0`
    ),
    check(
      "image_backend_member_status_check",
      sql`${table.status} IN ('active', 'limited', 'error')`
    ),
    check(
      "image_backend_member_health_check",
      sql`${table.healthStatus} IN ('healthy', 'degraded', 'unhealthy') AND ${table.errorEwma} >= 0 AND ${table.errorEwma} <= 1 AND (${table.durationMsEwma} IS NULL OR ${table.durationMsEwma} >= 0)`
    ),
    index("image_backend_member_eligibility_idx").on(
      table.isEnabled,
      table.status,
      table.priority,
      table.id
    ),
    index("image_backend_member_cooldown_idx").on(table.cooldownUntil),
  ]
);

/**
 * API 账号的不可变上游适配版本。
 *
 * `memberIdSnapshot` 不能引用成员表：成员在没有有效租约和非终态任务后可被删除，
 * 但终态任务仍须保留不含密钥的协议快照，供审计与历史诊断使用。
 */
export const imageBackendMemberApiAdapterVersion = pgTable(
  "image_backend_member_api_adapter_version",
  {
    id: text("id").primaryKey(),
    memberIdSnapshot: text("member_id_snapshot").notNull(),
    revision: integer("revision").notNull(),
    credentialScope: text("credential_scope").notNull(),
    configuration: json("configuration")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique(
      "image_backend_member_api_adapter_version_member_revision_unique"
    ).on(table.memberIdSnapshot, table.revision),
    unique("image_backend_member_api_adapter_version_member_id_unique").on(
      table.memberIdSnapshot,
      table.id
    ),
    check(
      "image_backend_member_api_adapter_version_revision_check",
      sql`${table.revision} >= 1`
    ),
    check(
      "image_backend_member_api_adapter_version_credential_scope_check",
      sql`char_length(btrim(${table.credentialScope})) > 0`
    ),
    check(
      "image_backend_member_api_adapter_version_configuration_check",
      sql`json_typeof(${table.configuration}) = 'object'`
    ),
    index("image_backend_member_api_adapter_version_member_created_idx").on(
      table.memberIdSnapshot,
      table.createdAt
    ),
  ]
);

/**
 * API 成员的当前凭据与当前适配版本指针。
 *
 * 密钥不进入适配版本；同凭据域的密钥轮换仅更新此表，已接受任务继续使用固定版本。
 */
export const imageBackendMemberApiConfig = pgTable(
  "image_backend_member_api_config",
  {
    memberId: text("member_id")
      .primaryKey()
      .references(() => imageBackendMember.id, { onDelete: "cascade" }),
    apiKey: text("api_key"),
    currentAdapterVersionId: text("current_adapter_version_id").notNull(),
    credentialScope: text("credential_scope").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "image_backend_member_api_config_credential_scope_check",
      sql`char_length(btrim(${table.credentialScope})) > 0`
    ),
    foreignKey({
      name: "image_backend_member_api_config_current_adapter_version_fk",
      columns: [table.memberId, table.currentAdapterVersionId],
      foreignColumns: [
        imageBackendMemberApiAdapterVersion.memberIdSnapshot,
        imageBackendMemberApiAdapterVersion.id,
      ],
    }),
  ]
);

/** Adobe 成员的一对一 gateway/direct 协议、凭据与运行状态配置。 */
export const imageBackendMemberAdobeConfig = pgTable(
  "image_backend_member_adobe_config",
  {
    memberId: text("member_id")
      .primaryKey()
      .references(() => imageBackendMember.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    baseUrl: text("base_url"),
    apiKey: text("api_key"),
    // Direct 模式下一个顶层成员恰好对应一个 Adobe 账号，不再有内部账号池。
    cookie: text("cookie"),
    scope: text("scope"),
    accessToken: text("access_token"),
    accountUserId: text("account_user_id"),
    displayName: text("display_name"),
    email: text("email"),
    credentialStatus: text("credential_status"),
    tokenExpiresAt: timestamp("token_expires_at"),
    tokenFails: integer("token_fails").notNull().default(0),
    lastRefreshAt: timestamp("last_refresh_at"),
    lastRefreshError: text("last_refresh_error"),
    nextRefreshAt: timestamp("next_refresh_at"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    // Firefly 网页 Profile 的独立短期 Token 与刷新状态；Express 字段保持兼容。
    fireflyAccessToken: text("firefly_access_token"),
    fireflyTokenExpiresAt: timestamp("firefly_token_expires_at"),
    fireflyCredentialStatus: text("firefly_credential_status"),
    fireflyTokenFails: integer("firefly_token_fails").notNull().default(0),
    fireflyLastRefreshAt: timestamp("firefly_last_refresh_at"),
    fireflyLastRefreshError: text("firefly_last_refresh_error"),
    fireflyNextRefreshAt: timestamp("firefly_next_refresh_at"),
    fireflyConsecutiveFailures: integer("firefly_consecutive_failures")
      .notNull()
      .default(0),
    creditsTotal: integer("credits_total"),
    creditsUsed: integer("credits_used"),
    creditsAvailable: integer("credits_available"),
    creditsUpdatedAt: timestamp("credits_updated_at"),
    creditsError: text("credits_error"),
    defaultRatio: text("default_ratio").notNull().default("1x1"),
    defaultResolution: text("default_resolution").notNull().default("2k"),
    gptImageQuality: text("gpt_image_quality").notNull().default("high"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "image_backend_member_adobe_config_mode_check",
      sql`${table.mode} IN ('gateway', 'direct')`
    ),
    check(
      "image_backend_member_adobe_config_shape_check",
      sql`(${table.mode} = 'gateway' AND ${table.baseUrl} IS NOT NULL) OR (${table.mode} = 'direct' AND ${table.baseUrl} IS NULL AND ${table.apiKey} IS NULL)`
    ),
    check(
      "image_backend_member_adobe_config_credential_shape_check",
      sql`(${table.mode} = 'gateway' AND ${table.cookie} IS NULL AND ${table.scope} IS NULL AND ${table.accessToken} IS NULL AND ${table.accountUserId} IS NULL AND ${table.displayName} IS NULL AND ${table.email} IS NULL AND ${table.credentialStatus} IS NULL AND ${table.tokenExpiresAt} IS NULL AND ${table.tokenFails} = 0 AND ${table.lastRefreshAt} IS NULL AND ${table.lastRefreshError} IS NULL AND ${table.nextRefreshAt} IS NULL AND ${table.consecutiveFailures} = 0 AND ${table.fireflyAccessToken} IS NULL AND ${table.fireflyTokenExpiresAt} IS NULL AND ${table.fireflyCredentialStatus} IS NULL AND ${table.fireflyTokenFails} = 0 AND ${table.fireflyLastRefreshAt} IS NULL AND ${table.fireflyLastRefreshError} IS NULL AND ${table.fireflyNextRefreshAt} IS NULL AND ${table.fireflyConsecutiveFailures} = 0 AND ${table.creditsTotal} IS NULL AND ${table.creditsUsed} IS NULL AND ${table.creditsAvailable} IS NULL AND ${table.creditsUpdatedAt} IS NULL AND ${table.creditsError} IS NULL) OR (${table.mode} = 'direct' AND ${table.cookie} IS NOT NULL AND char_length(btrim(${table.cookie})) BETWEEN 1 AND 64000 AND (${table.scope} IS NULL OR char_length(btrim(${table.scope})) BETWEEN 1 AND 4096) AND ${table.accessToken} IS NOT NULL AND char_length(btrim(${table.accessToken})) >= 1 AND ${table.credentialStatus} IS NOT NULL AND (${table.fireflyAccessToken} IS NULL OR char_length(btrim(${table.fireflyAccessToken})) >= 1) AND (${table.fireflyAccessToken} IS NULL OR ${table.fireflyCredentialStatus} IS NOT NULL) AND (${table.fireflyCredentialStatus} IS NULL OR ${table.fireflyAccessToken} IS NOT NULL OR ${table.fireflyCredentialStatus} = 'error'))`
    ),
    check(
      "image_backend_member_adobe_config_credential_status_check",
      sql`${table.credentialStatus} IS NULL OR ${table.credentialStatus} IN ('active', 'error', 'exhausted', 'invalid')`
    ),
    check(
      "image_backend_member_adobe_config_firefly_credential_status_check",
      sql`${table.fireflyCredentialStatus} IS NULL OR ${table.fireflyCredentialStatus} IN ('active', 'error', 'exhausted', 'invalid')`
    ),
    check(
      "image_backend_member_adobe_config_failure_counts_check",
      sql`${table.tokenFails} >= 0 AND ${table.consecutiveFailures} >= 0 AND ${table.fireflyTokenFails} >= 0 AND ${table.fireflyConsecutiveFailures} >= 0`
    ),
    check(
      "image_backend_member_adobe_config_quality_check",
      sql`${table.gptImageQuality} IN ('low', 'medium', 'high')`
    ),
  ]
);

/**
 * Adobe direct 成员的当前凭据健康摘要。
 *
 * 当前摘要与成员一对一并随成员删除；网络调用必须在事务外完成，提交时以
 * claimToken、credentialRevision 和 memberEnableRevision 做 CAS，避免旧结果
 * 覆盖重新授权或停用再启用后的新状态。
 */
export const adobeCredentialHealth = pgTable(
  "adobe_credential_health",
  {
    memberId: text("member_id")
      .primaryKey()
      .references(() => imageBackendMember.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    credentialRevision: integer("credential_revision").notNull().default(1),
    memberEnableRevision: integer("member_enable_revision")
      .notNull()
      .default(1),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    failureProfiles: json("failure_profiles")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::json`),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at"),
    nextCheckAt: timestamp("next_check_at").notNull().defaultNow(),
    evaluationDeadlineAt: timestamp("evaluation_deadline_at"),
    lastCheckAt: timestamp("last_check_at"),
    lastSuccessAt: timestamp("last_success_at"),
    firstFailureAt: timestamp("first_failure_at"),
    lastFailureAt: timestamp("last_failure_at"),
    isolatedAt: timestamp("isolated_at"),
    diagnostic: json("diagnostic").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "adobe_credential_health_status_check",
      sql`${table.status} IN ('pending', 'healthy', 'degraded', 'isolated', 'overdue')`
    ),
    check(
      "adobe_credential_health_revisions_check",
      sql`${table.credentialRevision} >= 1 AND ${table.memberEnableRevision} >= 1`
    ),
    check(
      "adobe_credential_health_failure_count_check",
      sql`${table.consecutiveFailures} >= 0`
    ),
    check(
      "adobe_credential_health_claim_pair_check",
      sql`(${table.claimToken} IS NULL AND ${table.claimExpiresAt} IS NULL) OR (${table.claimToken} IS NOT NULL AND ${table.claimExpiresAt} IS NOT NULL)`
    ),
    check(
      "adobe_credential_health_isolation_check",
      sql`(${table.status} = 'isolated' AND ${table.isolatedAt} IS NOT NULL) OR (${table.status} <> 'isolated')`
    ),
    index("adobe_credential_health_due_idx").on(
      table.status,
      table.nextCheckAt,
      table.claimExpiresAt
    ),
    index("adobe_credential_health_isolated_idx").on(table.isolatedAt),
  ]
);

/**
 * Adobe 凭据评估的非敏感历史。
 *
 * memberIdSnapshot 不引用成员表，成员删除后仍保留 90 天追踪证据；claimToken
 * 全局唯一，使同一 claimant 的重放只能落下一条 accepted/stale/discarded 记录。
 */
export const adobeCredentialEvaluation = pgTable(
  "adobe_credential_evaluation",
  {
    id: text("id").primaryKey(),
    claimToken: text("claim_token").notNull(),
    memberIdSnapshot: text("member_id_snapshot").notNull(),
    memberNameSnapshot: text("member_name_snapshot").notNull(),
    credentialRevision: integer("credential_revision").notNull(),
    memberEnableRevision: integer("member_enable_revision").notNull(),
    source: text("source").notNull(),
    disposition: text("disposition").notNull(),
    outcome: text("outcome").notNull(),
    failureProfiles: json("failure_profiles")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::json`),
    diagnostic: json("diagnostic").$type<Record<string, unknown> | null>(),
    startedAt: timestamp("started_at").notNull(),
    completedAt: timestamp("completed_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("adobe_credential_evaluation_claim_unique").on(table.claimToken),
    check(
      "adobe_credential_evaluation_revisions_check",
      sql`${table.credentialRevision} >= 1 AND ${table.memberEnableRevision} >= 1`
    ),
    check(
      "adobe_credential_evaluation_source_check",
      sql`${table.source} IN ('scheduled', 'passive', 'manual', 'reauthorization')`
    ),
    check(
      "adobe_credential_evaluation_disposition_check",
      sql`${table.disposition} IN ('accepted', 'stale', 'discarded')`
    ),
    check(
      "adobe_credential_evaluation_outcome_check",
      sql`${table.outcome} IN ('success', 'member_failure', 'platform_failure')`
    ),
    index("adobe_credential_evaluation_member_created_idx").on(
      table.memberIdSnapshot,
      table.createdAt
    ),
    index("adobe_credential_evaluation_retention_idx").on(table.completedAt),
  ]
);

/**
 * Adobe 凭据故障事件。
 *
 * 开放事件按成员偏唯一，隔离重试只更新同一事件；恢复关闭原事件并在该事件
 * 上创建恢复投递，成员删除后非敏感快照仍可保留。
 */
export const adobeCredentialIncident = pgTable(
  "adobe_credential_incident",
  {
    id: text("id").primaryKey(),
    memberIdSnapshot: text("member_id_snapshot").notNull(),
    memberNameSnapshot: text("member_name_snapshot").notNull(),
    status: text("status").notNull().default("open"),
    consecutiveFailures: integer("consecutive_failures").notNull(),
    failureProfiles: json("failure_profiles")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::json`),
    diagnostic: json("diagnostic").$type<Record<string, unknown> | null>(),
    openedAt: timestamp("opened_at").notNull().defaultNow(),
    lastFailureAt: timestamp("last_failure_at").notNull(),
    closedAt: timestamp("closed_at"),
    closeReason: text("close_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("adobe_credential_incident_open_member_unique")
      .on(table.memberIdSnapshot)
      .where(sql`${table.status} = 'open'`),
    check(
      "adobe_credential_incident_status_check",
      sql`${table.status} IN ('open', 'closed')`
    ),
    check(
      "adobe_credential_incident_failure_count_check",
      sql`${table.consecutiveFailures} >= 1`
    ),
    check(
      "adobe_credential_incident_close_shape_check",
      sql`(${table.status} = 'open' AND ${table.closedAt} IS NULL AND ${table.closeReason} IS NULL) OR (${table.status} = 'closed' AND ${table.closedAt} IS NOT NULL AND ${table.closeReason} IS NOT NULL)`
    ),
    index("adobe_credential_incident_retention_idx").on(
      table.status,
      table.closedAt
    ),
  ]
);

/**
 * Adobe 凭据通知的持久 outbox 投递。
 *
 * targetEnvelope、payload 与 configRevision 在事件创建时固化；HMAC 密钥本身
 * 从不入库，只允许保存不可逆指纹。唯一约束保证同一事件类型和渠道只有一条
 * 逻辑投递，worker 通过 claim 字段实现至少一次有限重试。
 */
export const adobeCredentialNotificationDelivery = pgTable(
  "adobe_credential_notification_delivery",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id").notNull(),
    eventType: text("event_type").notNull(),
    channel: text("channel").notNull(),
    status: text("status").notNull().default("pending"),
    targetEnvelope: json("target_envelope")
      .$type<Record<string, unknown>>()
      .notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    configRevision: text("config_revision").notNull(),
    secretFingerprint: text("secret_fingerprint"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at"),
    lastErrorCode: text("last_error_code"),
    providerRequestId: text("provider_request_id"),
    deliveredAt: timestamp("delivered_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "adobe_credential_delivery_incident_fk",
      columns: [table.incidentId],
      foreignColumns: [adobeCredentialIncident.id],
    }).onDelete("restrict"),
    unique("adobe_credential_delivery_event_channel_unique").on(
      table.incidentId,
      table.eventType,
      table.channel
    ),
    check(
      "adobe_credential_delivery_event_type_check",
      sql`${table.eventType} IN ('failure', 'recovery')`
    ),
    check(
      "adobe_credential_delivery_channel_check",
      sql`${table.channel} IN ('email', 'webhook')`
    ),
    check(
      "adobe_credential_delivery_status_check",
      sql`${table.status} IN ('pending', 'delivering', 'retry', 'delivered', 'dead', 'configuration_superseded', 'cancelled')`
    ),
    check(
      "adobe_credential_delivery_attempt_count_check",
      sql`${table.attemptCount} >= 0 AND ${table.attemptCount} <= 8`
    ),
    check(
      "adobe_credential_delivery_claim_pair_check",
      sql`(${table.claimToken} IS NULL AND ${table.claimExpiresAt} IS NULL) OR (${table.claimToken} IS NOT NULL AND ${table.claimExpiresAt} IS NOT NULL)`
    ),
    index("adobe_credential_delivery_recovery_idx").on(
      table.status,
      table.nextAttemptAt,
      table.claimExpiresAt
    ),
    index("adobe_credential_delivery_retention_idx").on(
      table.status,
      table.deliveredAt
    ),
  ]
);

/** 统一成员与既有媒体后端分组的多对多关系。 */
export const imageBackendMemberGroup = pgTable(
  "image_backend_member_group",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id")
      .notNull()
      .references(() => imageBackendMember.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => imageBackendGroup.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("image_backend_member_group_member_group_unique").on(
      table.memberId,
      table.groupId
    ),
    index("image_backend_member_group_group_idx").on(
      table.groupId,
      table.memberId
    ),
  ]
);

/**
 * 跨应用副本共享的统一成员租约。
 *
 * ownerToken 是续期、接管和释放的并发令牌；服务层必须同时匹配租约 ID 与当前令牌，
 * 防止旧 worker 释放已经移交给新 owner 的租约。
 */
export const imageBackendMemberLease = pgTable(
  "image_backend_member_lease",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id")
      .notNull()
      .references(() => imageBackendMember.id, { onDelete: "cascade" }),
    ownerToken: text("owner_token").notNull(),
    apiAdapterMemberId: text("api_adapter_member_id"),
    apiAdapterVersionId: text("api_adapter_version_id"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("image_backend_member_lease_member_expires_idx").on(
      table.memberId,
      table.expiresAt
    ),
    index("image_backend_member_lease_expires_idx").on(table.expiresAt),
    check(
      "image_backend_member_lease_api_adapter_pair_check",
      sql`(${table.apiAdapterMemberId} IS NULL) = (${table.apiAdapterVersionId} IS NULL)`
    ),
    foreignKey({
      name: "image_backend_member_lease_api_adapter_version_fk",
      columns: [table.apiAdapterMemberId, table.apiAdapterVersionId],
      foreignColumns: [
        imageBackendMemberApiAdapterVersion.memberIdSnapshot,
        imageBackendMemberApiAdapterVersion.id,
      ],
    }),
  ]
);

/**
 * 统一成员调度聚合指标。
 *
 * 仅保存策略、结果、候选数量和延迟等调度事实；成员类型是历史快照，故不设置成员
 * 外键，避免删除成员时破坏指标。不得在 metadata 中写入 prompt、媒体或凭据。
 */
export const imageBackendMemberSchedulerMetric = pgTable(
  "image_backend_member_scheduler_metric",
  {
    id: text("id").primaryKey(),
    bucketStartedAt: timestamp("bucket_started_at").notNull(),
    requestKind: text("request_kind").notNull(),
    strategy: text("strategy").notNull(),
    outcome: text("outcome").notNull(),
    memberType: text("member_type"),
    memberId: text("member_id"),
    groupId: text("group_id"),
    eventCount: integer("event_count").notNull().default(0),
    candidateCountTotal: integer("candidate_count_total").notNull().default(0),
    latencyMsTotal: integer("latency_ms_total").notNull().default(0),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "image_backend_member_scheduler_metric_request_kind_check",
      sql`${table.requestKind} IN ('image', 'video')`
    ),
    check(
      "image_backend_member_scheduler_metric_strategy_check",
      sql`${table.strategy} IN ('priority', 'least_acquired', 'least_load')`
    ),
    check(
      "image_backend_member_scheduler_metric_outcome_check",
      sql`${table.outcome} IN ('acquired', 'capacity_rejected', 'switched', 'terminal_failure', 'no_candidate')`
    ),
    check(
      "image_backend_member_scheduler_metric_member_type_check",
      sql`${table.memberType} IS NULL OR ${table.memberType} IN ('api', 'adobe')`
    ),
    check(
      "image_backend_member_scheduler_metric_counts_check",
      sql`${table.eventCount} >= 0 AND ${table.candidateCountTotal} >= 0 AND ${table.latencyMsTotal} >= 0`
    ),
    unique("image_backend_member_scheduler_metric_bucket_unique")
      .on(
        table.bucketStartedAt,
        table.requestKind,
        table.strategy,
        table.outcome,
        table.memberType,
        table.memberId,
        table.groupId
      )
      .nullsNotDistinct(),
    index("image_backend_member_scheduler_metric_bucket_idx").on(
      table.bucketStartedAt,
      table.strategy,
      table.outcome
    ),
  ]
);

/** 视频任务自有、storage-only 的单个输入对象。 */
type PersistedVideoInputAsset = {
  source: "storage";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  storageKey: string;
  storageBucket: string;
  byteLength: number;
};

/** 视频任务按业务语义保存的持久输入清单。 */
type PersistedVideoInputManifest = {
  firstFrame?: PersistedVideoInputAsset;
  lastFrame?: PersistedVideoInputAsset;
  referenceImages?: PersistedVideoInputAsset[];
};

// Adobe Firefly 视频生成（异步）：与图像 generation 解耦——视频是新产物类型，有自己的
// 状态机、轮询恢复、按模型族每秒固定积分×时长计费。提交后置 running 并保存 pollUrl，
// 定时/请求侧轮询到完成再 re-host 到对象存储。financially 真相仍在 credits_transaction，
// 本表仅记录产物与状态。
export const videoGeneration = pgTable(
  "video_generation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // 外部 API key（站内创作页为空）。
    apiKeyId: text("api_key_id"),
    // 站内、外部 API Key 与每把 MCP Key 的稳定隔离域。
    principalScope: text("principal_scope").notNull(),
    // 新请求写 true；历史 API 行为空时必须 fail closed，不能按当前 key 状态回推。
    usageLogVisible: boolean("usage_log_visible"),
    // 统一后端成员引用；成员删除后保留历史任务与产物。
    backendMemberId: text("backend_member_id").references(
      () => imageBackendMember.id,
      { onDelete: "set null" }
    ),
    // Adobe direct 成员与成员租约是 accepted 后恢复同一上游任务的持久身份。
    // 逻辑恢复身份的生命周期长于物理租约行；过期行删除后仍需用同一 ID 容量感知重建。
    memberLeaseId: text("member_lease_id"),
    memberLeaseOwnerToken: text("member_lease_owner_token"),
    // API 任务固定提交时的成员/版本快照；Adobe 任务保持成对为空。
    apiAdapterMemberId: text("api_adapter_member_id"),
    apiAdapterVersionId: text("api_adapter_version_id"),
    apiAdapterQueryFailureCount: integer("api_adapter_query_failure_count")
      .notNull()
      .default(0),
    // 平台真实视频模型 ID；时长、比例与分辨率只存在于各自独立列。
    model: text("model").notNull(),
    // 请求头 Profile 与 IMS Token Profile 相互独立；视频 Bearer Token 固定复用 Express。
    adobeRequestProfile: text("adobe_request_profile")
      .$type<"express" | "firefly">()
      .notNull(),
    adobeAuthProfile: text("adobe_auth_profile")
      .$type<"express" | "firefly">()
      .notNull(),
    prompt: text("prompt").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    aspectRatio: text("aspect_ratio").notNull(),
    resolution: text("resolution").notNull(),
    // pending / running / completed / failed。
    status: text("status").notNull().default("pending"),
    // 可恢复执行阶段；status 保留为面向查询方的稳定粗粒度状态。
    stage: text("stage").notNull().default("created"),
    stateVersion: integer("state_version").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    // 真实输入语义与任务自有存储身份。
    inputManifest: json("input_manifest").$type<PersistedVideoInputManifest>(),
    // 新任务在创建时固定生成内容 bucket，恢复重试不得跟随后台配置切桶；历史行允许为空。
    storageBucket: text("storage_bucket"),
    // 完成后 re-host 到对象存储的 key；videoUrl 为上游 presigned（短期）。
    storageKey: text("storage_key"),
    videoUrl: text("video_url"),
    creditsConsumed: numeric("credits_consumed", {
      precision: 18,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    // 外部 API Key 的任务级幂等配额金额；成功终态清零标记但保留 key 累计用量，
    // 失败退款事务同时清零标记并归还 key 用量。
    apiKeyCreditsReserved: numeric("api_key_credits_reserved", {
      precision: 18,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    // 异步轮询恢复用。
    pollUrl: text("poll_url"),
    upstreamJobId: text("upstream_job_id"),
    nextPollAt: timestamp("next_poll_at"),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at"),
    submitStartedAt: timestamp("submit_started_at"),
    upstreamAcceptedAt: timestamp("upstream_accepted_at"),
    error: text("error"),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("video_generation_user_idx").on(table.userId, table.createdAt),
    index("video_generation_status_idx").on(table.status, table.createdAt),
    index("video_generation_backend_member_idx").on(table.backendMemberId),
    index("video_generation_member_lease_idx").on(table.memberLeaseId),
    index("video_generation_principal_stage_idx").on(
      table.principalScope,
      table.stage
    ),
    index("video_generation_recovery_idx").on(
      table.stage,
      table.nextPollAt,
      table.claimExpiresAt
    ),
    check(
      "video_generation_stage_check",
      sql`${table.stage} IN ('created', 'charged', 'submitting', 'submit_uncertain', 'polling', 'downloading', 'refunding', 'completed', 'failed')`
    ),
    check(
      "video_generation_adobe_profile_check",
      sql`${table.adobeRequestProfile} IN ('express', 'firefly') AND ${table.adobeAuthProfile} IN ('express', 'firefly')`
    ),
    check(
      "video_generation_recovery_counts_check",
      sql`${table.stateVersion} >= 0 AND ${table.attemptCount} >= 0 AND ${table.apiKeyCreditsReserved} >= 0 AND ${table.apiAdapterQueryFailureCount} >= 0 AND (${table.apiKeyId} IS NOT NULL OR ${table.apiKeyCreditsReserved} = 0)`
    ),
    check(
      "video_generation_api_adapter_pair_check",
      sql`(${table.apiAdapterMemberId} IS NULL) = (${table.apiAdapterVersionId} IS NULL)`
    ),
    foreignKey({
      name: "video_generation_api_adapter_version_fk",
      columns: [table.apiAdapterMemberId, table.apiAdapterVersionId],
      foreignColumns: [
        imageBackendMemberApiAdapterVersion.memberIdSnapshot,
        imageBackendMemberApiAdapterVersion.id,
      ],
    }),
    check(
      "video_generation_real_model_check",
      sql`${table.model} IN ('sora2', 'sora2-pro', 'veo31', 'veo31-fast', 'veo31-ref', 'kling-o3', 'kling3', 'kling3-omni', 'runway-gen45', 'ray314', 'ray314-hdr', 'seedance2', 'seedance2-fast')`
    ),
    check(
      "video_generation_input_manifest_check",
      sql`${table.inputManifest} IS NULL OR video_input_manifest_is_valid(${table.inputManifest}, ${table.userId}, ${table.id}, ${table.model})`
    ),
  ]
);

// ============================================
// 图片异步任务
// ============================================

/**
 * 图片异步 MQ 任务。
 *
 * Redis 只保存本表主键；Phase A 同时保留旧批次数组和新的 storage-only 单项输入、
 * generation 身份、治理快照与 admission 释放状态。generation 和
 * credits_transaction 仍分别是产物与财务真相，本表只负责异步编排与恢复游标。
 */
export const imageAsyncTask = pgTable(
  "image_async_task",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id").notNull(),
    plan: text("plan").notNull(),
    operation: text("operation")
      .$type<"generate" | "edit" | "mask">()
      .notNull(),
    generationInputs: json("generation_inputs")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    generationIds: json("generation_ids").$type<string[]>().notNull(),
    generationInput: json("generation_input").$type<Record<string, unknown>>(),
    inputDigest: text("input_digest"),
    generationId: text("generation_id"),
    effectiveUserConcurrency: integer("effective_user_concurrency"),
    groupIdSnapshot: text("group_id_snapshot"),
    groupPrioritySnapshot: integer("group_priority_snapshot"),
    admissionLeaseToken: text("admission_lease_token"),
    admissionLeaseExpiresAt: timestamp("admission_lease_expires_at"),
    admissionLeaseReleasedAt: timestamp("admission_lease_released_at"),
    mqDeliveryVersion: integer("mq_delivery_version").notNull().default(0),
    mqDeliveryDueAt: timestamp("mq_delivery_due_at"),
    claimRecoveryDueAt: timestamp("claim_recovery_due_at"),
    admissionRenewalDueAt: timestamp("admission_renewal_due_at"),
    terminalReleaseDueAt: timestamp("terminal_release_due_at"),
    responseFormat: text("response_format")
      .$type<"url" | "b64_json">()
      .notNull(),
    callbackUrl: text("callback_url"),
    status: text("status")
      .$type<"queued" | "running" | "completed" | "failed">()
      .notNull()
      .default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("image_async_task_owner_created_idx").on(
      table.userId,
      table.apiKeyId,
      table.createdAt
    ),
    index("image_async_task_recovery_idx").on(
      table.status,
      table.claimExpiresAt,
      table.createdAt
    ),
    uniqueIndex("image_async_task_generation_id_unique")
      .on(table.generationId)
      .where(sql`${table.generationId} IS NOT NULL`),
    uniqueIndex("image_async_task_admission_lease_token_unique")
      .on(table.admissionLeaseToken)
      .where(sql`${table.admissionLeaseToken} IS NOT NULL`),
    index("image_async_task_mq_delivery_due_idx")
      .on(table.mqDeliveryDueAt, table.id)
      .where(
        sql`${table.status} IN ('queued', 'running') AND ${table.mqDeliveryDueAt} IS NOT NULL`
      ),
    index("image_async_task_claim_recovery_due_idx")
      .on(table.claimRecoveryDueAt, table.id)
      .where(
        sql`${table.status} IN ('queued', 'running') AND ${table.claimRecoveryDueAt} IS NOT NULL`
      ),
    index("image_async_task_admission_renewal_due_idx")
      .on(table.admissionRenewalDueAt, table.id)
      .where(
        sql`${table.status} IN ('queued', 'running') AND ${table.admissionRenewalDueAt} IS NOT NULL`
      ),
    index("image_async_task_terminal_release_due_idx")
      .on(table.terminalReleaseDueAt, table.id)
      .where(
        sql`${table.status} IN ('completed', 'failed') AND ${table.terminalReleaseDueAt} IS NOT NULL AND ${table.admissionLeaseReleasedAt} IS NULL`
      ),
    check(
      "image_async_task_operation_check",
      sql`${table.operation} IN ('generate', 'edit', 'mask')`
    ),
    check(
      "image_async_task_response_format_check",
      sql`${table.responseFormat} IN ('url', 'b64_json')`
    ),
    check(
      "image_async_task_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed')`
    ),
    check(
      "image_async_task_attempt_count_check",
      sql`${table.attemptCount} >= 0 AND ${table.mqDeliveryVersion} >= 0`
    ),
    check(
      "image_async_task_identity_nonempty_check",
      sql`length(btrim(${table.userId})) > 0 AND length(btrim(${table.apiKeyId})) > 0 AND length(btrim(${table.plan})) > 0`
    ),
    check(
      "image_async_task_single_input_core_check",
      sql`(
        ${table.generationInput} IS NULL
        AND ${table.inputDigest} IS NULL
        AND ${table.generationId} IS NULL
      ) OR (
        ${table.generationInput} IS NOT NULL
        AND ${table.inputDigest} IS NOT NULL
        AND ${table.inputDigest} ~ '^(md5:[0-9a-f]{32}|sha256:[0-9a-f]{64})$'
        AND ${table.generationId} IS NOT NULL
        AND length(btrim(${table.generationId})) BETWEEN 1 AND 128
      )`
    ),
    check(
      "image_async_task_generation_input_shape_check",
      sql`${table.generationInput} IS NULL OR (
        json_typeof(${table.generationInput}) = 'object'
        AND json_typeof(${table.generationInput}->'generationId') = 'string'
        AND ${table.generationInput}->>'generationId' = ${table.generationId}
        AND json_typeof(${table.generationInput}->'operation') = 'string'
        AND ${table.generationInput}->>'operation' = ${table.operation}
      )`
    ),
    check(
      "image_async_task_batch_count_retired_check",
      sql`(
        ${table.generationInput} IS NULL
        OR NOT (${table.generationInput}::jsonb ? 'count')
      ) AND (
        json_typeof(${table.generationInputs}) <> 'array'
        OR json_array_length(${table.generationInputs}) <> 1
        OR json_typeof(${table.generationInputs}->0) <> 'object'
        OR NOT ((${table.generationInputs}->0)::jsonb ? 'count')
      )`
    ),
    check(
      "image_async_task_policy_snapshot_check",
      sql`(
        ${table.effectiveUserConcurrency} IS NULL
        AND ${table.groupIdSnapshot} IS NULL
        AND ${table.groupPrioritySnapshot} IS NULL
      ) OR (
        ${table.effectiveUserConcurrency} IS NOT NULL
        AND ${table.effectiveUserConcurrency} BETWEEN 1 AND 10000
        AND ${table.groupIdSnapshot} IS NOT NULL
        AND length(btrim(${table.groupIdSnapshot})) BETWEEN 1 AND 128
        AND ${table.groupPrioritySnapshot} IS NOT NULL
        AND ${table.groupPrioritySnapshot} BETWEEN 0 AND 10000
      )`
    ),
    check(
      "image_async_task_admission_lease_state_check",
      sql`(
        ${table.admissionLeaseToken} IS NULL
        AND ${table.admissionLeaseExpiresAt} IS NULL
        AND ${table.admissionLeaseReleasedAt} IS NULL
      ) OR (
        ${table.admissionLeaseToken} IS NOT NULL
        AND length(btrim(${table.admissionLeaseToken})) BETWEEN 1 AND 256
        AND ${table.admissionLeaseExpiresAt} IS NOT NULL
        AND (
          ${table.admissionLeaseReleasedAt} IS NULL
          OR ${table.status} IN ('completed', 'failed')
        )
      )`
    ),
    check(
      "image_async_task_due_state_check",
      sql`(
        (${table.mqDeliveryDueAt} IS NULL OR ${table.status} IN ('queued', 'running'))
        AND (${table.claimRecoveryDueAt} IS NULL OR ${table.status} IN ('queued', 'running'))
        AND (
          ${table.admissionRenewalDueAt} IS NULL
          OR (
            ${table.status} IN ('queued', 'running')
            AND ${table.admissionLeaseToken} IS NOT NULL
            AND ${table.admissionLeaseReleasedAt} IS NULL
          )
        )
        AND (
          ${table.terminalReleaseDueAt} IS NULL
          OR (
            ${table.status} IN ('completed', 'failed')
            AND ${table.admissionLeaseToken} IS NOT NULL
            AND ${table.admissionLeaseReleasedAt} IS NULL
          )
        )
      )`
    ),
  ]
);

// ============================================
// 视频输入转存准入预留
// ============================================

/**
 * 视频输入 staging reservation。
 *
 * 在任何 data URL 解码/上传前先按用户锁占用槽位；最终任务事务以 token 消费该行，
 * 崩溃遗留行按 expiresAt 由后续准入或输入清理 worker 回收，消除预检与任务插入间
 * 的资源放大窗口。
 */
export const videoTaskStagingReservation = pgTable(
  "video_task_staging_reservation",
  {
    taskId: text("task_id").primaryKey(),
    reservationToken: text("reservation_token").notNull(),
    userId: text("user_id").notNull(),
    principalScope: text("principal_scope").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("video_staging_reservation_token_unique").on(
      table.reservationToken
    ),
    index("video_staging_reservation_user_expiry_idx").on(
      table.userId,
      table.expiresAt
    ),
    index("video_staging_reservation_principal_expiry_idx").on(
      table.principalScope,
      table.expiresAt
    ),
    index("video_staging_reservation_expiry_idx").on(table.expiresAt),
    check(
      "video_staging_reservation_identity_nonempty_check",
      sql`length(btrim(${table.reservationToken})) > 0 AND length(btrim(${table.userId})) > 0 AND length(btrim(${table.principalScope})) > 0`
    ),
  ]
);

// ============================================
// 视频临时输入持久清理队列
// ============================================

/**
 * 视频输入对象清理队列。
 *
 * 对象存储删除与数据库任务创建无法组成同一事务；准入竞争或终态清理失败时，本表
 * 保留稳定对象身份与 claim；created 任务保护仍需读取的输入，后续阶段可由多实例
 * worker 最终重试删除而不会留下孤儿大对象。
 */
export const videoInputCleanup = pgTable(
  "video_input_cleanup",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    videoId: text("video_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    storageKey: text("storage_key").notNull(),
    storageBucket: text("storage_bucket").notNull(),
    reason: text("reason")
      .$type<"orphan" | "lifecycle_delete">()
      .notNull()
      .default("orphan"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("video_input_cleanup_recovery_idx").on(
      table.nextAttemptAt,
      table.claimExpiresAt
    ),
    check(
      "video_input_cleanup_attempt_count_check",
      sql`${table.attemptCount} >= 0`
    ),
    check(
      "video_input_cleanup_reason_check",
      sql`${table.reason} IN ('orphan', 'lifecycle_delete')`
    ),
    check(
      "video_input_cleanup_identity_nonempty_check",
      sql`length(btrim(${table.userId})) > 0 AND length(btrim(${table.videoId})) > 0 AND length(btrim(${table.attemptId})) > 0 AND length(btrim(${table.storageKey})) > 0 AND length(btrim(${table.storageBucket})) > 0`
    ),
  ]
);

// ============================================
// 视频终态回调可靠投递
// ============================================

/**
 * 视频回调投递表。
 *
 * callback URL 只从受信 OperationContext 注册，不写入视频任务 metadata；稳定投递 ID
 * 作为接收方幂等键，claim 字段保证多副本 worker 不并发投递同一条记录。
 */
export const videoGenerationCallbackDelivery = pgTable(
  "video_generation_callback_delivery",
  {
    id: text("id").primaryKey(),
    videoGenerationId: text("video_generation_id")
      .notNull()
      .references(() => videoGeneration.id, { onDelete: "cascade" }),
    callbackUrl: text("callback_url").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    claimToken: text("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("video_callback_delivery_video_unique").on(
      table.videoGenerationId
    ),
    index("video_callback_delivery_recovery_idx").on(
      table.status,
      table.nextAttemptAt,
      table.claimExpiresAt
    ),
    check(
      "video_callback_delivery_status_check",
      sql`${table.status} IN ('pending', 'delivering', 'delivered', 'dead')`
    ),
    check(
      "video_callback_delivery_attempt_count_check",
      sql`${table.attemptCount} >= 0`
    ),
  ]
);

// ============================================
// 用户产出用量读模型
// ============================================

/** 成功产物类型；事件唯一键由类型和源任务 ID 共同组成。 */
export const outputUsageKindEnum = pgEnum("output_usage_kind", [
  "image",
  "video",
]);

/** 统计读模型的部署与对账状态。 */
export const analyticsReadModelStatusEnum = pgEnum(
  "analytics_read_model_status",
  ["building", "backfilling", "reconciling", "ready", "failed"]
);

/**
 * 成功产物事件读模型。
 *
 * 每个持久化任务最多一行；图片数量和视频秒数互斥。该表可由 generation 与
 * video_generation 重建，不是产物真相。
 */
export const userOutputUsageEvent = pgTable(
  "user_output_usage_event",
  {
    outputKind: outputUsageKindEnum("output_kind").notNull(),
    sourceTaskId: text("source_task_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    operationCreatedAt: timestamp("operation_created_at").notNull(),
    imageCount: integer("image_count").notNull().default(0),
    videoSeconds: integer("video_seconds").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.outputKind, table.sourceTaskId] }),
    index("user_output_usage_event_user_created_kind_idx").on(
      table.userId,
      table.operationCreatedAt,
      table.outputKind
    ),
    check(
      "user_output_usage_event_metric_check",
      sql`(
        (${table.outputKind} = 'image' AND ${table.imageCount} > 0 AND ${table.videoSeconds} = 0)
        OR
        (${table.outputKind} = 'video' AND ${table.imageCount} = 0 AND ${table.videoSeconds} > 0)
      )`
    ),
  ]
);

/**
 * 每用户累计成功产出汇总。
 *
 * 只有成功插入新的产物事件后才按增量原子更新，避免重放或回填覆盖并发写入。
 */
export const userUsageSummary = pgTable(
  "user_usage_summary",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    totalImageCount: bigint("total_image_count", { mode: "number" })
      .notNull()
      .default(0),
    totalVideoSeconds: bigint("total_video_seconds", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "user_usage_summary_nonnegative_check",
      sql`${table.totalImageCount} >= 0 AND ${table.totalVideoSeconds} >= 0`
    ),
  ]
);

/** 读模型分批回填使用的稳定复合游标。 */
export type AnalyticsReadModelCursor = {
  createdAt: string;
  id: string;
};

/** 不同读模型使用的高水位；积分模型分别冻结消费和退款上界。 */
export type AnalyticsReadModelWatermark =
  | AnalyticsReadModelCursor
  | {
      consumption: AnalyticsReadModelCursor | null;
      refund: AnalyticsReadModelCursor | null;
    };

/**
 * 统计读模型启用状态。
 *
 * UOL 只允许读取 ready 版本；回填器在零差异对账后更新状态和水位。
 */
export const analyticsReadModelState = pgTable("analytics_read_model_state", {
  readModel: text("read_model").primaryKey(),
  version: integer("version").notNull(),
  status: analyticsReadModelStatusEnum("status").notNull().default("building"),
  snapshotHighWater: json(
    "snapshot_high_water"
  ).$type<AnalyticsReadModelWatermark | null>(),
  catchUpWater: json(
    "catch_up_water"
  ).$type<AnalyticsReadModelWatermark | null>(),
  details: json("details").$type<Record<string, unknown> | null>(),
  lastReconciledAt: timestamp("last_reconciled_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ImageBackendGroup = typeof imageBackendGroup.$inferSelect;
export type NewImageBackendGroup = typeof imageBackendGroup.$inferInsert;
export type ImageBackendMember = typeof imageBackendMember.$inferSelect;
export type NewImageBackendMember = typeof imageBackendMember.$inferInsert;
export type ImageBackendMemberApiConfig =
  typeof imageBackendMemberApiConfig.$inferSelect;
export type NewImageBackendMemberApiConfig =
  typeof imageBackendMemberApiConfig.$inferInsert;
export type ImageBackendMemberApiAdapterVersion =
  typeof imageBackendMemberApiAdapterVersion.$inferSelect;
export type NewImageBackendMemberApiAdapterVersion =
  typeof imageBackendMemberApiAdapterVersion.$inferInsert;
export type ImageBackendMemberAdobeConfig =
  typeof imageBackendMemberAdobeConfig.$inferSelect;
export type NewImageBackendMemberAdobeConfig =
  typeof imageBackendMemberAdobeConfig.$inferInsert;
export type AdobeCredentialHealth = typeof adobeCredentialHealth.$inferSelect;
export type NewAdobeCredentialHealth =
  typeof adobeCredentialHealth.$inferInsert;
export type AdobeCredentialEvaluation =
  typeof adobeCredentialEvaluation.$inferSelect;
export type NewAdobeCredentialEvaluation =
  typeof adobeCredentialEvaluation.$inferInsert;
export type AdobeCredentialIncident =
  typeof adobeCredentialIncident.$inferSelect;
export type NewAdobeCredentialIncident =
  typeof adobeCredentialIncident.$inferInsert;
export type AdobeCredentialNotificationDelivery =
  typeof adobeCredentialNotificationDelivery.$inferSelect;
export type NewAdobeCredentialNotificationDelivery =
  typeof adobeCredentialNotificationDelivery.$inferInsert;
export type ImageBackendMemberGroup =
  typeof imageBackendMemberGroup.$inferSelect;
export type NewImageBackendMemberGroup =
  typeof imageBackendMemberGroup.$inferInsert;
export type ImageBackendMemberLease =
  typeof imageBackendMemberLease.$inferSelect;
export type NewImageBackendMemberLease =
  typeof imageBackendMemberLease.$inferInsert;
export type ImageBackendMemberSchedulerMetric =
  typeof imageBackendMemberSchedulerMetric.$inferSelect;
export type NewImageBackendMemberSchedulerMetric =
  typeof imageBackendMemberSchedulerMetric.$inferInsert;
// ============================================
// External API Keys
// ============================================
export const externalApiKey = pgTable("external_api_key", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("Default API key"),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  // AES-256-GCM 版本化密文，仅供本人登录后的管理页面恢复复制；旧记录为空。
  encryptedKey: text("encrypted_key"),
  lastFour: text("last_four").notNull(),
  generationGroupId: text("generation_group_id").references(
    () => imageBackendGroup.id,
    { onDelete: "set null" }
  ),
  creditLimit: numeric("credit_limit", {
    precision: 18,
    scale: 2,
    mode: "number",
  }),
  creditsUsed: numeric("credits_used", {
    precision: 18,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  lastUsedAt: timestamp("last_used_at"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ExternalApiKey = typeof externalApiKey.$inferSelect;
export type NewExternalApiKey = typeof externalApiKey.$inferInsert;

// ============================================
// Image Generation
// ============================================

export const generationStatusEnum = pgEnum("generation_status", [
  "pending",
  "completed",
  "failed",
]);

export const generation = pgTable(
  "generation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // 新生成任务显式写 true，作为普通持久化路径的不可变活动证据；NULL 仅表示
    // 无法证明可见性的历史记录。
    usageLogVisible: boolean("usage_log_visible"),
    prompt: text("prompt").notNull(),
    revisedPrompt: text("revised_prompt"),
    model: text("model").notNull(),
    size: text("size").notNull().default("1024x1024"),
    status: generationStatusEnum("status").notNull().default("pending"),
    storageKey: text("storage_key"),
    storageBucket: text("storage_bucket").default("generations"),
    fileSize: integer("file_size"),
    creditsConsumed: numeric("credits_consumed", {
      precision: 18,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    error: text("error"),
    // 新图片任务与视频任务一致地固定 API 适配版本；迁移前历史缺少可靠成员证据时为空。
    apiAdapterMemberId: text("api_adapter_member_id"),
    apiAdapterVersionId: text("api_adapter_version_id"),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    // 画廊/历史/计数与每次读触发的 pending 过期维护扫描:在 686MB 的 generation 表上,
    // 把按 user / status 维度的查询从顺序扫转为有序索引扫描(迁移 0035)。
    index("generation_user_id_created_at_idx").on(
      table.userId,
      table.createdAt
    ),
    index("generation_status_created_at_idx").on(table.status, table.createdAt),
    check(
      "generation_api_adapter_pair_check",
      sql`(${table.apiAdapterMemberId} IS NULL) = (${table.apiAdapterVersionId} IS NULL)`
    ),
    foreignKey({
      name: "generation_api_adapter_version_fk",
      columns: [table.apiAdapterMemberId, table.apiAdapterVersionId],
      foreignColumns: [
        imageBackendMemberApiAdapterVersion.memberIdSnapshot,
        imageBackendMemberApiAdapterVersion.id,
      ],
    }),
    // 另有 generation_metadata_gin_idx —— metadata 的 jsonb_path_ops GIN 表达式索引,
    // 加速画廊 draft/upload 的 @? jsonpath 过滤。表达式索引以迁移 0035 的 SQL 为准
    // (Drizzle 对 (metadata::jsonb) 这类表达式索引声明支持不稳定,故此处仅注释登记)。
  ]
);

export type Generation = typeof generation.$inferSelect;
export type NewGeneration = typeof generation.$inferInsert;
export type GenerationStatus = (typeof generationStatusEnum.enumValues)[number];

// ============================================
// 工单系统类型导出
// ============================================

export type Ticket = typeof ticket.$inferSelect;
export type NewTicket = typeof ticket.$inferInsert;

export type TicketMessage = typeof ticketMessage.$inferSelect;
export type NewTicketMessage = typeof ticketMessage.$inferInsert;

/** 用户角色类型 */
export type UserRole = (typeof userRoleEnum.enumValues)[number];

/** 工单类别类型 */
export type TicketCategory = (typeof ticketCategoryEnum.enumValues)[number];

/** 工单优先级类型 */
export type TicketPriority = (typeof ticketPriorityEnum.enumValues)[number];

/** 工单状态类型 */
export type TicketStatus = (typeof ticketStatusEnum.enumValues)[number];

// ============================================
// MCP User API Keys
// ============================================
/**
 * MCP 用户密钥表 - 终端用户通过 MCP 协议访问图像生成等功能时使用的认证密钥
 *
 * 独立于 external_api_key（v1 API），二者互不干扰：
 * - external_api_key: 面向 v1 RESTful API
 * - mcp_api_key: 面向 MCP JSON-RPC 协议（用户侧）
 *
 * @field id - 唯一标识符
 * @field userId - 所属用户
 * @field name - 用户可自定义的 key 名称
 * @field keyPrefix - key 前缀（如 "mcp_"），用于快速识别类型
 * @field keyHash - SHA-256 哈希（唯一索引，鉴权热路径查找）
 * @field lastFour - 末四位明文（列表展示时脱敏显示）
 * @field isActive - 是否启用
 * @field lastUsedAt - 最近使用时间
 * @field revokedAt - 撤销时间（撤销后不可恢复）
 * @field createdAt - 创建时间
 * @field updatedAt - 更新时间
 */
export const mcpApiKey = pgTable(
  "mcp_api_key",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Default MCP key"),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    lastFour: text("last_four").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("mcp_api_key_key_hash_idx").on(table.keyHash),
    index("mcp_api_key_user_id_idx").on(table.userId),
  ]
);

export type McpApiKey = typeof mcpApiKey.$inferSelect;
export type NewMcpApiKey = typeof mcpApiKey.$inferInsert;
