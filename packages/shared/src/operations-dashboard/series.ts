/**
 * 运营总览完整桶与稀疏聚合点合并纯函数。
 *
 * 使用方：增长、商业化、内容和历史健康趋势服务。查询只需返回有事实的桶，本模块
 * 保留范围解析器生成的全部桶并补真实零值；视觉降采样使用本模块的确定性
 * 纯函数，保证图表不会改变汇总、明细或导出事实。
 */
import {
  operationsCountSchema,
  operationsCreditValueSchema,
} from "./contracts";
import type { OperationsRangeBucket } from "./range";

export type OperationsSeriesPoint = {
  bucketKey: string;
  value: number;
};

export type OperationsNumericSeriesBucket =
  | (OperationsRangeBucket & { status: "pre_epoch" })
  | (OperationsRangeBucket & { status: "value"; value: number });

/**
 * 视觉降采样后的序列点。
 *
 * `index` 指向原数组，tooltip 和键盘导航可据此回到完整真实 bucket。
 */
export type OperationsVisualSeriesPoint = {
  index: number;
  point: OperationsNumericSeriesBucket;
};

/**
 * 在固定点数内保留首点、末点与确定性极值。
 *
 * WHY：长范围趋势必须固定宽度展示，但不能把峰值或边界吞掉。算法先按
 * 等宽区间取绝对值最大的点，再用稳定索引排序；pre_epoch 点不参与极值，
 * 但首末边界仍保留。这个函数只减少视觉点，不修改原数组。
 *
 * @param series 完整服务端序列，按业务时间升序。
 * @param maxPoints 可视点上限，至少为 4，以容纳首末与最小/最大值。
 * @returns 带原始索引的确定性子集。
 * @throws RangeError 输入序列或上限无效。
 */
export function downsampleOperationsSeries(
  series: readonly OperationsNumericSeriesBucket[],
  maxPoints: number
): OperationsVisualSeriesPoint[] {
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 4) {
    throw new RangeError("运营趋势视觉降采样参数无效");
  }
  if (series.length <= maxPoints) {
    return series.map((point, index) => ({ index, point }));
  }

  const selected = new Set<number>([0, series.length - 1]);
  const bucketCount = Math.max(1, maxPoints - 2);
  let minPoint: { index: number; value: number } | null = null;
  let maxPoint: { index: number; value: number } | null = null;
  for (let index = 0; index < series.length; index += 1) {
    const point = series[index];
    if (point?.status !== "value") continue;
    if (
      !minPoint ||
      point.value < minPoint.value ||
      (point.value === minPoint.value && index < minPoint.index)
    ) {
      minPoint = { index, value: point.value };
    }
    if (
      !maxPoint ||
      point.value > maxPoint.value ||
      (point.value === maxPoint.value && index < maxPoint.index)
    ) {
      maxPoint = { index, value: point.value };
    }
  }
  if (minPoint) selected.add(minPoint.index);
  if (maxPoint) selected.add(maxPoint.index);
  const span = series.length / bucketCount;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * span);
    const end = Math.min(series.length, Math.floor((bucket + 1) * span));
    let winner: { index: number; value: number } | null = null;
    for (let index = start; index < Math.max(start + 1, end); index += 1) {
      const point = series[index];
      if (point?.status !== "value") continue;
      const value = Math.abs(point.value);
      if (
        !winner ||
        value > winner.value ||
        (value === winner.value && index < winner.index)
      ) {
        winner = { index, value };
      }
    }
    if (winner) selected.add(winner.index);
  }

  while (selected.size < maxPoints) {
    let candidate: { index: number; distance: number } | null = null;
    for (let index = 0; index < series.length; index += 1) {
      if (selected.has(index)) continue;
      let distance = Number.POSITIVE_INFINITY;
      for (const selectedIndex of selected) {
        distance = Math.min(distance, Math.abs(index - selectedIndex));
      }
      if (
        !candidate ||
        distance > candidate.distance ||
        (distance === candidate.distance && index < candidate.index)
      ) {
        candidate = { index, distance };
      }
    }
    if (!candidate) break;
    selected.add(candidate.index);
  }

  if (selected.size > maxPoints) {
    const required = new Set(
      [0, series.length - 1, minPoint?.index, maxPoint?.index].filter(
        (index): index is number => index !== undefined
      )
    );
    const interior = [...selected]
      .filter((index) => !required.has(index))
      .sort((left, right) => left - right);
    while (selected.size > maxPoints) {
      const index = interior.pop();
      if (index === undefined) break;
      selected.delete(index);
    }
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => ({ index, point: series[index] }))
    .filter((entry): entry is OperationsVisualSeriesPoint =>
      Boolean(entry.point)
    );
}

