/**
 * 平台媒体模型目录运行时加载器。
 *
 * 职责：读取统一成员、分组和模型广场配置，再委托 DB-free 构建器；
 * 数据投影不包含 URL、API key、凭据、错误详情或媒体输入。
 */
import "server-only";

import { requestGoJson } from "@/server/go-backend-client";
import { parseModelMarketplaceConfig } from "@repo/shared/model-marketplace";
import { getRuntimeSettingJson } from "@repo/shared/system-settings";
import {
  buildPlatformModelCatalog,
  type PlatformModelCatalog,
  type PlatformModelCatalogGroup,
  type PlatformModelCatalogMember,
} from "./platform-model-catalog";

/** 目录服务可替换的数据读取边界。 */
export interface PlatformModelCatalogRepository {
  listGroups(): Promise<PlatformModelCatalogGroup[]>;
  listMembers(): Promise<PlatformModelCatalogMember[]>;
}

/** 目录服务的可注入依赖。 */
export interface PlatformModelCatalogServiceDependencies {
  repository: PlatformModelCatalogRepository;
  loadMarketplaceConfig(): Promise<unknown>;
}

/**
 * 实时加载平台媒体模型目录。
 *
 * @param overrides 测试或替代运行时事实源。
 * @returns 严格的 image/video 目录；读取失败直接上抛，不回退静态模型。
 */
export async function loadPlatformModelCatalog(
  overrides: Partial<PlatformModelCatalogServiceDependencies> = {}
): Promise<PlatformModelCatalog> {
  if (!overrides.repository) {
    return requestGoJson<PlatformModelCatalog>("/api/model-marketplace/runtime-catalog");
  }
  const repository = overrides.repository;
  const loadMarketplaceConfig =
    overrides.loadMarketplaceConfig ?? (() => getRuntimeSettingJson("MODEL_MARKETPLACE_CONFIG"));
  const [groups, members, marketplaceConfigValue] = await Promise.all([
    repository.listGroups(),
    repository.listMembers(),
    loadMarketplaceConfig(),
  ]);
  const marketplaceConfig = parseModelMarketplaceConfig(marketplaceConfigValue);
  return buildPlatformModelCatalog({
    groups,
    members,
    marketplaceConfig,
    customModels: marketplaceConfig.customModels,
  });
}
