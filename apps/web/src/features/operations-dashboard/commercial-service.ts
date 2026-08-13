/**
 * 运营总览商业化领域服务。
 *
 * 使用方：后续 operations overview UOL binding。服务在一个一致快照内计算订单
 * 阶段、按币种收入和两种付费转化，并显式保留上线前与不可比较状态。
 */
import {
  type CountComparison,
  type CurrencyAmountComparison,
  compareCountValues,
  compareCurrencyAmounts,
} from "@repo/shared/operations-dashboard/comparison";
import type {
  OperationsCurrencyAmount,
  OperationsDashboardQueryInput,
  OperationsRangeAvailability,
} from "@repo/shared/operations-dashboard/contracts";
import {
  type ResolvedOperationsDashboardRange,
  resolveOperationsDashboardRange,
} from "@repo/shared/operations-dashboard/range";
import { z } from "zod";

import {
  databaseOperationsCommercialRepository,
  type OperationsCommercialLifecycleCounts,
  type OperationsCommercialRepository,
  type OperationsCommercialRevenueRow,
  type OperationsCommercialSnapshotReader,
} from "./commercial-repository";
import type { OperationsGrowthRangeQuery } from "./growth-repository";

/** 商业化服务对 UOL binding 暴露的稳定错误类别。 */
export type OperationsCommercialServiceErrorCode =
  | "validation_error"
  | "not_ready"
  | "invalid_data";

/** 不携带 SQL、支付载荷或数据库行的商业化领域错误。 */
export class OperationsCommercialServiceError extends Error {
  /** 创建可由 UOL binding 稳定映射的错误。 */
  constructor(
    readonly code: OperationsCommercialServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OperationsCommercialServiceError";
  }
}

/** 单个订单阶段的当前值、上期值和比较状态。 */
export type OperationsCommercialCountMetric = {
  status: "value" | "pre_epoch";
  current: number;
  previous: number;
  comparison: CountComparison;
};

/** 单期付费转化的精确分子、分母及未格式化比率。 */
export type OperationsCommercialConversionValue = {
  paidUsers: number;
  activeUsers: number;
  rate: number | null;
};

/** 付费转化允许超过 100%，因为分子不是活跃用户集合的严格子集。 */
export type OperationsCommercialConversionComparison =
  | {
      status: "value";
      currentRate: number;
      previousRate: number;
      changePercentagePoints: number;
    }
  | {
      status: "not_comparable";
      reason:
        | "pre_epoch"
        | "zero_current_denominator"
        | "zero_previous_denominator";
    };

/** 一个付费转化口径的当期、上期和百分点比较。 */
export type OperationsCommercialConversionMetric = {
  status: "value" | "pre_epoch";
  current: OperationsCommercialConversionValue;
  previous: OperationsCommercialConversionValue;
  comparison: OperationsCommercialConversionComparison;
};

/** 按币种收入的两期精确值和独立比较。 */
export type OperationsCommercialRevenueMetric = {
  status: "value" | "pre_epoch";
  current: OperationsCurrencyAmount[];
  previous: OperationsCurrencyAmount[];
  comparison: CurrencyAmountComparison[];
  disclaimer: "不含线下退款";
};

/** 运营总览商业化模块的完整快照。 */
export type OperationsCommercialSnapshot = {
  generatedAt: string;
  range: ResolvedOperationsDashboardRange;
  lifecycle: {
    createdOrders: OperationsCommercialCountMetric;
    pendingOrders: OperationsCommercialCountMetric;
    paymentConfirmedOrders: OperationsCommercialCountMetric;
    paidNotFulfilledOrders: OperationsCommercialCountMetric;
    fulfilledOrders: OperationsCommercialCountMetric;
    failedOrders: OperationsCommercialCountMetric;
  };
  revenue: OperationsCommercialRevenueMetric;
  conversion: {
    fromCreation: OperationsCommercialConversionMetric;
    fromLogin: OperationsCommercialConversionMetric;
  };
};

