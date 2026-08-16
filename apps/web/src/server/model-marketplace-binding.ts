/**
 * 模型配置与模型广场 operation 的 Web late binding。
 *
 * 使用方是统一 `uol-bindings` 启动入口。本模块把 shared 中仅声明契约的三个 operation
 * 绑定到生产管理服务和公开目录服务，并在 UOL 边界完成真实用户检查、领域错误映射与
 * 公开依赖 not_ready 收窄，不读取数据库或对象存储本身。
 */
import "server-only";

import { logError } from "@repo/shared/logger";
import {
  type ModelConfigurationListInput,
  type ModelConfigurationListOutput,
  type ModelConfigurationSnapshot,
  type ModelMarketplacePublicItem,
  modelMarketplacePublicItemSchema,
  type UpdateModelConfigurationEntryInput,
  type UpdateModelConfigurationEntryOutput,
} from "@repo/shared/model-marketplace";
import { getRuntimeSettingJson } from "@repo/shared/system-settings";
import {
  bindExecute,
  type OperationContext,
  OperationError,
  type Principal,
} from "@repo/shared/uol";
import type { ModelMarketplacePublicCatalogOutput } from "@repo/shared/uol/operations";
import type { VideoCurrentQuote } from "@repo/shared/video-generation";
import { ModelMarketplaceCoverImageError } from "@/features/model-configuration/cover-image";
import { productionModelConfigurationService } from "@/features/model-configuration/service";
import {
  ModelConfigurationServiceError,
  type ModelConfigurationServiceErrorCode,
} from "@/features/model-configuration/service-core";
import { productionModelMarketplaceService } from "@/features/model-marketplace/service";
import { loadVideoCurrentQuotes } from "./uol-bindings/video-current-quotes";
import { executeVideoListCapabilitiesBinding } from "./uol-bindings/video-generation-capabilities";

/** 登录用户 Principal；公开模型目录只为该身份计算可信分组可达性。 */
type UserPrincipal = Extract<Principal, { type: "user" }>;

/** 模型广场只消费视频能力输出中的真实模型 ID 与可达布尔值。 */
type PublicVideoReachability = {
  items: ReadonlyArray<{
    model: string;
    configuredReachable: boolean;
    billing: readonly VideoCurrentQuote[];
  }>;
};

/** 三个 operation 所需的生产服务入口，测试可替换且不复制业务规则。 */
export type ModelMarketplaceOperationBindingDependencies = {
  readModelConfiguration: (
    principal: Principal
  ) => Promise<ModelConfigurationSnapshot>;
  readModelConfigurationPage: (
    principal: Principal,
    input: ModelConfigurationListInput
  ) => Promise<ModelConfigurationListOutput>;
  updateModelConfigurationEntry: (command: {
    actorUserId: string;
    input: UpdateModelConfigurationEntryInput;
  }) => Promise<UpdateModelConfigurationEntryOutput>;
  listPublicModels: () => Promise<ModelMarketplacePublicCatalogOutput>;
  listVideoCapabilities: (
    principal: UserPrincipal
  ) => Promise<PublicVideoReachability>;
  reportUpdateError: (
    error: unknown,
    context: {
      requestId: string;
      category: UpdateModelConfigurationEntryInput["category"];
      configKey: string;
    }
  ) => void;
};

const defaultDependencies: ModelMarketplaceOperationBindingDependencies = {
  readModelConfiguration: (principal) =>
    productionModelConfigurationService.read(principal),
  readModelConfigurationPage: (principal, input) =>
    productionModelConfigurationService.readPage(principal, input),
  updateModelConfigurationEntry: (command) =>
    productionModelConfigurationService.updateEntry(command),
  listPublicModels: () => productionModelMarketplaceService.listPublicModels(),
  listVideoCapabilities: (principal) =>
    executeVideoListCapabilitiesBinding({}, principal, {
      async loadCapabilityOverrides() {
        return getRuntimeSettingJson("VIDEO_MODEL_CAPABILITY_OVERRIDES");
      },
      async loadMarketplaceConfig() {
        return getRuntimeSettingJson("MODEL_MARKETPLACE_CONFIG");
      },
      async listConfiguredModelIds(selection) {
        return (
          await import("@/features/image-backend-pool/runtime-service")
        ).listConfiguredRuntimeModelIds(selection);
      },
      loadCurrentQuotes: loadVideoCurrentQuotes,
      reportFailure(error) {
        logError(error, { source: "model-marketplace-video-reachability" });
      },
    }),
  reportUpdateError(error, context) {
    logError(error, {
      source: "model-configuration-update",
      ...context,
    });
  },
};

