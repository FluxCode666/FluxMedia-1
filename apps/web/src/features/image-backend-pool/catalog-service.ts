/**
 * 统一媒体号池的站内图片目录服务。
 *
 * 职责：按用户套餐筛选可达分组，将统一 `api | adobe` 成员显式
 * 声明的模型能力投影为创作页目录。目录只用于展示，提交时调度器仍会重新授权和获租。
 */
import {
  isPlanAtLeast,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import { toBackendGroupContentSafety } from "@repo/shared/image-backend/group-contract";
import { isLegacyVideoModelId } from "@repo/shared/image-backend/supported-models";
import { parseModelMarketplaceConfig } from "@repo/shared/model-marketplace";
import { canUsePlanCapability } from "@repo/shared/subscription/services/plan-capabilities";
import { getRuntimeSettingJson } from "@repo/shared/system-settings";
import { normalizeVideoModelId } from "@repo/shared/video-generation";

import { backendGroupService } from "./group-service";
import {
  buildImageGenerationModelCatalog,
  type ImageGenerationModelCatalog,
} from "./image-generation-model-catalog";
import { backendMemberService } from "./member-service";

/** 列出指定套餐可绑定到 API Key 的用户可选分组。 */
export async function listSelectableImageBackendGroups(
  plan: SubscriptionPlan
): Promise<Array<{ id: string; name: string; isEnabled: boolean }>> {
  const groups = await backendGroupService.listGroups();
  return groups
    .filter(
      (group) =>
        group.isEnabled &&
        group.isUserSelectable &&
        isPlanAtLeast(plan, group.minPlan)
    )
    .map((group) => ({
      id: group.id,
      name: group.name,
      isEnabled: group.isEnabled,
    }));
}

/** 返回与运行时默认路由同口径的分组计费快照。 */
export async function getEffectiveDefaultImageBackendGroup(
  plan: SubscriptionPlan
) {
  const groups = await backendGroupService.listGroups();
  const candidate =
    groups.find((group) => group.isEnabled && group.isDefault) ??
    groups.find((group) => group.isEnabled);
  if (!candidate || !isPlanAtLeast(plan, candidate.minPlan)) return null;
  return {
    id: candidate.id,
    name: candidate.name,
    isDefault: candidate.isDefault,
    contentSafetyEnabled: toBackendGroupContentSafety(candidate.contentSafety),
    imageCreditOverrides: candidate.imageCreditOverrides,
    videoCreditOverrides: candidate.videoCreditOverrides,
  };
}

/**
 * 为指定套餐构建图片分组与模型目录。
 *
 * @param plan 当前用户已规范化套餐。
 * @returns 仅包含可达分组和非视频模型；成员类型只决定传输能力，不决定候选。
 */
export async function getImageGenerationModelCatalogForPlan(
  plan: SubscriptionPlan
): Promise<ImageGenerationModelCatalog> {
  const [groups, members, canSelectGroups, marketplaceConfigValue] =
    await Promise.all([
      backendGroupService.listGroups(),
      backendMemberService.listMembers(),
      canUsePlanCapability(plan, "backendGroups.select"),
      getRuntimeSettingJson("MODEL_MARKETPLACE_CONFIG"),
    ]);
  const marketplaceConfig = parseModelMarketplaceConfig(marketplaceConfigValue);
  const eligibleGroups = groups.filter(
    (group) => group.isEnabled && isPlanAtLeast(plan, group.minPlan)
  );
  const effectiveDefault =
    eligibleGroups.find((group) => group.isDefault) ?? eligibleGroups[0];
  const visibleGroups = eligibleGroups.filter(
    (group) =>
      group.id === effectiveDefault?.id ||
      (canSelectGroups && group.isUserSelectable)
  );
  const visibleGroupIds = new Set(visibleGroups.map((group) => group.id));

  return buildImageGenerationModelCatalog({
    groups: visibleGroups.map((group) => ({
      id: group.id,
      name: group.name,
      isDefault: group.id === effectiveDefault?.id,
      imageCreditOverrides: group.imageCreditOverrides,
    })),
    videoModelIds: marketplaceConfig.customModels
      .filter((model) => model.category === "video")
      .map((model) => model.modelId),
    members: members
      .filter(
        (member) =>
          member.isEnabled &&
          member.status !== "error" &&
          member.groupIds.some((groupId) => visibleGroupIds.has(groupId))
      )
      .flatMap((member) =>
        member.groupIds
          .filter((groupId) => visibleGroupIds.has(groupId))
          .map((groupId) => ({
            groupId,
            type: member.type,
            supportedModelIds: member.supportedModelIds.filter(
              (modelId) =>
                !normalizeVideoModelId(modelId) &&
                !isLegacyVideoModelId(modelId)
            ),
          }))
      ),
  });
}