const databaseCountSchema = z.number().int().safe().nonnegative();
const currencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/);

/** 校验仓储计数，避免损坏数值进入漏斗和转化计算。 */
function requireCount(value: number, field: string): number {
  if (!databaseCountSchema.safeParse(value).success) {
    throw new OperationsCommercialServiceError(
      "invalid_data",
      `${field}不是非负安全整数`
    );
  }
  return value;
}

/** 校验漏斗内部必然成立的集合关系。 */
function validateLifecycleCounts(
  value: OperationsCommercialLifecycleCounts
): OperationsCommercialLifecycleCounts {
  const parsed = {
    createdOrders: requireCount(value.createdOrders, "创建订单数"),
    pendingOrders: requireCount(value.pendingOrders, "待支付订单数"),
    paymentConfirmedOrders: requireCount(
      value.paymentConfirmedOrders,
      "支付成功订单数"
    ),
    paidNotFulfilledOrders: requireCount(
      value.paidNotFulfilledOrders,
      "待履约订单数"
    ),
    fulfilledOrders: requireCount(value.fulfilledOrders, "履约成功订单数"),
    failedOrders: requireCount(value.failedOrders, "失败订单数"),
  };
  if (
    parsed.pendingOrders > parsed.createdOrders ||
    parsed.paidNotFulfilledOrders > parsed.paymentConfirmedOrders
  ) {
    throw new OperationsCommercialServiceError(
      "invalid_data",
      "支付生命周期聚合结果无效"
    );
  }
  return parsed;
}

/** 校验收入并按币种字母序稳定排列，拒绝大小写归一后重复币种。 */
function normalizeRevenue(
  rows: readonly OperationsCommercialRevenueRow[]
): OperationsCurrencyAmount[] {
  const indexed = new Map<string, number>();
  for (const row of rows) {
    const parsedCurrency = currencyCodeSchema.safeParse(row.currency);
    if (
      !parsedCurrency.success ||
      !databaseCountSchema.safeParse(row.amountMinor).success
    ) {
      throw new OperationsCommercialServiceError(
        "invalid_data",
        "商业化收入聚合结果无效"
      );
    }
    const currency = parsedCurrency.data.toUpperCase();
    if (indexed.has(currency)) {
      throw new OperationsCommercialServiceError(
        "invalid_data",
        "商业化收入币种重复"
      );
    }
    indexed.set(currency, row.amountMinor);
  }
  return Array.from(indexed, ([currency, amountMinor]) => ({
    currency,
    amountMinor,
  })).sort((left, right) => left.currency.localeCompare(right.currency));
}

/** 为某期分子和分母建立可显示但不强制小于等于 100% 的转化值。 */
function createConversionValue(
  paidUsers: number,
  activeUsers: number
): OperationsCommercialConversionValue {
  return {
    paidUsers,
    activeUsers,
    rate: activeUsers === 0 ? null : paidUsers / activeUsers,
  };
}

/** 比较两期付费转化；上一周期跨 epoch 或任一分母为零时显式不可比较。 */
function compareConversion(input: {
  current: OperationsCommercialConversionValue;
  previous: OperationsCommercialConversionValue;
  previousAvailability: OperationsRangeAvailability;
}): OperationsCommercialConversionComparison {
  if (input.previousAvailability !== "available") {
    return { status: "not_comparable", reason: "pre_epoch" };
  }
  if (input.current.activeUsers === 0) {
    return {
      status: "not_comparable",
      reason: "zero_current_denominator",
    };
  }
  if (input.previous.activeUsers === 0) {
    return {
      status: "not_comparable",
      reason: "zero_previous_denominator",
    };
  }
  const currentRate = input.current.paidUsers / input.current.activeUsers;
  const previousRate = input.previous.paidUsers / input.previous.activeUsers;
  return {
    status: "value",
    currentRate,
    previousRate,
    changePercentagePoints: (currentRate - previousRate) * 100,
  };
}

