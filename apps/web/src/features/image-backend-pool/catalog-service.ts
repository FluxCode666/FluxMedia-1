/**
 * 统一媒体号池的站内图片目录服务。
 *
 * 职责：按分组访问开关筛选可达分组，将统一 `api | adobe` 成员显式
 * 声明的模型能力投影为创作页目录。目录只用于展示，提交时调度器仍会重新授权和获租。
 */
import { toBackendGroupContentSafety } from "@repo/shared/image-backend/group-contract";
import { isLegacyVideoModelId } from "@repo/shared/image-backend/supported-models";
import {
  isModelMarketplaceModelEnabled,
  parseModelMarketplaceConfig,
} from "@repo/shared/model-marketplace";
import { getRuntimeSettingJson } from "@repo/shared/system-settings";
import { normalizeVideoModelId } from "@repo/shared/video-generation";

import { backendGroupService } from "./group-service";
import {
  buildImageGenerationModelCatalog,
  type ImageGenerationModelCatalog,
} from "./image-generation-model-catalog";
import { backendMemberService } from "./member-service";

/** 列出用户可绑定到 API Key 的启用且允许用户选择的分组。 */
export async function listSelectableImageBackendGroups(): Promise<
  Array<{ id: string; name: string; isEnabled: boolean }>
> {
  const groups = await backendGroupService.listGroups();
  return groups
    .filter((group) => group.isEnabled && group.isUserSelectable)
    .map((group) => ({
      id: group.id,
      name: group.name,
      isEnabled: group.isEnabled,
    }));
}

/** 返回唯一默认分组的计费快照；不存在默认组时不按 priority 兜底。 */
export async function getEffectiveDefaultImageBackendGroup() {
  const groups = await backendGroupService.listGroups();
  const defaultGroups = groups.filter(
    (group) => group.isEnabled && group.isDefault
  );
  if (defaultGroups.length !== 1) return null;
  const [candidate] = defaultGroups;
  if (!candidate) return null;
  return {
    id: candidate.id,
    name: candidate.name,
    isDefault: candidate.isDefault,
    priority: candidate.priority,
    contentSafetyEnabled: toBackendGroupContentSafety(candidate.contentSafety),
    imageCreditOverrides: candidate.imageCreditOverrides,
    videoCreditOverrides: candidate.videoCreditOverrides,
  };
}

/**
 * 按当前运营状态构建图片分组与模型目录。
 *
 * @returns 仅包含可达分组和非视频模型；成员类型只决定传输能力，不决定候选。
 */
export async function getImageGenerationModelCatalog(): Promise<ImageGenerationModelCatalog> {
  const [groups, members, marketplaceConfigValue] = await Promise.all([
    backendGroupService.listGroups(),
    backendMemberService.listMembers(),
    getRuntimeSettingJson("MODEL_MARKETPLACE_CONFIG"),
  ]);
  const marketplaceConfig = parseModelMarketplaceConfig(marketplaceConfigValue);
  const defaultGroups = groups.filter(
    (group) => group.isEnabled && group.isDefault
  );
  const effectiveDefault = defaultGroups.length === 1 ? defaultGroups[0] : null;
  const visibleGroups = effectiveDefault
    ? groups.filter(
        (group) =>
          group.isEnabled &&
          (group.id === effectiveDefault.id || group.isUserSelectable)
      )
    : [];
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
    supportsQualityByModel: Object.fromEntries(
      [
        ...Object.entries(marketplaceConfig.imageByModel),
        ...marketplaceConfig.customModels
          .filter((model) => model.category === "image")
          .map((model) => [model.modelId, model] as const),
      ]
        .filter(([, model]) => model.supportsQuality === true)
        .map(([modelId]) => [modelId, true])
    ),
    supportsAutoSizeByModel: Object.fromEntries(
      [
        ...Object.entries(marketplaceConfig.imageByModel),
        ...marketplaceConfig.customModels
          .filter((model) => model.category === "image")
          .map((model) => [model.modelId, model] as const),
      ]
        .filter(([, model]) => model.supportsAutoSize === true)
        .map(([modelId]) => [modelId, true])
    ),
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
                isModelMarketplaceModelEnabled(
                  marketplaceConfig,
                  "image",
                  modelId
                ) &&
                !normalizeVideoModelId(modelId) &&
                !isLegacyVideoModelId(modelId)
            ),
          }))
      ),
  });
}
