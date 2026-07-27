/**
 * 官网首页生成 SLA 统计的 UOL late binding。
 *
 * 使用方：uol-bindings 启动桶与聚焦集成测试；负责把 Web 运行时生成统计映射为
 * shared 严格 DTO，并注册为 system-only operation 的真实执行体。
 */

import {
  bindExecute,
  type OperationContext,
  type Principal,
} from "@repo/shared/uol";
import {
  type HomepageGenerationSlaStatsOutput,
  homepageGenerationSlaStatsOutputSchema,
} from "@repo/shared/uol/operations";
import { getRecentGenerationSlaStats } from "@/features/image-generation/sla";

/** 首页可靠性 late binding 可注入的 Web 运行时读取依赖。 */
export type HomepageReliabilityBindingDependencies = {
  loadGenerationSlaStats: () => Promise<HomepageGenerationSlaStatsOutput>;
};

const defaultDependencies: HomepageReliabilityBindingDependencies = {
  loadGenerationSlaStats: () => getRecentGenerationSlaStats(1000),
};

/**
 * 绑定首页生成 SLA 统计的真实执行体。
 *
 * @param dependencies - 可选统计读取器；生产使用固定窗口的运行时服务，测试可替换。
 * @returns 无返回值。
 * @sideEffects 替换 registry 中统计 operation 的 execute；后续每次调用实时读取事实源。
 * @failure operation 尚未注册时同步抛错；读取或 strict parse 失败时拒绝后续调用，
 * 由首页负责区块级降级。
 */
export function bindHomepageReliabilityOperation(
  dependencies: Partial<HomepageReliabilityBindingDependencies> = {}
): void {
  const loadGenerationSlaStats =
    dependencies.loadGenerationSlaStats ??
    defaultDependencies.loadGenerationSlaStats;

  bindExecute(
    "analytics.getHomepageGenerationSlaStats",
    async (
      _input: Record<string, never>,
      _principal: Principal,
      _ctx: OperationContext
    ) =>
      homepageGenerationSlaStatsOutputSchema.parse(
        await loadGenerationSlaStats()
      )
  );
}
