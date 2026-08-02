/**
 * 管理端模型配置快照的可注入读取服务。
 *
 * 使用方是后续 UOL operation binding；本模块并发读取三项严格持久化事实与运行时目录，
 * 只允许运行时目录故障降级，再委托唯一 DB-free 目录构建器装配响应。
 */
import type { ModelConfigurationSnapshot } from "@repo/shared/model-marketplace";
import { isPrincipalSuperAdmin, type Principal } from "@repo/shared/uol";

import {
  buildModelConfigurationSnapshot,
  type ModelConfigurationCatalogInput,
  type RuntimeModelCatalog,
  type RuntimeModelCatalogResult,
} from "./catalog";

/** 管理配置读取服务的全部外部依赖端口。 */
export type ModelConfigurationReadDependencies = {
  loadImagePricing: () => Promise<unknown>;
  loadVideoPricing: () => Promise<unknown>;
  loadMarketplaceConfig: () => Promise<unknown>;
  loadVideoCapabilityOverrides: () => Promise<unknown>;
  loadRuntimeCatalog: () => Promise<RuntimeModelCatalog>;
  buildCoverUrl: ModelConfigurationCatalogInput["buildCoverUrl"];
};

/**
 * 把运行时目录读取结果转换为显式可降级状态。
 *
 * @param loadRuntimeCatalog - 当前平台可达 image/video 模型目录读取器。
 * @returns 成功时携带目录，任何读取失败均返回 unavailable 且不暴露原始错误。
 * @sideEffects 调用一次注入的运行时读取器；不记录或持久化异常。
 * @failure 自身不拒绝 Promise；该事实源是管理读取唯一允许降级的依赖。
 */
async function loadRuntimeCatalogResult(
  loadRuntimeCatalog: () => Promise<RuntimeModelCatalog>
): Promise<RuntimeModelCatalogResult> {
  try {
    return { status: "ready", catalog: await loadRuntimeCatalog() };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * 读取并构建当前管理端模型配置快照。
 *
 * @param principal - UOL 网关交付的完整调用者身份。
 * @param dependencies - 价格、展示配置、运行时目录和封面 URL 的注入端口。
 * @returns 严格共享 DTO；仅会话 super_admin 的 canEdit 为 true。
 * @sideEffects 并发调用四个读取器；仅封面构建器可能在装配期间被同步调用。
 * @failure 图像价格、视频价格、展示配置或最终 DTO 错误直接拒绝；运行时目录错误降级为
 * unavailable，不会掩盖同时发生的严格事实源错误。
 */
export async function readModelConfiguration(
  principal: Principal,
  dependencies: ModelConfigurationReadDependencies
): Promise<ModelConfigurationSnapshot> {
  const [
    imagePricing,
    videoPricing,
    marketplaceConfig,
    videoCapabilityOverrides,
    runtimeCatalog,
  ] = await Promise.all([
    Promise.resolve().then(dependencies.loadImagePricing),
    Promise.resolve().then(dependencies.loadVideoPricing),
    Promise.resolve().then(dependencies.loadMarketplaceConfig),
    Promise.resolve().then(dependencies.loadVideoCapabilityOverrides),
    loadRuntimeCatalogResult(dependencies.loadRuntimeCatalog),
  ]);

  return buildModelConfigurationSnapshot({
    imagePricing,
    videoPricing,
    marketplaceConfig,
    videoCapabilityOverrides,
    runtimeCatalog,
    canEdit: isPrincipalSuperAdmin(principal),
    buildCoverUrl: dependencies.buildCoverUrl,
  });
}