/** 为当期与上期数量创建可区分上线前的阶段指标。 */
function createCountMetric(input: {
  current: number;
  previous: number;
  currentAvailable: boolean;
  previousAvailability: OperationsRangeAvailability;
}): OperationsCommercialCountMetric {
  return {
    status: input.currentAvailable ? "value" : "pre_epoch",
    current: input.current,
    previous: input.previous,
    comparison: compareCountValues({
      current: input.current,
      previous: input.previous,
      previousAvailability: input.previousAvailability,
    }),
  };
}

/** 范围位于 epoch 前时返回零，否则执行相应商业化读取。 */
async function readWhenAvailable<T>(
  range: OperationsGrowthRangeQuery,
  read: (range: OperationsGrowthRangeQuery) => Promise<T>,
  fallback: T
): Promise<T> {
  return range.start < range.end ? read(range) : fallback;
}

/** 将解析后的范围转换为仓储边界；不可用范围用空半开区间表达。 */
function toRangeQuery(input: {
  dataStart: Date | null;
  end: Date;
}): OperationsGrowthRangeQuery {
  return { start: input.dataStart ?? input.end, end: input.end };
}

/**
 * 使用调用方提供的 reader 组装商业化快照。
 *
 * @param input 不可信公共查询输入。
 * @param timeZone 服务端应用时区。
 * @param reader 已绑定到同一只读数据库事务的商业化 reader。
 * @returns 漏斗、收入、付费转化及比较结果。
 * @sideEffects 只读 reader，不提交事务或写入订单。
 */
