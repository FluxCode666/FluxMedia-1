/**
 * 平台媒体模型目录的 DB-free 构建器。
 *
 * 职责：按套餐、可达分组和统一成员显式模型能力生成 image/video 目录；
 * 模型名称只用于能力匹配与媒体分类，不参与后端类型或调度策略分流。
 */
import { isFireflyVideoModelId } from "@repo/shared/adobe/firefly-direct/video-catalog";
import {
  isPlanAtLeast,
  SUBSCRIPTION_PLANS,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";

/** 平台模型目录最终公开的单条模型。 */
export interface PlatformModelCatalogItem {
  id: string;
}

/** 平台只公开图片与视频模型。 */
export interface PlatformModelCatalog {
  image: PlatformModelCatalogItem[];
  video: PlatformModelCatalogItem[];
}

/** 构建目录所需的动态套餐能力门槛。 */
export interface PlatformModelCapabilityMinimums {
  backendGroupsSelect: SubscriptionPlan;
  externalModelsList: SubscriptionPlan;
  externalImagesGenerate: SubscriptionPlan;
  externalVideosGenerate: SubscriptionPlan;
}

/** 分组中与平台公开可达性有关的字段。 */
export interface PlatformModelCatalogGroup {
  id: string;
  isEnabled: boolean;
  isDefault: boolean;
  isUserSelectable: boolean;
  minPlan: SubscriptionPlan;
}

/** 统一成员中与媒体目录有关的非敏感字段。 */
export interface PlatformModelCatalogMember {
  groupIds: readonly string[];
  supportedModelIds: readonly string[];
  isEnabled: boolean;
  status: string;
}

/** 平台媒体目录的完整事实输入。 */
export interface PlatformModelCatalogSource {
  capabilityMinimums: PlatformModelCapabilityMinimums;
  groups: readonly PlatformModelCatalogGroup[];
  members: readonly PlatformModelCatalogMember[];
}

const NON_EXECUTABLE_IMAGE_MODEL_IDS = new Set(["auto", "default", "unknown"]);

/** 向目录集合加入合法且大小写无关去重的模型 ID。 */
function addModel(models: Map<string, string>, value: string): void {
  const id = value.trim();
  if (!id || id.length > 120) return;
  const key = id.toLowerCase();
  if (!models.has(key)) models.set(key, id);
}

/** 将模型集合稳定排序并转为公开 DTO。 */
function toSortedItems(
  models: ReadonlyMap<string, string>
): PlatformModelCatalogItem[] {
  return Array.from(models, ([normalizedId, id]) => ({ normalizedId, id }))
    .sort((left, right) => left.normalizedId.localeCompare(right.normalizedId))
    .map(({ id }) => ({ id }));
}

/** 计算每个可达分组对应的套餐集合。 */
function buildReachablePlans(
  source: PlatformModelCatalogSource
): Map<string, Set<SubscriptionPlan>> {
  const result = new Map<string, Set<SubscriptionPlan>>();
  for (const group of source.groups) {
    if (!group.isEnabled) continue;
    for (const plan of SUBSCRIPTION_PLANS) {
      if (
        !isPlanAtLeast(plan, group.minPlan) ||
        !isPlanAtLeast(plan, source.capabilityMinimums.externalModelsList)
      ) {
        continue;
      }
      const reachable =
        group.isDefault ||
        (group.isUserSelectable &&
          isPlanAtLeast(plan, source.capabilityMinimums.backendGroupsSelect));
      if (!reachable) continue;
      const plans = result.get(group.id) ?? new Set<SubscriptionPlan>();
      plans.add(plan);
      result.set(group.id, plans);
    }
  }
  return result;
}

/**
 * 从统一成员事实构建平台媒体模型目录。
 *
 * @param source 套餐能力、分组和统一成员事实。
 * @returns 仅包含至少一条真实可达调用路径的 image/video 模型。
 */
export function buildPlatformModelCatalog(
  source: PlatformModelCatalogSource
): PlatformModelCatalog {
  const plansByGroupId = buildReachablePlans(source);
  const imageModels = new Map<string, string>();
  const videoModels = new Map<string, string>();

  for (const member of source.members) {
    if (!member.isEnabled || member.status === "error") continue;
    const reachablePlans = new Set<SubscriptionPlan>();
    for (const groupId of member.groupIds) {
      for (const plan of plansByGroupId.get(groupId) ?? []) {
        reachablePlans.add(plan);
      }
    }
    if (reachablePlans.size === 0) continue;

    for (const modelId of member.supportedModelIds) {
      if (isFireflyVideoModelId(modelId)) {
        if (
          Array.from(reachablePlans).some((plan) =>
            isPlanAtLeast(
              plan,
              source.capabilityMinimums.externalVideosGenerate
            )
          )
        ) {
          addModel(videoModels, modelId);
        }
      } else if (
        Array.from(reachablePlans).some((plan) =>
          isPlanAtLeast(plan, source.capabilityMinimums.externalImagesGenerate)
        )
      ) {
        addModel(imageModels, modelId);
      }
    }
  }

  return {
    image: toSortedItems(imageModels),
    video: toSortedItems(videoModels),
  };
}

/** 判断模型 ID 是否能安全用于快速集成的真实图像请求。 */
export function isConcretePlatformImageModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return Boolean(normalized && !NON_EXECUTABLE_IMAGE_MODEL_IDS.has(normalized));
}
