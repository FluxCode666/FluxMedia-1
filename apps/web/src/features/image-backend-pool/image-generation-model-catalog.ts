/**
 * 创作页图片模型目录的 DB-free 构建器。
 *
 * 职责：将已授权分组与统一 `api | adobe` 成员的显式模型声明合并成
 * 可序列化目录。模型 ID 只是能力键；构建器不用前缀缩小成员类型。
 */
import { isFireflyVideoModelId } from "@repo/shared/adobe/firefly-direct/video-catalog";
import type { ImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";

/** 单个模型可由当前分组执行的图片动作。 */
export interface ImageGenerationModelCapabilities {
  generate: boolean;
  edit: boolean;
  mask: boolean;
}

/** 创作页可选的图片模型。 */
export interface ImageGenerationCatalogModel {
  id: string;
  capabilities: ImageGenerationModelCapabilities;
}

/** 一个可达分组的图片目录。 */
export interface ImageGenerationCatalogGroup {
  id: string;
  name: string;
  isDefault: boolean;
  imageCreditOverrides?: ImageCreditOverrides;
  models: ImageGenerationCatalogModel[];
}

/** 创作页服务端返回的完整目录。 */
export interface ImageGenerationModelCatalog {
  groups: ImageGenerationCatalogGroup[];
}

/** 目录所需的统一成员最小投影。 */
export interface ImageGenerationCatalogMember {
  groupId: string;
  type: "api" | "adobe";
  supportedModelIds: readonly string[];
}

/** 不包含凭据和 URL 的纯目录事实。 */
export interface ImageGenerationCatalogSource {
  groups: Array<{
    id: string;
    name: string;
    isDefault: boolean;
    imageCreditOverrides?: ImageCreditOverrides;
  }>;
  members: ImageGenerationCatalogMember[];
}

/** 成员类型只表达适配器能力；Adobe 图片适配器不传递 mask。 */
function getMemberCapabilities(
  memberType: ImageGenerationCatalogMember["type"]
): ImageGenerationModelCapabilities {
  return {
    generate: true,
    edit: true,
    mask: memberType === "api",
  };
}

/** 合并同一模型在多个成员上的图片动作能力。 */
function mergeCapabilities(
  current: ImageGenerationModelCapabilities,
  next: ImageGenerationModelCapabilities
): ImageGenerationModelCapabilities {
  return {
    generate: current.generate || next.generate,
    edit: current.edit || next.edit,
    mask: current.mask || next.mask,
  };
}

/**
 * 按分组合并显式模型能力。
 *
 * @param source 已完成套餐和状态筛选的分组、成员事实。
 * @returns 不含视频模型，且按模型 ID 稳定排序的目录。
 */
export function buildImageGenerationModelCatalog(
  source: ImageGenerationCatalogSource
): ImageGenerationModelCatalog {
  const membersByGroupId = new Map<string, ImageGenerationCatalogMember[]>();
  for (const member of source.members) {
    const members = membersByGroupId.get(member.groupId) ?? [];
    members.push(member);
    membersByGroupId.set(member.groupId, members);
  }

  return {
    groups: source.groups.map((group) => {
      const models = new Map<string, ImageGenerationCatalogModel>();
      for (const member of membersByGroupId.get(group.id) ?? []) {
        const capabilities = getMemberCapabilities(member.type);
        for (const rawModelId of member.supportedModelIds) {
          const modelId = rawModelId.trim();
          if (!modelId || isFireflyVideoModelId(modelId)) continue;
          const normalizedId = modelId.toLowerCase();
          const current = models.get(normalizedId);
          if (current) {
            current.capabilities = mergeCapabilities(
              current.capabilities,
              capabilities
            );
          } else {
            models.set(normalizedId, {
              id: modelId,
              capabilities: { ...capabilities },
            });
          }
        }
      }
      return {
        ...group,
        models: Array.from(models.values()).sort((left, right) =>
          left.id.localeCompare(right.id)
        ),
      };
    }),
  };
}
