/**
 * 视频能力发现 binding 的 DB-free 执行核心。
 *
 * 职责：根据 Principal 可信分组读取有效模型能力，只投影公共参数、输入、声音、
 * 基础设施限制与配置可达性；不接触成员运行状态或凭据。
 * 使用方：视频 UOL 生产 binding 与权限/输出契约测试。
 */

import {
  MAX_MEDIA_INPUT_BYTES,
  MAX_MEDIA_INPUT_COUNT,
} from "@repo/shared/image-generation/media-contract";
import {
  isModelMarketplaceModelEnabled,
  parseModelMarketplaceConfig,
} from "@repo/shared/model-marketplace";
import type { Principal } from "@repo/shared/uol";
import { isExternalApiKeyPrincipal, OperationError } from "@repo/shared/uol";
import {
  resolveEffectiveVideoModelCapabilities,
  VIDEO_ASPECT_RATIOS,
  type VideoCurrentQuote,
} from "@repo/shared/video-generation";

/** 配置可达性查询所需的 Principal 分组事实。 */
export interface VideoCapabilityConfiguredModelsInput {
  userId: string;
  apiKeyId?: string;
  requestedGroupId?: string;
}

/** 当前报价加载器只接收公开模型和支持分辨率，不接触能力外字段。 */
export interface VideoCapabilityPricingDescriptor {
  modelId: string;
  supportedResolutions: readonly string[];
}

/** 能力发现可替换依赖；测试注入桩，生产读取系统设置与可信分组配置。 */
export interface VideoCapabilityBindingDependencies {
  loadCapabilityOverrides(): Promise<unknown>;
  loadMarketplaceConfig?(): Promise<unknown>;
  listConfiguredModelIds(
    input: VideoCapabilityConfiguredModelsInput
  ): Promise<string[]>;
  loadCurrentQuotes(
    input: VideoCapabilityConfiguredModelsInput & { principalScope: string },
    models: readonly VideoCapabilityPricingDescriptor[]
  ): Promise<Readonly<Record<string, readonly VideoCurrentQuote[]>>>;
  reportFailure(error: unknown): void;
}

/** 只保留全局目录中的精确真实模型 ID；旧复合变体不扩大为整族可达。 */
function resolveConfiguredRealVideoModelIds(
  configuredModelIds: readonly string[],
  allowedModelIds: ReadonlySet<string>
): Set<string> {
  return new Set(
    configuredModelIds.filter((modelId) => allowedModelIds.has(modelId))
  );
}

/**
 * 查询全局有效能力与 Principal 可信分组的配置可达性。
 *
 * @param input - 可选站内显式分组；外部 API Key 不允许提供。
 * @param principal - 网关已验证的用户或 API Key 身份。
 * @param dependencies - 设置和分组配置读取端口。
 * @returns 稳定公共能力目录、基础设施限制与配置可达性。
 * @sideEffects 通过依赖端口读取设置与成员模型配置，不写状态。
 * @throws OperationError 身份非法、API Key 覆盖分组或配置不可用时拒绝。
 */
export async function executeVideoListCapabilitiesBinding(
  input: { backendGroupId?: string },
  principal: Principal,
  dependencies: VideoCapabilityBindingDependencies
) {
  if (principal.type !== "user" && principal.type !== "apiKey") {
    throw new OperationError("unauthenticated", "User identity required");
  }
  const apiKeyId = isExternalApiKeyPrincipal(principal)
    ? principal.apiKeyId
    : undefined;
  if (apiKeyId && input.backendGroupId) {
    throw new OperationError(
      "validation_error",
      "API Key 调用不能覆盖服务端绑定的媒体后端分组"
    );
  }

  try {
    const selection = {
      userId: principal.userId,
      ...(apiKeyId ? { apiKeyId } : {}),
      ...(input.backendGroupId
        ? { requestedGroupId: input.backendGroupId }
        : {}),
    };
    const [overrides, marketplaceConfigValue, configuredModelIds] =
      await Promise.all([
        dependencies.loadCapabilityOverrides(),
        dependencies.loadMarketplaceConfig?.() ?? Promise.resolve(null),
        dependencies.listConfiguredModelIds(selection),
      ]);
    const marketplaceConfig = parseModelMarketplaceConfig(
      marketplaceConfigValue
    );
    const capabilities = [
      ...resolveEffectiveVideoModelCapabilities(overrides),
      ...marketplaceConfig.customModels
        .filter(
          (model) =>
            model.category === "video" &&
            isModelMarketplaceModelEnabled(
              marketplaceConfig,
              "video",
              model.modelId
            )
        )
        .map((model) => ({
          modelId: model.modelId,
          displayName: model.modelId,
          billingFamily: model.modelId,
          durations: [5, 10],
          aspectRatios: [...VIDEO_ASPECT_RATIOS],
          resolutions: [...model.supportedResolutions],
          input: {
            frames: "none" as const,
            referenceImages: { maxCount: 0, configurable: false },
            framesAndReferencesMutuallyExclusive: true,
          },
          audio: { supported: false, defaultEnabled: false },
        })),
    ]
      .filter((capability) =>
        isModelMarketplaceModelEnabled(
          marketplaceConfig,
          "video",
          capability.modelId
        )
      )
      .map((capability) => {
        const configuredResolutions =
          marketplaceConfig.videoByFamily[capability.modelId]
            ?.supportedResolutions;
        return configuredResolutions
          ? { ...capability, resolutions: [...configuredResolutions] }
          : capability;
      });
    const allowedModelIds = new Set(capabilities.map((item) => item.modelId));
    const reachable = resolveConfiguredRealVideoModelIds(
      configuredModelIds,
      allowedModelIds
    );
    const quotes = await dependencies.loadCurrentQuotes(
      {
        ...selection,
        principalScope:
          principal.type === "user"
            ? `user:${principal.userId}`
            : `${principal.credentialKind}:${principal.userId}:${principal.apiKeyId}`,
      },
      capabilities.map((capability) => ({
        modelId: capability.modelId,
        supportedResolutions: capability.resolutions,
      }))
    );
    return {
      items: capabilities.map((capability) => ({
        model: capability.modelId,
        displayName: capability.displayName,
        durations: [...capability.durations],
        aspectRatios: [...capability.aspectRatios],
        resolutions: [...capability.resolutions],
        input: {
          frames: capability.input.frames,
          referenceImages: {
            maxCount: capability.input.referenceImages.maxCount,
            configurable: capability.input.referenceImages.configurable,
          },
          framesAndReferencesMutuallyExclusive:
            capability.input.framesAndReferencesMutuallyExclusive,
        },
        audio: { ...capability.audio },
        configuredReachable: reachable.has(capability.modelId),
        billing: [...(quotes[capability.modelId] ?? [])],
      })),
      limits: {
        maxMediaInputCount: MAX_MEDIA_INPUT_COUNT,
        maxMediaInputBytes: MAX_MEDIA_INPUT_BYTES,
      },
    };
  } catch (error) {
    dependencies.reportFailure(error);
    throw new OperationError("not_ready", "视频模型能力暂时不可用");
  }
}