/**
 * 把保存内核稳定领域错误映射为 UOL 唯一错误载体。
 *
 * @param error - production 模型配置保存服务抛出的未知异常。
 * @returns 永不返回；已知领域错误转换后抛出，普通异常原样上抛交给网关隐藏。
 * @throws OperationError - 封面、revision、幂等、模型身份或内部依赖错误。
 */
function throwModelConfigurationOperationError(error: unknown): never {
  if (error instanceof ModelMarketplaceCoverImageError) {
    throw new OperationError("validation_error", error.message, {
      reason: "invalid_cover",
      coverCode: error.code,
    });
  }
  if (!(error instanceof ModelConfigurationServiceError)) throw error;

  const code: ModelConfigurationServiceErrorCode = error.code;
  switch (code) {
    case "revision_conflict":
      throw new OperationError("conflict", error.message, {
        reason: code,
      });
    case "idempotency_conflict":
      throw new OperationError("idempotency_conflict", error.message);
    case "not_configurable":
      throw new OperationError("validation_error", error.message, {
        reason: code,
      });
    case "invalid_dependency_result":
    case "revision_exhausted":
      throw new OperationError("internal_error", "模型配置服务暂时不可用");
  }
}

/**
 * 判断保存异常是否需要在 UOL 隐藏底层详情前记录。
 *
 * @param error - 生产保存服务抛出的未知异常。
 * @returns 可归因于管理员输入或并发的稳定错误返回 false，基础设施与内部错误返回 true。
 * @sideEffects 无。
 * @failure 不抛错；未知值按内部故障记录。
 */
function shouldReportModelConfigurationUpdateError(error: unknown): boolean {
  if (error instanceof ModelMarketplaceCoverImageError) return false;
  if (!(error instanceof ModelConfigurationServiceError)) return true;
  return (
    error.code === "invalid_dependency_result" ||
    error.code === "revision_exhausted"
  );
}

/**
 * 按登录用户可信分组覆盖公开视频模型的配置可达性。
 *
 * @param catalog - 已由公开服务裁剪的全局目录。
 * @param reachability - 视频能力 binding 返回的公开模型 ID 与可达布尔值。
 * @returns 图片条目原样保留、视频条目按用户可信分组覆盖后的新目录。
 * @sideEffects 无；不修改输入，也不投影能力输出中的其他字段。
 * @failure 能力目录缺少某个视频模型时按不可达处理，避免回退到全局并集。
 */
function applyCurrentVideoPricing(
  item: Extract<ModelMarketplacePublicItem, { category: "video" }>,
  capability: PublicVideoReachability["items"][number]
): Extract<ModelMarketplacePublicItem, { category: "video" }> {
  const quoteByResolution = new Map(
    capability.billing.map((quote) => [quote.resolution, quote])
  );
  const quotes = item.supportedResolutions.map((resolution) => {
    const quote = quoteByResolution.get(resolution);
    if (!quote) throw new Error("模型广场视频报价未完整覆盖支持分辨率");
    return quote;
  });
  const mode = quotes[0]?.mode;
  if (!mode || quotes.some((quote) => quote.mode !== mode)) {
    throw new Error("模型广场同一视频模型返回了不一致计费模式");
  }
  const prices = Object.fromEntries(
    quotes.map((quote) => [quote.resolution, quote.unitPrice])
  );
  const minimumCredits = Math.min(...Object.values(prices));
  const common =
    item.priceUnit === "per_second"
      ? (({
          billingMode: _billingMode,
          creditsPerSecond: _creditsPerSecond,
          creditsPerSecondByResolution: _creditsPerSecondByResolution,
          minimumCredits: _minimumCredits,
          priceUnit: _priceUnit,
          ...safe
        }) => safe)(item)
      : (({
          billingMode: _billingMode,
          creditsPerItem: _creditsPerItem,
          creditsPerItemByResolution: _creditsPerItemByResolution,
          minimumCredits: _minimumCredits,
          priceUnit: _priceUnit,
          ...safe
        }) => safe)(item);
  return modelMarketplacePublicItemSchema.parse(
    mode === "per_item"
      ? {
          ...common,
          category: "video",
          billingMode: "per_item",
          priceUnit: "per_item",
          minimumCredits,
          creditsPerItem: minimumCredits,
          creditsPerItemByResolution: prices,
        }
      : {
          ...common,
          category: "video",
          billingMode: "per_second",
          priceUnit: "per_second",
          minimumCredits,
          creditsPerSecond: minimumCredits,
          creditsPerSecondByResolution: prices,
        }
  ) as Extract<ModelMarketplacePublicItem, { category: "video" }>;
}

