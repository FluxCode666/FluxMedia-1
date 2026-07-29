/**
 * 模型配置与模型广场 operation 的 Web late binding。
 *
 * 使用方是统一 `uol-bindings` 启动入口。本模块把 shared 中仅声明契约的三个 operation
 * 绑定到生产管理服务和公开目录服务，并在 UOL 边界完成真实用户检查、领域错误映射与
 * 公开依赖 not_ready 收窄，不读取数据库或对象存储本身。
 */
import "server-only";

import { logError } from "@repo/shared/logger";
import type {
  ModelConfigurationSnapshot,
  UpdateModelConfigurationEntryInput,
  UpdateModelConfigurationEntryOutput,
} from "@repo/shared/model-marketplace";
import {
  bindExecute,
  type OperationContext,
  OperationError,
  type Principal,
} from "@repo/shared/uol";
import type { ModelMarketplacePublicCatalogOutput } from "@repo/shared/uol/operations";

import { productionModelConfigurationService } from "@/features/model-configuration/service";
import { ModelMarketplaceCoverImageError } from "@/features/model-configuration/cover-image";
import {
  ModelConfigurationServiceError,
  type ModelConfigurationServiceErrorCode,
} from "@/features/model-configuration/service-core";
import { productionModelMarketplaceService } from "@/features/model-marketplace/service";

/** 三个 operation 所需的生产服务入口，测试可替换且不复制业务规则。 */
export type ModelMarketplaceOperationBindingDependencies = {
  readModelConfiguration: (
    principal: Principal
  ) => Promise<ModelConfigurationSnapshot>;
  updateModelConfigurationEntry: (command: {
    actorUserId: string;
    input: UpdateModelConfigurationEntryInput;
  }) => Promise<UpdateModelConfigurationEntryOutput>;
  listPublicModels: () => Promise<ModelMarketplacePublicCatalogOutput>;
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
  updateModelConfigurationEntry: (command) =>
    productionModelConfigurationService.updateEntry(command),
  listPublicModels: () => productionModelMarketplaceService.listPublicModels(),
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
 * 调用公开模型目录并把全部依赖故障收窄为稳定 not_ready。
 *
 * @param listPublicModels - 已装配运行时目录、价格、展示配置与资产 bucket 的公开服务。
 * @returns 严格公开目录候选值，最终仍由 invokeOperation 输出 schema 复核。
 * @throws OperationError - 服务拒绝时只暴露稳定 not_ready，不附带底层消息或凭据。
 */
async function invokePublicModelMarketplace(
  listPublicModels: () => Promise<ModelMarketplacePublicCatalogOutput>
): Promise<ModelMarketplacePublicCatalogOutput> {
  try {
    return await listPublicModels();
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
      _principal: Principal,
      _ctx: OperationContext
    ) => invokePublicModelMarketplace(services.listPublicModels)
  );
}
