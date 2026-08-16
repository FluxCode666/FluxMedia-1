/**
 * 管理端模型配置快照的可注入读取服务。
 *
 * 使用方是后续 UOL operation binding；本模块并发读取三项严格持久化事实与运行时目录，
 * 只允许运行时目录故障降级，再委托唯一 DB-free 目录构建器装配响应。
 */
import type {
  ModelConfigurationCategoryFilter,
  ModelConfigurationListInput,
  ModelConfigurationListOutput,
  ModelConfigurationSnapshot,
} from "@repo/shared/model-marketplace";
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
  loadVideoBillingModes: () => Promise<unknown>;
  loadVideoCreditsPerItem: () => Promise<unknown>;
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
    videoBillingModes,
    videoCreditsPerItem,
    marketplaceConfig,
    videoCapabilityOverrides,
    runtimeCatalog,
  ] = await Promise.all([
    Promise.resolve().then(dependencies.loadImagePricing),
    Promise.resolve().then(dependencies.loadVideoPricing),
    Promise.resolve().then(dependencies.loadVideoBillingModes),
    Promise.resolve().then(dependencies.loadVideoCreditsPerItem),
    Promise.resolve().then(dependencies.loadMarketplaceConfig),
    Promise.resolve().then(dependencies.loadVideoCapabilityOverrides),
    loadRuntimeCatalogResult(dependencies.loadRuntimeCatalog),
  ]);

  return buildModelConfigurationSnapshot({
    imagePricing,
    videoPricing,
    videoBillingModes,
    videoCreditsPerItem,
    marketplaceConfig,
    videoCapabilityOverrides,
    runtimeCatalog,
    canEdit: isPrincipalSuperAdmin(principal),
    buildCoverUrl: dependencies.buildCoverUrl,
  });
}

/**
 * 判断规范模型条目是否命中人工管理列表的查询条件。
 *
 * @param entry - 完整管理快照中的一条模型配置。
 * @param query - 已规范化的小写搜索词。
 * @param category - all、image 或 video。
 * @returns 同时命中媒体类别与模型 ID/名称搜索时为 true。
 * @sideEffects 无。
 * @failure 输入已由 UOL schema 校验，不抛错。
 */
function matchesModelConfigurationList(
  entry: ModelConfigurationSnapshot["entries"][number],
  query: string,
  category: ModelConfigurationCategoryFilter
): boolean {
  if (category !== "all" && entry.category !== category) return false;
  if (!query) return true;
  return (
    entry.configKey.toLocaleLowerCase().includes(query) ||
    entry.displayName.toLocaleLowerCase().includes(query)
  );
}

/**
 * 读取并分页当前管理员可见的模型配置列表。
 *
 * @param principal - UOL 网关交付的完整调用者身份。
 * @param input - 已校验的页码、页大小、搜索词和媒体类别。
 * @param dependencies - 与完整管理快照相同的事实读取端口。
 * @returns 精确总数、规范化有效页和当前页模型条目。
 * @sideEffects 读取一次完整规范模型快照；不改变任何配置。
 * @failure 严格事实源失败时原样拒绝；运行时目录失败仍由快照读取降级并显式标记。
 */
export async function readModelConfigurationPage(
  principal: Principal,
  input: ModelConfigurationListInput,
  dependencies: ModelConfigurationReadDependencies
): Promise<ModelConfigurationListOutput> {
  const snapshot = await readModelConfiguration(principal, dependencies);
  const query = input.query.trim().toLocaleLowerCase();
  const matchingEntries = snapshot.entries.filter((entry) =>
    matchesModelConfigurationList(entry, query, input.category)
  );
  const totalCount = matchingEntries.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / input.pageSize));
  const page = Math.min(input.page, totalPages);
  const offset = (page - 1) * input.pageSize;

  return {
    records: matchingEntries.slice(offset, offset + input.pageSize),
    page,
    pageSize: input.pageSize,
    totalCount,
    totalPages,
    canEdit: snapshot.canEdit,
    runtimeCatalogStatus: snapshot.runtimeCatalogStatus,
  };
}
