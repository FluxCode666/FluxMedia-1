/**
 * 外部媒体 API 模型目录。
 *
 * 职责：按 API Key 绑定分组、媒体能力和统一成员显式 `supportedModelIds`
 * 构造 OpenAI 兼容 `/v1/models` 响应；不再发布任何 Chat、Responses 或 Codex 模型。
 */
import {
  isLegacyVideoModelId,
  normalizeSupportedModelId,
} from "@repo/shared/image-backend/supported-models";
import {
  isModelMarketplaceModelEnabled,
  type ModelMarketplaceConfig,
  parseModelMarketplaceConfig,
} from "@repo/shared/model-marketplace";
import { normalizeVideoModelId } from "@repo/shared/video-generation";
import { and, asc, eq } from "drizzle-orm";

import { backendMemberService } from "@/features/image-backend-pool/member-service";
import { canRuntimeBackendLeaseServeRequest } from "@/features/image-backend-pool/runtime-protocol-eligibility";

const DEFAULT_MODEL_OWNER = "gpt2image";

/** OpenAI 兼容模型项。 */
export interface OpenAIModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

/** OpenAI 兼容模型列表响应。 */
export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

/** 合并模型来源并按大小写无关键稳定去重。 */
export function mergeExternalModelIds(...modelGroups: string[][]): string[] {
  const seen = new Set<string>();
  const modelIds: string[] = [];
  for (const modelGroup of modelGroups) {
    for (const modelId of modelGroup) {
      if (isLegacyVideoModelId(modelId)) continue;
      const normalized = normalizeSupportedModelId(modelId);
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      modelIds.push(normalized);
    }
  }
  return modelIds;
}

/** 将媒体模型 ID 转为 OpenAI 兼容模型项。 */
function toOpenAIModel(id: string): OpenAIModel {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: DEFAULT_MODEL_OWNER,
  };
}

/**
 * 按成员执行形态筛出可发布模型 ID。
 *
 * @param input - 成员类型与显式模型能力。
 * @returns 保持成员配置顺序的图片模型和 API 视频模型；旧视频身份被忽略。
 * @sideEffects 无。
 * @failure 不抛错；未知非视频 ID 保持既有图像模型语义。
 */
export function filterExternalMemberModelIds(input: {
  memberType: "api";
  supportedModelIds: readonly string[];
  customVideoModelIds?: ReadonlySet<string>;
  marketplaceConfig?: ModelMarketplaceConfig;
}): string[] {
  return input.supportedModelIds.filter((modelId) => {
    const isCustomVideo = input.customVideoModelIds?.has(
      modelId.trim().toLowerCase()
    );
    const videoModelId = normalizeVideoModelId(modelId);
    if (isCustomVideo) {
      return (
        input.memberType === "api" &&
        (!input.marketplaceConfig ||
          isModelMarketplaceModelEnabled(
            input.marketplaceConfig,
            "video",
            modelId
          ))
      );
    }
    if (videoModelId) {
      return (
        (!input.marketplaceConfig ||
          isModelMarketplaceModelEnabled(
            input.marketplaceConfig,
            "video",
            videoModelId
          )) &&
        canRuntimeBackendLeaseServeRequest(
          { requestKind: "video" },
          {
            memberType: input.memberType,
          }
        )
      );
    }
    return (
      !isLegacyVideoModelId(modelId) &&
      (!input.marketplaceConfig ||
        isModelMarketplaceModelEnabled(
          input.marketplaceConfig,
          "image",
          modelId
        ))
    );
  });
}

/**
 * 读取 API Key 本次允许调度的分组。
 *
 * @param userId API Key 已鉴权所有者。
 * @param apiKeyId 当前 API Key ID。
 * @returns Key 显式分组；未绑定时返回当前启用默认分组。
 */
async function resolveApiKeyGenerationGroup(
  userId: string,
  apiKeyId: string
): Promise<string | null> {
  const { db, externalApiKey, imageBackendGroup } = await import(
    "@repo/database"
  );
  const [key] = await db
    .select({ generationGroupId: externalApiKey.generationGroupId })
    .from(externalApiKey)
    .where(
      and(eq(externalApiKey.id, apiKeyId), eq(externalApiKey.userId, userId))
    )
    .limit(1);
  if (!key) return null;
  if (key.generationGroupId) return key.generationGroupId;
  const defaultGroups = await db
    .select({ id: imageBackendGroup.id })
    .from(imageBackendGroup)
    .where(
      and(
        eq(imageBackendGroup.isEnabled, true),
        eq(imageBackendGroup.isDefault, true)
      )
    )
    .orderBy(asc(imageBackendGroup.createdAt), asc(imageBackendGroup.id))
    .limit(2);
  if (defaultGroups.length !== 1) return null;
  return defaultGroups[0]?.id ?? null;
}

/**
 * 按当前 API Key 的可调度分组生成媒体模型列表。
 *
 * @param userId 已鉴权 API Key 所有者。
 * @param apiKeyId 当前 API Key ID，用于收窄绑定分组。
 * @returns 只含当前分组至少一个有效成员显式声明的图片/视频模型。
 */
export async function getExternalModelsForApiKey(
  userId: string,
  apiKeyId: string
): Promise<OpenAIModelList> {
  const [groupId, members, marketplaceConfigValue] = await Promise.all([
    resolveApiKeyGenerationGroup(userId, apiKeyId),
    backendMemberService.listMembers(),
    import("@repo/shared/system-settings").then(({ getRuntimeSettingJson }) =>
      getRuntimeSettingJson("MODEL_MARKETPLACE_CONFIG")
    ),
  ]);
  if (!groupId) return { object: "list", data: [] };

  const marketplaceConfig = parseModelMarketplaceConfig(marketplaceConfigValue);
  const customVideoModelIds = new Set(
    marketplaceConfig.customModels
      .filter((model) => model.category === "video")
      .map((model) => model.modelId.toLowerCase())
  );
  const modelIds = mergeExternalModelIds(
    ...members
      .filter(
        (member) =>
          member.isEnabled &&
          member.status !== "error" &&
          member.groupIds.includes(groupId)
      )
      .map((member) => {
        return filterExternalMemberModelIds({
          memberType: member.type,
          supportedModelIds: member.supportedModelIds,
          customVideoModelIds,
          marketplaceConfig,
        });
      })
  );
  return {
    object: "list",
    data: modelIds.map(toOpenAIModel),
  };
}
