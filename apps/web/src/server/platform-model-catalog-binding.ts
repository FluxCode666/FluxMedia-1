/**
 * 官网首页公开读操作的 UOL late binding。
 *
 * 使用方：uol-bindings 启动桶与聚焦集成测试；负责把 web 运行时模型目录与生成 SLA
 * 统计映射为 shared 严格 DTO，再注册为 system-only operation 的真实执行体。
 */

import {
  bindExecute,
  type OperationContext,
  type Principal,
} from "@repo/shared/uol";
import {
  type HomepageGenerationSlaStatsOutput,
  homepageGenerationSlaStatsOutputSchema,
  platformModelCatalogOutputSchema,
} from "@repo/shared/uol/operations";
import type { PlatformModelCatalog } from "@/features/external-api/platform-model-catalog";
import { loadPlatformModelCatalog } from "@/features/external-api/platform-model-catalog-service";
import { getRecentGenerationSlaStats } from "@/features/image-generation/sla";

/** 首页 late binding 可注入的 web 运行时读取依赖。 */
export type HomepageReadOperationBindingDependencies = {
  loadCatalog: () => Promise<PlatformModelCatalog>;
  loadGenerationSlaStats: () => Promise<HomepageGenerationSlaStatsOutput>;
};

const defaultDependencies: HomepageReadOperationBindingDependencies = {
  loadCatalog: loadPlatformModelCatalog,
  loadGenerationSlaStats: () => getRecentGenerationSlaStats(1000),
};

/**
 * 绑定首页平台公开模型目录与生成 SLA 统计的真实执行体。
 *
 * @param dependencies - 可选读取器；生产逐项使用运行时服务，测试可独立替换任一依赖。
 * @returns 无返回值；副作用是替换两个 registry operation 的 execute。
 * @remarks 每次调用 operation 都实时读取事实源，不引入跨请求缓存；两类结果均在
 * binding 边界执行 strict parse，避免 web 内部字段越过统一接口层。
 * @failure operation 尚未注册时同步抛错；真实读取与 strict parse 错误在后续调用
 * 对应 operation 时拒绝 Promise，由调用方负责区块级降级。
 */
export function bindHomepageReadOperations(
  dependencies: Partial<HomepageReadOperationBindingDependencies> = {}
): void {
  const loadCatalog =
    dependencies.loadCatalog ?? defaultDependencies.loadCatalog;
  const loadGenerationSlaStats =
    dependencies.loadGenerationSlaStats ??
    defaultDependencies.loadGenerationSlaStats;

  bindExecute(
    "externalApi.getPlatformModelCatalog",
    async (
      _input: Record<string, never>,
      _principal: Principal,
      _ctx: OperationContext
    ) => {
      const catalog = await loadCatalog();
      return platformModelCatalogOutputSchema.parse({
        image: catalog.image.map((model) => ({ id: model.id })),
        video: catalog.video.map((model) => ({ id: model.id })),
      });
    }
  );

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

/**
 * 兼容 uol-bindings 既有启动入口并绑定全部首页公开读操作。
 *
 * @param dependencies - 可选首页读取器；参数完整透传给统一绑定函数。
 * @returns 无返回值；副作用与 bindHomepageReadOperations 相同。
 * @remarks 保留旧导出名可避免修改用户正在并行编辑的 uol-bindings.ts。
 * @failure 完整透传 bindHomepageReadOperations 的注册失败，不吞掉初始化错误。
 */
export function bindPlatformModelCatalogOperation(
  dependencies: Partial<HomepageReadOperationBindingDependencies> = {}
): void {
  bindHomepageReadOperations(dependencies);
}
