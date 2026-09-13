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
} from "@repo/shared/model-marketplace";
import { normalizeVideoModelId } from "@repo/shared/video-generation";
import { requestGoJsonForPrincipal } from "@/server/go-backend-client";
import type { Principal } from "@repo/shared/uol";
import { canRuntimeBackendLeaseServeRequest } from "@/features/image-backend-pool/runtime-protocol-eligibility";

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
 * Read the API-key model directory from the Go gateway. The signed principal
 * bridge preserves API-key identity without forwarding bearer secrets.
 */
export async function getExternalModelsForApiKey(
  userId: string,
  apiKeyId: string
): Promise<OpenAIModelList> {
  const principal = {
    type: "apiKey" as const,
    credentialKind: "external" as const,
    userId,
    apiKeyId,
  } satisfies Extract<Principal, { type: "apiKey" }>;
  return requestGoJsonForPrincipal<OpenAIModelList>(principal, "/v1/models");
}
