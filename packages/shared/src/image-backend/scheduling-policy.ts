/**
 * 统一媒体后端调度策略。
 *
 * 职责：解析全局动态策略，并对数据库已经完成通用资格过滤后的候选快照做确定性排序。
 * 本模块 DB-free；实际获租必须在 PostgreSQL 事务中基于同一快照完成。
 */
import { z } from "zod";

/** 支持的全局媒体后端调度策略。 */
export const BACKEND_SCHEDULING_STRATEGIES = [
  "priority",
  "least_acquired",
  "least_load",
] as const;

/** 全局媒体后端调度策略。 */
export type BackendSchedulingStrategy =
  (typeof BACKEND_SCHEDULING_STRATEGIES)[number];

/** 调度策略严格输入 schema。 */
export const backendSchedulingStrategySchema = z.enum(
  BACKEND_SCHEDULING_STRATEGIES
);

/** 数据库调度器交给纯排序器的候选事实。 */
export interface BackendSchedulingCandidate {
  id: string;
  priority: number;
  isHealthy: boolean;
  leaseAcquiredCount: number;
  inflightCount: number;
  concurrency: number;
  lastAcquiredAt: Date | null;
  lastUsedAt: Date | null;
}

/**
 * 将运行时设置归一为合法策略。
 *
 * @param value 数据库或环境返回的不可信设置值。
 * @returns 合法策略；缺失、非法或非字符串值安全回退为 priority。
 */
export function normalizeBackendSchedulingStrategy(
  value: unknown
): BackendSchedulingStrategy {
  const result = backendSchedulingStrategySchema.safeParse(value);
  return result.success ? result.data : "priority";
}

/** 比较可空时间；从未获租/使用视为最久以前。 */
function compareOldestFirst(left: Date | null, right: Date | null): number {
  const leftTime = left?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightTime = right?.getTime() ?? Number.NEGATIVE_INFINITY;
  return leftTime - rightTime;
}

/** 比较成员健康桶，健康成员优先。 */
function compareHealth(
  left: BackendSchedulingCandidate,
  right: BackendSchedulingCandidate
): number {
  return Number(right.isHealthy) - Number(left.isHealthy);
}

/** 比较所有策略共用的最终稳定顺序。 */
function compareStableTail(
  left: BackendSchedulingCandidate,
  right: BackendSchedulingCandidate
): number {
  return (
    compareOldestFirst(left.lastAcquiredAt, right.lastAcquiredAt) ||
    compareOldestFirst(left.lastUsedAt, right.lastUsedAt) ||
    left.id.localeCompare(right.id)
  );
}

/** 用交叉相乘比较负载率，避免浮点口径漂移。 */
function compareLoadRatio(
  left: BackendSchedulingCandidate,
  right: BackendSchedulingCandidate
): number {
  return (
    left.inflightCount * right.concurrency -
    right.inflightCount * left.concurrency
  );
}

/**
 * 返回按指定策略排序后的候选副本。
 *
 * @param candidates 已经过启用、冷却、容量、分组与模型能力过滤的候选。
 * @param strategy 本次获租事务读取的策略快照。
 * @returns 新数组；不修改调用方持有的候选顺序。
 */
export function sortBackendSchedulingCandidates<
  T extends BackendSchedulingCandidate,
>(candidates: readonly T[], strategy: BackendSchedulingStrategy): T[] {
  return [...candidates].sort((left, right) => {
    if (strategy === "least_acquired") {
      return (
        left.leaseAcquiredCount - right.leaseAcquiredCount ||
        left.priority - right.priority ||
        compareHealth(left, right) ||
        compareStableTail(left, right)
      );
    }
    if (strategy === "least_load") {
      return (
        compareLoadRatio(left, right) ||
        left.priority - right.priority ||
        compareHealth(left, right) ||
        left.leaseAcquiredCount - right.leaseAcquiredCount ||
        compareStableTail(left, right)
      );
    }
    return (
      left.priority - right.priority ||
      compareHealth(left, right) ||
      compareStableTail(left, right)
    );
  });
}
