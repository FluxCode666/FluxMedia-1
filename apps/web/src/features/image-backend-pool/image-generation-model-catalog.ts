/**
 * 创作页图片模型目录的 DB-free 构建器。
 *
 * 职责：将已授权分组与 API 成员的显式模型声明合并成
 * 可序列化目录。模型 ID 只是能力键；构建器不用前缀缩小成员类型。
 */
import type { ImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import {
  isLegacyVideoModelId,
  normalizeSupportedModelId,
} from "@repo/shared/image-backend/supported-models";
import { normalizeVideoModelId } from "@repo/shared/video-generation";

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
  /** 仅当模型配置显式开启质量参数时为 true；缺失表示不支持。 */
  supportsQuality?: boolean;
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
  type: "api";
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
  videoModelIds?: readonly string[];
  /** 仅传递显式开启质量参数的模型；缺失模型默认不支持。 */
  supportsQualityByModel?: Readonly<Record<string, boolean>>;
}

/** API 成员支持完整图片编辑能力。 */
function getMemberCapabilities(): ImageGenerationModelCapabilities {
  return {
    generate: true,
    edit: true,
    mask: true,
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
 * @param source 已完成启用状态和成员可达性筛选的分组事实。
 * @returns 不含视频模型，且按模型 ID 稳定排序的目录。
 */
export function buildImageGenerationModelCatalog(
  source: ImageGenerationCatalogSource
): ImageGenerationModelCatalog {
  const supportsQualityByModel = new Map(
    Object.entries(source.supportsQualityByModel ?? {}).map(
      ([modelId, supported]) => [modelId.toLowerCase(), supported]
    )
  );
  const videoModelIds = new Set(
    (source.videoModelIds ?? []).map((modelId) => modelId.trim().toLowerCase())
  );
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
        const capabilities = getMemberCapabilities();
        for (const rawModelId of member.supportedModelIds) {
          const modelId = normalizeSupportedModelId(rawModelId);
          if (
            !modelId ||
            videoModelIds.has(modelId.toLowerCase()) ||
            normalizeVideoModelId(modelId) ||
            isLegacyVideoModelId(modelId)
          ) {
            continue;
          }
          const normalizedId = modelId.toLowerCase();
          const current = models.get(normalizedId);
          if (current) {
            current.capabilities = mergeCapabilities(
              current.capabilities,
              capabilities
            );
          } else {
            const supportsQuality = supportsQualityByModel.get(normalizedId);
            models.set(normalizedId, {
              id: modelId,
              capabilities: { ...capabilities },
              ...(supportsQuality === true ? { supportsQuality: true } : {}),
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
