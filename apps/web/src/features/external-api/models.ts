/**
 * 外部媒体 API 模型目录。
 *
 * 职责：按 API Key 绑定分组、套餐媒体能力和统一成员显式 `supportedModelIds`
 * 构造 OpenAI 兼容 `/v1/models` 响应；不再发布任何 Chat、Responses 或 Codex 模型。
 */
import { isFireflyVideoModelId } from "@repo/shared/adobe/firefly-direct/video-catalog";
import type { SubscriptionPlan } from "@repo/shared/config/subscription-plan";
import { normalizeSupportedModelId } from "@repo/shared/image-backend/supported-models";
import { getPlanCapabilitySnapshot } from "@repo/shared/subscription/services/plan-capabilities";
import { and, asc, eq } from "drizzle-orm";

import { backendMemberService } from "@/features/image-backend-pool/member-service";

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
  const [defaultGroup] = await db
    .select({ id: imageBackendGroup.id })
    .from(imageBackendGroup)
    .where(
      and(
        eq(imageBackendGroup.isEnabled, true),
        eq(imageBackendGroup.isDefault, true)
      )
    )
    .orderBy(asc(imageBackendGroup.priority), asc(imageBackendGroup.createdAt))
    .limit(1);
  return defaultGroup?.id ?? null;
}

/**
 * 按当前 API Key 与套餐生成媒体模型列表。
 *
 * @param userId 已鉴权 API Key 所有者。
 * @param apiKeyId 当前 API Key ID，用于收窄绑定分组。
 * @param plan Principal 携带并由 UOL 校验的套餐。
 * @returns 只含当前分组至少一个有效成员显式声明的图片/视频模型。
 */
export async function getExternalModelsForApiKey(
  userId: string,
  apiKeyId: string,
  plan: SubscriptionPlan
): Promise<OpenAIModelList> {
  const [groupId, capabilities, members] = await Promise.all([
    resolveApiKeyGenerationGroup(userId, apiKeyId),
    getPlanCapabilitySnapshot(plan),
    backendMemberService.listMembers(),
  ]);
  if (!groupId) return { object: "list", data: [] };

  const imageAllowed =
    capabilities.features["externalApi.images.generate"] === true;
  const videoAllowed =
    capabilities.features["externalApi.videos.generate"] === true;
  const modelIds = mergeExternalModelIds(
    ...members
      .filter(
        (member) =>
          member.isEnabled &&
          member.status !== "error" &&
          member.groupIds.includes(groupId)
      )
      .map((member) =>
        member.supportedModelIds.filter((modelId) =>
          isFireflyVideoModelId(modelId) ? videoAllowed : imageAllowed
        )
      )
  );
  return {
    object: "list",
    data: modelIds.map(toOpenAIModel),
  };
}
