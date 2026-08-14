/**
 * 运营增长领域的跨仓储共享契约。
 *
 * 使用方：增长汇总、商业化/内容快照和运营明细仓储。仅包含类型，不依赖数据库
 * schema 或执行实现，避免仓储模块之间形成反向依赖。
 */

/** 增长模块可核对的三类周期活跃事实。 */
export type OperationsGrowthActivityKind = "login" | "creation" | "payment";

/** 同一数据库快照捕获的查询时刻与不可变 epoch。 */
export type OperationsGrowthSnapshotHeader = {
  asOf: Date;
  epoch: { appDate: string; startsAt: Date } | null;
};
