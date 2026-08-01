/**
 * 旧 API 请求处理脚本接口的 Worker Pool 兼容门面。
 *
 * 职责：保持图片与视频现有调用签名不变，把不透明媒体校验和错误文案映射到新的
 * 通用上游脚本执行器；待六操作执行器全部切换后可删除本门面。
 */
import { apiRequestTransformScriptSchema } from "@repo/shared/image-backend/api-upstream-adaptation";

import {
  ApiUpstreamOpaqueValueError,
  assertApiUpstreamOpaqueValuesPreserved,
  createApiUpstreamOpaqueToken,
  restoreApiUpstreamOpaqueValues,
} from "./api-upstream-opaque-values";
import {
  ApiUpstreamScriptRuntimeError,
  runApiUpstreamScript,
  validateApiUpstreamScript,
} from "./api-upstream-script-runtime";

/** 请求处理脚本可见的固定操作类型。 */
export type ApiRequestTransformOperation =
  | "images.generate"
  | "images.edit"
  | "videos.generate";

/** 请求处理脚本可见的脱敏、只读上下文。 */
export interface ApiRequestTransformContext {
  operation: ApiRequestTransformOperation;
  contentType: "application/json" | "multipart/form-data";
  platformModelId: string;
  upstreamModelId: string;
}

/** QuickJS 请求处理失败；消息稳定且绝不包含请求体、脚本或凭据。 */
export class ApiRequestTransformError extends Error {
  readonly code: "invalid_script" | "execution_failed" | "invalid_output";

  /** 创建可安全返回给成员调度层的脚本错误。 */
  constructor(code: "invalid_script" | "execution_failed" | "invalid_output") {
    super(
      code === "invalid_script"
        ? "API 账号请求处理脚本语法无效"
        : code === "execution_failed"
          ? "API 账号请求处理脚本执行失败"
          : "API 账号请求处理脚本返回了非法请求体"
    );
    this.name = "ApiRequestTransformError";
    this.code = code;
  }
}

/** 创建只在宿主内保存真实媒体值的不可预测脚本令牌。 */
export function createApiRequestOpaqueToken(): string {
  return createApiUpstreamOpaqueToken();
}

/** 把通用运行时错误映射为旧调用方已识别的三种错误。 */
function mapRuntimeError(error: unknown): ApiRequestTransformError {
  if (error instanceof ApiRequestTransformError) return error;
  if (error instanceof ApiUpstreamOpaqueValueError) {
    return new ApiRequestTransformError("invalid_output");
  }
  if (error instanceof ApiUpstreamScriptRuntimeError) {
    if (error.code === "invalid_script" || error.code === "invalid_output") {
      return new ApiRequestTransformError(error.code);
    }
  }
  return new ApiRequestTransformError("execution_failed");
}

/**
 * 在生产 Worker 中仅编译管理员脚本，不使用真实请求执行。
 *
 * @param rawScript - 管理端提交的脚本正文。
 * @throws ApiRequestTransformError 脚本超长或语法非法时拒绝保存。
 */
export async function validateApiRequestTransformScript(
  rawScript: string
): Promise<void> {
  const parsed = apiRequestTransformScriptSchema.safeParse(rawScript);
  if (!parsed.success) throw new ApiRequestTransformError("invalid_script");
  try {
    await validateApiUpstreamScript(parsed.data, "images.generate", "request");
  } catch (error) {
    throw mapRuntimeError(error);
  }
}

/**
 * 在 Worker Pool 的受限 QuickJS 中转换一个账号即将发送的请求体。
 *
 * @param request - JSON 安全的标准请求；大媒体应先替换为宿主令牌。
 * @param rawScript - 账号保存的同步脚本正文；空脚本保持原请求。
 * @param scriptContext - 不含身份、凭据、URL 或 Header 的只读上下文。
 * @param opaqueValues - 令牌到 Blob/data URL 的宿主映射；脚本不得丢失或复制。
 * @returns 经严格校验并恢复媒体值的普通请求对象。
 */
export async function applyApiRequestTransformScript(
  request: Record<string, unknown>,
  rawScript: string,
  scriptContext: ApiRequestTransformContext,
  opaqueValues: ReadonlyMap<string, unknown> = new Map()
): Promise<Record<string, unknown>> {
  const parsed = apiRequestTransformScriptSchema.safeParse(rawScript);
  if (!parsed.success) throw new ApiRequestTransformError("invalid_script");
  try {
    assertApiUpstreamOpaqueValuesPreserved(request, opaqueValues);
    const output = await runApiUpstreamScript(
      request,
      parsed.data,
      { ...scriptContext },
      {
        operation: scriptContext.operation,
        stage: "request",
        priority: "request",
      }
    );
    if (!output || typeof output !== "object" || Array.isArray(output)) {
      throw new ApiRequestTransformError("invalid_output");
    }
    assertApiUpstreamOpaqueValuesPreserved(output, opaqueValues);
    return restoreApiUpstreamOpaqueValues(output, opaqueValues) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw mapRuntimeError(error);
  }
}