/**
 * 校验稀疏点并构造桶键到值的唯一映射。
 *
 * @param buckets 范围解析器生成的完整桶。
 * @param points SQL 聚合返回的稀疏点。
 * @param isValidValue 指标专属数值校验器。
 * @param errorMessage 非法值错误说明。
 * @returns 唯一合法点映射。
 * @throws RangeError 当点重复、范围外、位于 epoch 前或数值非法。
 */
function mapSparsePoints(
  buckets: readonly OperationsRangeBucket[],
  points: readonly OperationsSeriesPoint[],
  isValidValue: (value: number) => boolean,
  errorMessage: string
): Map<string, number> {
  const bucketsByKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  const values = new Map<string, number>();
  for (const point of points) {
    const bucket = bucketsByKey.get(point.bucketKey);
    if (!bucket) throw new RangeError("聚合桶不在规范化范围内");
    if (bucket.availability === "pre_epoch") {
      throw new RangeError("上线前桶不能包含聚合值");
    }
    if (values.has(point.bucketKey)) throw new RangeError("聚合桶重复");
    if (!isValidValue(point.value)) throw new RangeError(errorMessage);
    values.set(point.bucketKey, point.value);
  }
  return values;
}

/**
 * 将合法稀疏点合并进全部范围桶。
 *
 * @param buckets 完整范围桶。
 * @param values 已验证的稀疏值映射。
 * @returns 新数组；pre_epoch 无 value，可用和跨 epoch 桶缺失值补零。
 */
function mergeSeriesValues(
  buckets: readonly OperationsRangeBucket[],
  values: ReadonlyMap<string, number>
): OperationsNumericSeriesBucket[] {
  return buckets.map((bucket) => {
    if (bucket.availability === "pre_epoch") {
      return { ...bucket, status: "pre_epoch" as const };
    }
    return {
      ...bucket,
      status: "value" as const,
      value: values.get(bucket.key) ?? 0,
    };
  });
}

/**
 * 填充非负安全整数类型的数量 series。
 *
 * @param buckets 完整日、周或月桶。
 * @param points 稀疏数量聚合点。
 * @returns 保持桶顺序的新 series，不修改输入。
 */
export function fillOperationsCountSeries(
  buckets: readonly OperationsRangeBucket[],
  points: readonly OperationsSeriesPoint[]
): OperationsNumericSeriesBucket[] {
  const values = mapSparsePoints(
    buckets,
    points,
    (value) => operationsCountSchema.safeParse(value).success,
    "数量聚合值必须是安全非负整数"
  );
  return mergeSeriesValues(buckets, values);
}

/**
 * 填充允许正负有限小数的积分 series。
 *
 * @param buckets 完整日、周或月桶。
 * @param points 稀疏积分净值聚合点。
 * @returns 精确保留传入 number 的新 series，不做显示舍入或视觉降采样。
 */
export function fillOperationsCreditSeries(
  buckets: readonly OperationsRangeBucket[],
  points: readonly OperationsSeriesPoint[]
): OperationsNumericSeriesBucket[] {
  const values = mapSparsePoints(
    buckets,
    points,
    (value) => operationsCreditValueSchema.safeParse(value).success,
    "积分聚合值必须是有限数值"
  );
  return mergeSeriesValues(buckets, values);
}