function applyUserVideoReachability(
  catalog: ModelMarketplacePublicCatalogOutput,
  reachability: PublicVideoReachability
): ModelMarketplacePublicCatalogOutput {
  const capabilityByModel = new Map(
    reachability.items.map((item) => [item.model, item])
  );
  return {
    items: catalog.items.map((item) => {
      if (item.category !== "video") return item;
      const capability = capabilityByModel.get(item.modelId);
      if (!capability) return { ...item, configuredReachable: false };
      return applyCurrentVideoPricing(
        { ...item, configuredReachable: capability.configuredReachable },
        capability
      );
    }),
  };
}

/**
 * 调用公开模型目录，并仅为真实登录用户叠加可信分组可达性。
 *
 * @param services - 已装配的公开目录和视频能力读取端口。
 * @param principal - 仅允许 system 或真实登录用户；API Key 在此显式拒绝。
 * @returns system 获得全局目录，用户获得只覆盖视频可达布尔值的目录。
 * @sideEffects 读取公开目录；用户路径额外读取设置及其可信分组成员配置。
 * @throws OperationError - 身份不允许时返回 forbidden；任一依赖失败时只暴露稳定
 * not_ready，不附带底层消息、成员、容量、健康或凭据信息。
 */
async function invokePublicModelMarketplace(
  services: ModelMarketplaceOperationBindingDependencies,
  principal: Principal
): Promise<ModelMarketplacePublicCatalogOutput> {
  if (principal.type !== "system" && principal.type !== "user") {
    throw new OperationError("forbidden", "模型广场目录仅允许站内页面读取");
  }

  try {
    const catalog = await services.listPublicModels();
    if (principal.type === "system") return catalog;
    return applyUserVideoReachability(
      catalog,
      await services.listVideoCapabilities(principal)
    );
  } catch {
    throw new OperationError("not_ready", "模型广场暂不可用，请稍后重试");
  }
}

/**
 * 绑定管理读取、单条目保存和公开模型目录三个真实执行体。
 *
 * @param dependencies - 可选生产服务入口；缺省使用两个 production 单例。
 * @returns 无返回值；副作用是替换 registry 中三个已注册 operation 的 execute。
 * @failure operation 未注册时同步抛错；调用期错误按各 operation 的安全边界映射。
 */
export function bindModelMarketplaceOperations(
  dependencies: Partial<ModelMarketplaceOperationBindingDependencies> = {}
): void {
  const services: ModelMarketplaceOperationBindingDependencies = {
    ...defaultDependencies,
    ...dependencies,
  };

  bindExecute(
    "settings.getModelConfiguration",
    async (
      _input: Record<string, never>,
      principal: Principal,
      _ctx: OperationContext
    ) => services.readModelConfiguration(principal)
  );

  bindExecute(
    "settings.listModelConfigurations",
    async (
      input: ModelConfigurationListInput,
      principal: Principal,
      _ctx: OperationContext
    ) => services.readModelConfigurationPage(principal, input)
  );

  bindExecute(
    "settings.updateModelConfigurationEntry",
    async (
      input: UpdateModelConfigurationEntryInput,
      principal: Principal,
      ctx: OperationContext
    ) => {
      // UOL access 已要求 super_admin；此处仍要求真实会话用户，防止未来元数据漂移后代写。
      if (principal.type !== "user") {
        throw new OperationError(
          "forbidden",
          "仅超级管理员用户可以更新模型配置"
        );
      }
      try {
        return await services.updateModelConfigurationEntry({
          actorUserId: principal.userId,
          input,
        });
      } catch (error) {
        if (shouldReportModelConfigurationUpdateError(error)) {
          services.reportUpdateError(error, {
            requestId: ctx.requestId,
            category: input.category,
            configKey: input.configKey,
          });
        }
        throwModelConfigurationOperationError(error);
      }
    }
  );

  bindExecute(
    "modelMarketplace.listPublicModels",
    async (
      _input: Record<string, never>,
      principal: Principal,
      _ctx: OperationContext
    ) => invokePublicModelMarketplace(services, principal)
  );
}
