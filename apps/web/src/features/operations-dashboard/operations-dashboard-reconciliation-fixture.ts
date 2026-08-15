/**
 * 运营总览端到端口径对账夹具的稳定公共组合入口。
 *
 * 使用方：reconciliation 集成测试。冻结事实与各领域 reader 已下沉到专用模块，
 * 本文件继续提供原导出路径，使汇总、分页明细与真实 CSV worker 调用保持兼容。
 */
import type { OperationsExportType } from "@repo/shared/operations-dashboard/contracts";
import type { OperationsRangeBucket } from "@repo/shared/operations-dashboard/range";

import type { OperationsCommercialSnapshotReader } from "./commercial-repository";
import type { OperationsContentSnapshotReader } from "./content-repository";
import type { OperationsDetailRepository } from "./detail-repository";
import type { ClaimedOperationsExportTask } from "./export-task-repository";
import type { OperationsGrowthSnapshotReader } from "./growth-repository";
import { createReconciliationCommercialReader } from "./operations-dashboard-reconciliation-commercial-fixture";
import { createReconciliationContentReader } from "./operations-dashboard-reconciliation-content-fixture";
import { createReconciliationDetailRepository } from "./operations-dashboard-reconciliation-detail-fixture";
import {
  RECONCILIATION_AS_OF,
  RECONCILIATION_EPOCH,
  RECONCILIATION_QUERY,
  RECONCILIATION_TIME_ZONE,
} from "./operations-dashboard-reconciliation-facts";
import { createReconciliationGrowthReader } from "./operations-dashboard-reconciliation-growth-fixture";

export {
  RECONCILIATION_AS_OF,
  RECONCILIATION_EPOCH,
  RECONCILIATION_QUERY,
  RECONCILIATION_TIME_ZONE,
} from "./operations-dashboard-reconciliation-facts";

/**
 * 构造三类使用同一冻结范围、时区、epoch 与高水位的 worker 任务。
 *
 * @returns 增长、商业化和内容生产三类待处理任务；每次调用返回新数组。
 */
export function createReconciliationExportTasks(): ClaimedOperationsExportTask[] {
  const highWatermarks = {
    users: null,
    webVisits: null,
    outputs: null,
    paymentOrders: null,
    paymentLifecycle: null,
    creditContributions: null,
  };
  return (
    [
      "user_growth",
      "commercialization",
      "content_production",
    ] satisfies OperationsExportType[]
  ).map((exportType, index) => ({
    id: `reconciliation-${exportType}`,
    createdBy: "admin-reconciliation",
    exportType,
    query: RECONCILIATION_QUERY,
    timeZone: RECONCILIATION_TIME_ZONE,
    epochAppDate: RECONCILIATION_EPOCH.appDate,
    epochStartsAt: RECONCILIATION_EPOCH.startsAt,
    schemaVersion: 1,
    snapshotAt: RECONCILIATION_AS_OF,
    highWatermarks,
    leaseOwner: "worker-reconciliation",
    leaseToken: `lease-${index + 1}`,
    attemptCount: 1,
  }));
}

/**
 * 单组冻结事实对外暴露四个真实应用端口。
 *
 * @returns 增长、商业化、内容 reader 与同源明细 repository。
 */
export function createOperationsReconciliationFixture(): {
  growthReader: OperationsGrowthSnapshotReader;
  commercialReader: OperationsCommercialSnapshotReader;
  contentReader: OperationsContentSnapshotReader;
  detailRepository: OperationsDetailRepository;
} {
  return {
    growthReader: createReconciliationGrowthReader(),
    commercialReader: createReconciliationCommercialReader(),
    contentReader: createReconciliationContentReader(),
    detailRepository: createReconciliationDetailRepository(),
  };
}

/**
 * 把 resolved range 桶收窄为明细 selection 使用的闭区间日期。
 *
 * @param bucket 已解析范围桶的起止自然日。
 * @returns 仅包含 from、to 的新对象，不修改原桶。
 */
export function toDetailBucket(
  bucket: Pick<OperationsRangeBucket, "from" | "to">
): { from: string; to: string } {
  return { from: bucket.from, to: bucket.to };
}
