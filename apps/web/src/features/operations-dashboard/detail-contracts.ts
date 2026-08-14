/**
 * 运营明细查询、行模型和仓储端口契约。
 *
 * 使用方：明细 SQL 仓储、服务、CSV worker 和增长仓储高水位。该模块只声明类型，
 * 让业务契约与数据库 SQL、Zod 解析实现保持独立。
 */
import type { OperationsPaymentLifecycleStage } from "@repo/shared/operations-dashboard/contracts";
import type { SQL } from "drizzle-orm";

import type {
  OperationsGrowthActivityKind,
  OperationsGrowthSnapshotHeader,
} from "./growth-contracts";

/** 明细排序键；同一业务时间以稳定 ID 打破平局。 */
export type OperationsDetailCursor = {
  businessTime: Date;
  stableId: string;
};

/** 兼容增长调用方的明细游标别名。 */
export type OperationsGrowthDetailCursor = OperationsDetailCursor;

type OperationsGrowthDetailBaseQuery = {
  start: Date;
  end: Date;
  epochStart: Date;
  asOf: Date;
  cursor: OperationsDetailCursor | null;
  limit: number;
  highWatermarks?: OperationsDetailHighWatermarks;
};

/** 创建导出任务时冻结的各事实源稳定上界。 */
export type OperationsDetailHighWatermarks = {
  users: { createdAt: string; id: string } | null;
  webVisits: { createdAt: string; userId: string; appDate: string } | null;
  outputs: {
    createdAt: string;
    outputKind: string;
    sourceTaskId: string;
  } | null;
  paymentOrders: { createdAt: string; id: string } | null;
  paymentLifecycle: { recordedAt: string; id: string } | null;
  creditContributions: { projectedAt: string; transactionId: string } | null;
};

/** 新增账户明细查询，范围必须已在服务层截断至 epoch。 */
export type OperationsNewUserDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "users";
};

/** 累计账户明细只应用截止上界，刻意保留 epoch 前存量账户。 */
export type OperationsCumulativeUserDetailQuery =
  OperationsGrowthDetailBaseQuery & {
    kind: "cumulative_users";
  };

/** 周期活跃明细每用户只返回一行，因而行数可直接反算去重汇总。 */
export type OperationsActivityDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "activity";
  activityKind: OperationsGrowthActivityKind;
};

/** 单个注册日与精确目标日的 Cohort 明细查询。 */
export type OperationsCohortDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "cohort";
  targetStart: Date;
  targetEnd: Date;
};

/** 导出专用 Cohort 查询；每个留存日一次性覆盖完整注册日期范围。 */
export type OperationsCohortExportDetailQuery =
  OperationsGrowthDetailBaseQuery & {
    kind: "cohort_export";
    retentionDay: 1 | 7 | 30;
    timeZone: string;
  };

/** 增长明细的封闭查询类型。 */
export type OperationsGrowthDetailQuery =
  | OperationsCumulativeUserDetailQuery
  | OperationsNewUserDetailQuery
  | OperationsActivityDetailQuery
  | OperationsCohortDetailQuery
  | OperationsCohortExportDetailQuery;

/** 充值订单明细按订单创建业务时间筛选，每个平台订单只返回一行。 */
export type OperationsOrderDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "orders";
};

/** 已履约充值订单以 fulfilled_at 作为业务时间，并可限定单一币种。 */
export type OperationsFulfilledOrderDetailQuery =
  OperationsGrowthDetailBaseQuery & {
    kind: "fulfilled_orders";
    currency: string | null;
  };

/** 支付生命周期明细按不可变事件业务时间筛选，每个事件返回一行。 */
export type OperationsPaymentLifecycleDetailQuery =
  OperationsGrowthDetailBaseQuery & {
    kind: "payment_lifecycle";
  };

/** 支付阶段明细复用汇总阶段定义，每个平台订单只返回一行。 */
export type OperationsPaymentStageDetailQuery =
  OperationsGrowthDetailBaseQuery & {
    kind: "payment_stage";
    stage: OperationsPaymentLifecycleStage;
    currency: string | null;
  };

/** 商业化明细的封闭查询类型。 */
export type OperationsCommercialDetailQuery =
  | OperationsOrderDetailQuery
  | OperationsFulfilledOrderDetailQuery
  | OperationsPaymentLifecycleDetailQuery
  | OperationsPaymentStageDetailQuery;

/** 内容明细由成功产物事实驱动，detail 只改变媒体范围。 */
export type OperationsContentDetailQuery = OperationsGrowthDetailBaseQuery & {
  kind: "content";
  detail: "image_outputs" | "video_outputs" | "credit_usage";
};

/** 运营明细所有模块共享的封闭查询类型。 */
export type OperationsDetailQuery =
  | OperationsGrowthDetailQuery
  | OperationsCommercialDetailQuery
  | OperationsContentDetailQuery;

/** 可用汇总反算的最小用户明细行。 */
export type OperationsGrowthDetailRow = {
  kind?: "growth";
  userId: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
  businessTime: Date;
  retained: boolean | null;
};

/** 可同时服务页面核对和 CSV 的安全商业化明细行。 */
export type OperationsCommercialDetailRow = {
  kind: "orders" | "fulfilled_orders" | "payment_lifecycle" | "payment_stage";
  stableId: string;
  paymentOrderId: string;
  providerTradeNo: string | null;
  userId: string;
  currency: string;
  amountMinor: number;
  orderStatus: string;
  createdAt: Date;
  fulfilledAt: Date | null;
  businessTime: Date;
  eventType: string | null;
};

/** 成功产物及其精确净积分关联组成的安全内容明细行。 */
export type OperationsContentDetailRow = {
  kind: "content";
  stableId: string;
  taskId: string;
  userId: string;
  model: string;
  mediaType: "image" | "video";
  businessTime: Date;
  status: "completed";
  quantity: number;
  videoSeconds: number;
  netCredits: number;
  operationCreatedAtMismatch: boolean;
};

/** 运营明细数据库行的封闭联合类型。 */
export type OperationsDetailRow =
  | OperationsGrowthDetailRow
  | OperationsCommercialDetailRow
  | OperationsContentDetailRow;

/** 带 keyset 继续信息的增长明细页。 */
export type OperationsGrowthDetailPage = {
  rows: OperationsGrowthDetailRow[];
  nextCursor: OperationsGrowthDetailCursor | null;
};

/** 单个只读快照中的运营明细读取端口。 */
export interface OperationsGrowthDetailSnapshotReader {
  readHeader(): Promise<OperationsGrowthSnapshotHeader>;
  readRows(input: OperationsDetailQuery): Promise<OperationsDetailRow[]>;
}

/** 运营明细仓储端口；limit 包含用于判断下一页的额外一行。 */
export interface OperationsGrowthDetailRepository {
  withReadOnlySnapshot<T>(
    work: (reader: OperationsGrowthDetailSnapshotReader) => Promise<T>
  ): Promise<T>;
}

/** 统一明细仓储别名，供商业化、内容页面与 CSV worker 使用。 */
export type OperationsDetailRepository = OperationsGrowthDetailRepository;

/** 明细仓储依赖的最小 SQL 执行函数。 */
export type OperationsDetailExecuteSql = (query: SQL) => Promise<unknown>;

/** 生产与集成测试共用的最小只读事务数据库端口。 */
export interface OperationsGrowthDetailTransactionDatabase {
  transaction<T>(
    work: (transaction: { execute: OperationsDetailExecuteSql }) => Promise<T>,
    config: {
      isolationLevel: "repeatable read";
      accessMode: "read only";
    }
  ): Promise<T>;
}
