/**
 * 运营总览内容生产 reconciliation reader。
 *
 * 使用方：稳定组合入口。reader 从冻结成功产物事实计算生图、生视频、视频秒数
 * 与积分净用量，并保留生产内容汇总的百分之一积分整数口径。
 */
import type {
  OperationsContentSeriesRow,
  OperationsContentSnapshotReader,
} from "./content-repository";
import type { OperationsGrowthBucketQuery } from "./growth-repository";
import {
  reconciliationHeader,
  reconciliationOutputs,
} from "./operations-dashboard-reconciliation-facts";
import { isReconciliationFactInRange } from "./operations-dashboard-reconciliation-shared";

/**
 * 计算内容汇总服务的单个真实趋势桶。
 *
 * @param bucket 已解析的趋势桶；填充桶没有 dataFrom。
 * @returns 聚合行；填充桶返回 null，由服务层补零。
 */
function readReconciliationContentBucket(
  bucket: OperationsGrowthBucketQuery
): OperationsContentSeriesRow | null {
  if (!bucket.dataFrom) return null;
  const scoped = reconciliationOutputs.filter((output) =>
    isReconciliationFactInRange(output.businessTime, {
      start: bucket.dataFrom as Date,
      end: bucket.end,
    })
  );
  return {
    bucketKey: bucket.key,
    imageCount: scoped
      .filter((output) => output.mediaType === "image")
      .reduce((sum, output) => sum + output.quantity, 0),
    videoCount: scoped.filter((output) => output.mediaType === "video").length,
    videoSeconds: scoped.reduce((sum, output) => sum + output.videoSeconds, 0),
    creditHundredths: scoped.reduce(
      (sum, output) => sum + Math.round(output.netCredits * 100),
      0
    ),
    operationCreatedAtMismatchCount: 0,
  };
}

/**
 * 生成内容汇总服务使用的真实端口 reader。
 *
 * @returns 只读取冻结成功产物事实的异步 reader，无外部副作用。
 */
export function createReconciliationContentReader(): OperationsContentSnapshotReader {
  return {
    async readHeader() {
      return {
        ...reconciliationHeader,
        outputUsage: { version: 1, status: "ready" },
        creditUsage: { version: 1, status: "ready" },
      };
    },
    async readSeries(buckets) {
      return buckets.flatMap((bucket) => {
        const row = readReconciliationContentBucket(bucket);
        return row ? [row] : [];
      });
    },
  };
}
