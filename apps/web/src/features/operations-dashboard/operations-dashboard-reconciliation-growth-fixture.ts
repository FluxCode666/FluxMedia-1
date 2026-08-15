/**
 * 运营总览增长 reconciliation reader 与共享活跃事实计算。
 *
 * 使用方：稳定组合入口、商业化 reader 与明细 repository。所有计算只读取冻结
 * 内存事实，并保持生产增长仓储的去重、Cohort 和自然日留存口径。
 */
import { addOperationsCalendarDays } from "@repo/shared/operations-dashboard/range";

import type {
  OperationsGrowthActivityKind,
  OperationsGrowthBucketQuery,
  OperationsGrowthCohortQuery,
  OperationsGrowthCohortRow,
  OperationsGrowthRangeQuery,
  OperationsGrowthSnapshotReader,
} from "./growth-repository";
import {
  type ReconciliationUserFact,
  reconciliationHeader,
  reconciliationOutputs,
  reconciliationPaymentOrders,
  reconciliationUsers,
  reconciliationVisits,
} from "./operations-dashboard-reconciliation-facts";
import {
  isReconciliationFactInRange,
  toReconciliationAppDate,
} from "./operations-dashboard-reconciliation-shared";

/**
 * 返回某类活跃事实的原始用户与业务时间。
 *
 * @param kind 登录、成功创作或成功充值活动类型。
 * @returns 未按范围过滤的事实副本；不修改冻结事实。
 */
function getReconciliationActivityFacts(
  kind: OperationsGrowthActivityKind
): Array<{ userId: string; businessTime: Date }> {
  if (kind === "login") {
    return reconciliationVisits.map((visit) => ({
      userId: visit.userId,
      businessTime: visit.visitedAt,
    }));
  }
  if (kind === "creation") {
    return reconciliationOutputs.map((output) => ({
      userId: output.userId,
      businessTime: output.businessTime,
    }));
  }
  return reconciliationPaymentOrders.flatMap((order) =>
    order.status === "fulfilled" && order.fulfilledAt
      ? [{ userId: order.userId, businessTime: order.fulfilledAt }]
      : []
  );
}

/**
 * 对范围内活跃事实按用户去重并保留首次业务时间。
 *
 * @param kind 活跃事实类型。
 * @param range 已解析的半开范围。
 * @returns 每个命中用户一行，业务时间为该范围内首次活动时间。
 */
export function getReconciliationDistinctActivity(
  kind: OperationsGrowthActivityKind,
  range: OperationsGrowthRangeQuery
): Array<{ userId: string; businessTime: Date }> {
  const indexed = new Map<string, Date>();
  for (const fact of getReconciliationActivityFacts(kind)) {
    if (!isReconciliationFactInRange(fact.businessTime, range)) continue;
    const existing = indexed.get(fact.userId);
    if (!existing || fact.businessTime < existing) {
      indexed.set(fact.userId, fact.businessTime);
    }
  }
  return Array.from(indexed, ([userId, businessTime]) => ({
    userId,
    businessTime,
  }));
}

/**
 * 根据事实计算单个趋势桶的去重用户数。
 *
 * @param kind 活跃事实类型。
 * @param bucket 已解析的趋势桶；填充桶没有 dataFrom。
 * @returns 范围内去重用户数，填充桶固定返回 0。
 */
function countReconciliationActivityBucket(
  kind: OperationsGrowthActivityKind,
  bucket: OperationsGrowthBucketQuery
): number {
  if (!bucket.dataFrom) return 0;
  return getReconciliationDistinctActivity(kind, {
    start: bucket.dataFrom,
    end: bucket.end,
  }).length;
}

/**
 * 判断用户是否在注册后的精确自然日产生过成功内容。
 *
 * @param user 冻结用户事实。
 * @param retentionDay 生产口径允许的 D1、D7 或 D30。
 * @returns 目标自然日存在至少一个成功产物时返回 true。
 */
export function isReconciliationUserRetained(
  user: ReconciliationUserFact,
  retentionDay: 1 | 7 | 30
): boolean {
  const targetDate = addOperationsCalendarDays(
    toReconciliationAppDate(user.createdAt),
    retentionDay
  );
  return reconciliationOutputs.some(
    (output) =>
      output.userId === user.id &&
      toReconciliationAppDate(output.businessTime) === targetDate
  );
}

/**
 * 计算与生产 SQL 相同的 Cohort 稀疏聚合行。
 *
 * @param input 注册时间半开范围与对账高水位。
 * @returns 按 cohortDate 升序排列的稀疏聚合行。
 */
function readReconciliationCohortFacts(
  input: OperationsGrowthCohortQuery
): OperationsGrowthCohortRow[] {
  const indexed = new Map<string, ReconciliationUserFact[]>();
  for (const user of reconciliationUsers) {
    if (!isReconciliationFactInRange(user.createdAt, input)) continue;
    const date = toReconciliationAppDate(user.createdAt);
    indexed.set(date, [...(indexed.get(date) ?? []), user]);
  }
  return Array.from(indexed, ([cohortDate, cohortUsers]) => ({
    cohortDate,
    cohortSize: cohortUsers.length,
    retainedD1: cohortUsers.filter((user) =>
      isReconciliationUserRetained(user, 1)
    ).length,
    retainedD7: cohortUsers.filter((user) =>
      isReconciliationUserRetained(user, 7)
    ).length,
    retainedD30: cohortUsers.filter((user) =>
      isReconciliationUserRetained(user, 30)
    ).length,
  })).sort((left, right) => left.cohortDate.localeCompare(right.cohortDate));
}

/**
 * 生成增长汇总服务使用的真实端口 reader。
 *
 * @returns 只读取冻结增长事实的异步 reader，无外部副作用。
 */
export function createReconciliationGrowthReader(): OperationsGrowthSnapshotReader {
  return {
    async readHeader() {
      return reconciliationHeader;
    },
    async readCumulativeUserCount(end) {
      return reconciliationUsers.filter((user) => user.createdAt < end).length;
    },
    async readNewUserCount(input) {
      return reconciliationUsers.filter((user) =>
        isReconciliationFactInRange(user.createdAt, input)
      ).length;
    },
    async readActivityUserCount(kind, input) {
      return getReconciliationDistinctActivity(kind, input).length;
    },
    async readNewUserSeries(buckets) {
      return buckets.flatMap((bucket) =>
        bucket.dataFrom
          ? [
              {
                bucketKey: bucket.key,
                userCount: reconciliationUsers.filter((user) =>
                  isReconciliationFactInRange(user.createdAt, {
                    start: bucket.dataFrom as Date,
                    end: bucket.end,
                  })
                ).length,
              },
            ]
          : []
      );
    },
    async readActivitySeries(kind, buckets) {
      return buckets.flatMap((bucket) =>
        bucket.dataFrom
          ? [
              {
                bucketKey: bucket.key,
                userCount: countReconciliationActivityBucket(kind, bucket),
              },
            ]
          : []
      );
    },
    async readCohorts(input) {
      return readReconciliationCohortFacts(input);
    },
  };
}
