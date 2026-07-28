/**
 * 管理员网站 Logo multipart HTTP 适配器。
 *
 * 职责：按 Origin、正文大小、会话角色和严格 FormData 顺序校验请求，再调用 UOL。
 * 使用方：管理后台 Logo 设置卡片。
 * 关键边界：不直接访问数据库、Sharp 或对象存储；文件原始字节只在有界内存中转交 UOL。
 */
import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { isSuperAdminRole } from "@repo/shared/auth/roles";
import { logError } from "@repo/shared/logger";
import {
  MAX_SITE_LOGO_UPLOAD_BYTES,
  type SiteLogoUploadOutput,
  siteLogoUploadInputSchema,
} from "@repo/shared/system-settings/site-branding";
import {
  invokeOperation,
  OperationError,
  type Principal,
} from "@repo/shared/uol";

import {
  BoundedMultipartError,
  parseBoundedContentLength,
  parseBoundedMultipartFormData,
} from "@/features/model-configuration/bounded-multipart";
import { hasTrustedModelConfigurationOrigin } from "@/features/model-configuration/request-origin";
import { ensureUolInitialized } from "@/server/uol-init";

/** multipart 边界和字段开销预留 256 KiB，不改变单文件 5 MiB 限制。 */
const MAX_SITE_LOGO_MULTIPART_BYTES = MAX_SITE_LOGO_UPLOAD_BYTES + 256 * 1024;

/** 将稳定错误映射为不含内部消息的 JSON 响应。 */
function errorResponse(error: string, code: string, status: number): Response {
  return Response.json({ error, code }, { status });
}

/** 将正文读取错误映射为 400 或 413。 */
function boundedErrorResponse(error: BoundedMultipartError): Response {
  return errorResponse(
    error.code === "body_too_large" ? "Logo 上传请求过大" : "Logo 上传表单无效",
    error.code,
    error.code === "body_too_large" ? 413 : 400
  );
}

/** 严格收集 Logo 表单，拒绝未知字段、重复字段和多个文件。 */
function collectLogoFormData(formData: FormData): {
  clientRequestId: string;
  file: File;
} {
  let clientRequestId: string | undefined;
  let file: File | undefined;
  for (const [field, value] of formData.entries()) {
    if (field === "clientRequestId") {
      if (typeof value !== "string" || clientRequestId !== undefined) {
        throw new Error("Logo 上传请求标识无效");
      }
      clientRequestId = value;
      continue;
    }
    if (field === "file") {
      if (typeof value === "string" || file !== undefined) {
        throw new Error("Logo 只能上传一个文件");
      }
      file = value;
      continue;
    }
    throw new Error("Logo 上传表单包含未知字段");
  }
  if (!clientRequestId || !file) {
    throw new Error("Logo 上传表单缺少必填字段");
  }
  return { clientRequestId, file };
}

/** 读取并解析 Logo 表单，同时把真实 File 字节限制在 UOL 契约以内。 */
async function parseLogoInput(
  formData: FormData
): Promise<ReturnType<typeof siteLogoUploadInputSchema.parse>> {
  const { clientRequestId, file } = collectLogoFormData(formData);
  if (file.size > MAX_SITE_LOGO_UPLOAD_BYTES) {
    throw new Error("Logo 文件不能超过 5 MB");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_SITE_LOGO_UPLOAD_BYTES) {
    throw new Error("Logo 文件不能超过 5 MB");
  }
  return siteLogoUploadInputSchema.parse({
    clientRequestId,
    fileName: file.name,
    contentType: file.type,
    bytes,
  });
}

/**
 * 接收管理员 Logo 文件。
 *
 * @param request - 浏览器同源 multipart POST 请求。
 * @returns 成功时返回 Logo DTO；失败时返回稳定 JSON 错误。
 * @sideEffects 读取会话、消费有界正文并经 UOL 写入品牌资产。
 */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!hasTrustedModelConfigurationOrigin(request)) {
      return errorResponse("Forbidden", "forbidden", 403);
    }
    try {
      parseBoundedContentLength(
        request.headers.get("content-length"),
        MAX_SITE_LOGO_MULTIPART_BYTES
      );
    } catch (error) {
      if (error instanceof BoundedMultipartError) {
        return boundedErrorResponse(error);
      }
      throw error;
    }

    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return errorResponse("Unauthorized", "unauthenticated", 401);
    }
    const role = await getUserRoleById(session.user.id);
    if (!isSuperAdminRole(role)) {
      return errorResponse("Forbidden", "forbidden", 403);
    }

    let input: ReturnType<typeof siteLogoUploadInputSchema.parse>;
    try {
      input = await parseLogoInput(
        await parseBoundedMultipartFormData(
          request,
          MAX_SITE_LOGO_MULTIPART_BYTES
        )
      );
    } catch (error) {
      if (error instanceof BoundedMultipartError) {
        return boundedErrorResponse(error);
      }
      return errorResponse("Logo 上传表单无效", "validation_error", 400);
    }

    const principal: Principal = {
      type: "user",
      userId: session.user.id,
      role,
    };
    try {
      await ensureUolInitialized();
      const output = await invokeOperation<SiteLogoUploadOutput>(
        "settings.uploadSiteLogo",
        input,
        principal
      );
      return Response.json(output, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (error instanceof OperationError) {
        return errorResponse("Logo 上传失败", error.code, error.httpStatus);
      }
      logError(error, { source: "api.admin.site-branding.logo" });
      return errorResponse("Internal server error", "internal_error", 500);
    }
  } catch (error) {
    logError(error, { source: "api.admin.site-branding.logo.preflight" });
    return errorResponse("Internal server error", "internal_error", 500);
  }
}
