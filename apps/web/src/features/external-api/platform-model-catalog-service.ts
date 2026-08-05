/**
 * 平台媒体模型目录运行时加载器。
 *
 * 职责：读取统一成员、分组和动态套餐能力矩阵，再委托 DB-free 构建器；
 * 数据投影不包含 URL、API key、Adobe cookie/token、错误详情或媒体输入。
 */
import "server-only";

import { db } from "@repo/database";
import { imageBackendGroup } from "@repo/database/schema";
import type { SubscriptionPlan } from "@repo/shared/config/subscription-plan";
import { parseModelMarketplaceConfig } from "@repo/shared/model-marketplace";
import type {
  PlanCapabilityKey,
  PlanCapabilityMatrix,
} from "@repo/shared/subscription/services/plan-capabilities";
import { getPlanCapabilityMatrix } from "@repo/shared/subscription/services/plan-capabilities";
import { getRuntimeSettingJson } from "@repo/shared/system-settings";
import { asc } from "drizzle-orm";

import { backendMemberService } from "@/features/image-backend-pool/member-service";

import {
  buildPlatformModelCatalog,
  type PlatformModelCapabilityMinimums,
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
  loadCapabilityMatrix(): Promise<PlanCapabilityMatrix>;
  loadMarketplaceConfig(): Promise<unknown>;
}

/** 从动态能力矩阵读取外部媒体目录所需的能力下限。 */
function toCapabilityMinimums(
  matrix: PlanCapabilityMatrix
): PlatformModelCapabilityMinimums {
  const feature = (key: PlanCapabilityKey): SubscriptionPlan =>
    matrix.features[key];
  return {
    externalModelsList: feature("externalApi.models.list"),
    externalImagesGenerate: feature("externalApi.images.generate"),
    externalVideosGenerate: feature("externalApi.videos.generate"),
  };
}

/** 默认数据库仓储，只读取媒体目录需要的白名单字段。 */
export const databasePlatformModelCatalogRepository: PlatformModelCatalogRepository =
  {
    async listGroups() {
      const rows = await db
        .select({
          id: imageBackendGroup.id,
          isEnabled: imageBackendGroup.isEnabled,
          isDefault: imageBackendGroup.isDefault,
          isUserSelectable: imageBackendGroup.isUserSelectable,
        })
        .from(imageBackendGroup)
        .orderBy(asc(imageBackendGroup.createdAt), asc(imageBackendGroup.id));
      return rows.map((row) => ({
        id: row.id,
        isEnabled: row.isEnabled,
        isDefault: row.isDefault,
        isUserSelectable: row.isUserSelectable,
      }));
    },
    async listMembers() {
      const members = await backendMemberService.listMembers();
      return members.map((member) => ({
        groupIds: member.groupIds,
        type: member.type,
        adobeMode: member.type === "adobe" ? member.config.mode : null,
        supportedModelIds: member.supportedModelIds,
        isEnabled: member.isEnabled,
        status: member.status,
      }));
    },
  };

/**
 * 实时加载平台媒体模型目录。
 *
 * @param overrides 测试或替代运行时事实源。
 * @returns 严格的 image/video 目录；读取失败直接上抛，不回退静态模型。
 */
export async function loadPlatformModelCatalog(
  overrides: Partial<PlatformModelCatalogServiceDependencies> = {}
): Promise<PlatformModelCatalog> {
  const repository =
    overrides.repository ?? databasePlatformModelCatalogRepository;
  const loadCapabilityMatrix =
    overrides.loadCapabilityMatrix ?? getPlanCapabilityMatrix;
  const loadMarketplaceConfig =
    overrides.loadMarketplaceConfig ??
    (() => getRuntimeSettingJson("MODEL_MARKETPLACE_CONFIG"));
  const [groups, members, capabilityMatrix, marketplaceConfigValue] =
    await Promise.all([
      repository.listGroups(),
      repository.listMembers(),
      loadCapabilityMatrix(),
      loadMarketplaceConfig(),
    ]);
  const marketplaceConfig = parseModelMarketplaceConfig(marketplaceConfigValue);
  return buildPlatformModelCatalog({
    groups,
    members,
    capabilityMinimums: toCapabilityMinimums(capabilityMatrix),
    customModels: marketplaceConfig.customModels,
  });
}
