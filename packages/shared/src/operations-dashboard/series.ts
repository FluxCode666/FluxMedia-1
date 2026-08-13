/**
 * 运营总览完整桶与稀疏聚合点合并纯函数。
 *
 * 使用方：增长、商业化、内容和历史健康趋势服务。查询只需返回有事实的桶，本模块
 * 保留范围解析器生成的全部桶并补真实零值；视觉降采样明确留在 Web 图表层处理。
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