export async function buildOperationsCommercialSnapshot(
  input: OperationsDashboardQueryInput | unknown,
  timeZone: string,
  reader: OperationsCommercialSnapshotReader
): Promise<OperationsCommercialSnapshot> {
  const header = await reader.readHeader();
  if (!header.epoch) {
    throw new OperationsCommercialServiceError(
      "not_ready",
      "运营统计起点尚未初始化"
    );
  }
  let range: ResolvedOperationsDashboardRange;
  try {
    range = resolveOperationsDashboardRange(input, {
      timeZone,
      asOf: header.asOf,
      epochDate: header.epoch.appDate,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new OperationsCommercialServiceError(
        "validation_error",
        "运营总览查询范围无效"
      );
    }
    throw error;
  }

  const currentRange = toRangeQuery(range);
  const previousRange = toRangeQuery(range.previous);
  const emptyLifecycle: OperationsCommercialLifecycleCounts = {
    createdOrders: 0,
    pendingOrders: 0,
    paymentConfirmedOrders: 0,
    paidNotFulfilledOrders: 0,
    fulfilledOrders: 0,
    failedOrders: 0,
  };
  const [
    currentLifecycleRaw,
    previousLifecycleRaw,
    currentRevenueRaw,
    previousRevenueRaw,
    currentPaidUsersRaw,
    previousPaidUsersRaw,
    currentCreationUsersRaw,
    previousCreationUsersRaw,
    currentLoginUsersRaw,
    previousLoginUsersRaw,
  ] = await Promise.all([
    readWhenAvailable(
      currentRange,
      (value) => reader.readLifecycleCounts(value),
      emptyLifecycle
    ),
    readWhenAvailable(
      previousRange,
      (value) => reader.readLifecycleCounts(value),
      emptyLifecycle
    ),
    readWhenAvailable(currentRange, (value) => reader.readRevenue(value), []),
    readWhenAvailable(previousRange, (value) => reader.readRevenue(value), []),
    readWhenAvailable(
      currentRange,
      (value) => reader.readPayingUserCount(value),
      0
    ),
    readWhenAvailable(
      previousRange,
      (value) => reader.readPayingUserCount(value),
      0
    ),
    readWhenAvailable(
      currentRange,
      (value) => reader.readActivityUserCount("creation", value),
      0
    ),
    readWhenAvailable(
      previousRange,
      (value) => reader.readActivityUserCount("creation", value),
      0
    ),
    readWhenAvailable(
      currentRange,
      (value) => reader.readActivityUserCount("login", value),
      0
    ),
    readWhenAvailable(
      previousRange,
      (value) => reader.readActivityUserCount("login", value),
      0
    ),
  ]);

  const currentLifecycle = validateLifecycleCounts(currentLifecycleRaw);
  const previousLifecycle = validateLifecycleCounts(previousLifecycleRaw);
  const currentRevenue = normalizeRevenue(currentRevenueRaw);
  const previousRevenue = normalizeRevenue(previousRevenueRaw);
  const currentPaidUsers = requireCount(currentPaidUsersRaw, "当期付费用户数");
  const previousPaidUsers = requireCount(
    previousPaidUsersRaw,
    "上期付费用户数"
  );
  const currentCreationUsers = requireCount(
    currentCreationUsersRaw,
    "当期创作活跃用户数"
  );
  const previousCreationUsers = requireCount(
    previousCreationUsersRaw,
    "上期创作活跃用户数"
  );
  const currentLoginUsers = requireCount(
    currentLoginUsersRaw,
    "当期登录活跃用户数"
  );
  const previousLoginUsers = requireCount(
    previousLoginUsersRaw,
    "上期登录活跃用户数"
  );
  const currentAvailable = range.dataStart !== null;
  const metric = (key: keyof OperationsCommercialLifecycleCounts) =>
    createCountMetric({
      current: currentLifecycle[key],
      previous: previousLifecycle[key],
      currentAvailable,
      previousAvailability: range.previous.availability,
    });
  const createConversionMetric = (
    currentActiveUsers: number,
    previousActiveUsers: number
  ): OperationsCommercialConversionMetric => {
    const current = createConversionValue(currentPaidUsers, currentActiveUsers);
    const previous = createConversionValue(
      previousPaidUsers,
      previousActiveUsers
    );
    return {
      status: currentAvailable ? "value" : "pre_epoch",
      current,
      previous,
      comparison: compareConversion({
        current,
        previous,
        previousAvailability: range.previous.availability,
      }),
    };
  };

  let revenueComparison: CurrencyAmountComparison[];
  try {
    revenueComparison = compareCurrencyAmounts({
      current: currentRevenue,
      previous: previousRevenue,
      previousAvailability: range.previous.availability,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new OperationsCommercialServiceError(
        "invalid_data",
        "商业化收入比较数据无效"
      );
    }
    throw error;
  }

  return {
    generatedAt: header.asOf.toISOString(),
    range,
    lifecycle: {
      createdOrders: metric("createdOrders"),
      pendingOrders: metric("pendingOrders"),
      paymentConfirmedOrders: metric("paymentConfirmedOrders"),
      paidNotFulfilledOrders: metric("paidNotFulfilledOrders"),
      fulfilledOrders: metric("fulfilledOrders"),
      failedOrders: metric("failedOrders"),
    },
    revenue: {
      status: currentAvailable ? "value" : "pre_epoch",
      current: currentRevenue,
      previous: previousRevenue,
      comparison: revenueComparison,
      disclaimer: "不含线下退款",
    },
    conversion: {
      fromCreation: createConversionMetric(
        currentCreationUsers,
        previousCreationUsers
      ),
      fromLogin: createConversionMetric(currentLoginUsers, previousLoginUsers),
    },
  };
}

/**
 * 读取商业化模块的独立一致快照。
 *
 * @sideEffects 仅开启只读 repeatable-read 事务。
 * @failure epoch 未初始化、范围非法或仓储数据损坏时抛稳定领域错误。
 */
export async function loadOperationsCommercialSnapshot(
  input: OperationsDashboardQueryInput | unknown,
  timeZone: string,
  repository: OperationsCommercialRepository = databaseOperationsCommercialRepository
): Promise<OperationsCommercialSnapshot> {
  return repository.withReadOnlySnapshot((reader) =>
    buildOperationsCommercialSnapshot(input, timeZone, reader)
  );
}
