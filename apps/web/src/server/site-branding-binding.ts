/**
 * 网站品牌 Logo operation 的 Web late binding。
 *
 * 职责：把 shared 中声明的 settings.uploadSiteLogo 绑定到图片校验、对象存储、事务和
 * 审计服务，并把领域错误收窄为 UOL 稳定错误。
 * 使用方：apps/web/src/server/uol-bindings.ts 的启动初始化。
 * 关键边界：仅真实 user Principal 可进入保存服务，文件字节不写日志或错误响应。
 */
import "server-only";

import type {
  SiteLogoUploadInput,
  SiteLogoUploadOutput,
} from "@repo/shared/system-settings/site-branding";
import {
  bindExecute,
  OperationError,
  type OperationContext,
  type Principal,
} from "@repo/shared/uol";

import {
  SiteLogoUploadServiceError,
  siteLogoUploadService,
} from "@/features/site-branding/service";
import { SiteLogoFileError } from "@/features/site-branding/site-logo-file";

/** 把 Logo 文件校验错误转换为不泄露底层细节的 UOL validation_error。 */
function throwSiteLogoValidationError(error: SiteLogoFileError): never {
  throw new OperationError("validation_error", error.message, {
    reason: error.code,
  });
}

/** 把保存服务错误转换为稳定的幂等或内部错误。 */
function throwSiteLogoServiceError(
  error: SiteLogoUploadServiceError
): never {
  if (error.code === "idempotency_conflict") {
    throw new OperationError("idempotency_conflict", error.message);
  }
  throw new OperationError("internal_error", "网站 Logo 服务暂时不可用");
}

/**
 * 绑定网站 Logo 上传 operation。
 *
 * @returns 无返回值；副作用是替换 registry 中 operation 的 execute。
 * @sideEffects 修改 UOL registry 的延迟执行体。
 * @failure operation 未注册时同步抛错。
 */
export function bindSiteBrandingOperations(): void {
  bindExecute(
    "settings.uploadSiteLogo",
    async (
      input: SiteLogoUploadInput,
      principal: Principal,
      _ctx: OperationContext
    ): Promise<SiteLogoUploadOutput> => {
      if (principal.type !== "user") {
        throw new OperationError(
          "forbidden",
          "仅超级管理员用户可以上传网站 Logo"
        );
      }
      try {
        return await siteLogoUploadService(input, principal.userId);
      } catch (error) {
        if (error instanceof SiteLogoFileError) {
          throwSiteLogoValidationError(error);
        }
        if (error instanceof SiteLogoUploadServiceError) {
          throwSiteLogoServiceError(error);
        }
        throw error;
      }
    }
  );
}

bindSiteBrandingOperations();
