/**
 * 版本化 API 上游通用执行器。
 *
 * 职责：固定路径、脚本、凭据和传输顺序，确保请求脚本失败发生在外呼前，响应脚本
 * 失败不会触发账号切换；图片与视频适配器共同消费本模块。
 */
import type { ApiUpstreamAdapterDraft } from "@repo/shared/image-backend/api-upstream-adaptation";
import {
  type ApiUpstreamAdapterOperationId,
  type ApiUpstreamQuery,
  type ApiUpstreamRequestSnapshot,
  type ApiUpstreamResponseResult,
  type ApiUpstreamScriptContext,
  isApiUpstreamQueryOperation,
} from "@repo/shared/image-backend/api-upstream-script-contract";

import {
  createApiUpstreamAuthenticationHeaders,
  getApiUpstreamAuthenticationHeaderName,
} from "./api-upstream-auth";
import {
  type ApiUpstreamObservabilityContext,
  createApiUpstreamRequestId,
  logApiUpstreamScriptFailure,
} from "./api-upstream-observability";
import type { ApiUpstreamOpaqueValues } from "./api-upstream-opaque-values";
import { resolveApiUpstreamRequestUrl } from "./api-upstream-path";
import { resolveApiUpstreamRequestEnvelope } from "./api-upstream-request-envelope";
import { createApiUpstreamRequestSnapshot } from "./api-upstream-request-snapshot";
import {
  ApiUpstreamResponseReadError,
  parseApiUpstreamScriptedResponse,
} from "./api-upstream-response";
import {
  ApiUpstreamScriptRuntimeError,
  reserveApiUpstreamResponsePermit,
} from "./api-upstream-script-runtime";
import {
  fetchMediaUpstream,
  type MediaUpstreamFetchInit,
} from "./media-upstream-fetch";

/** 执行失败的稳定阶段；只有 before_send 明确允许调度器换号。 */
export type ApiUpstreamExecutionFailureStage =
  | "before_send"
  | "transport_uncertain"
  | "after_send";

/** 不包含脚本、正文、凭据、URL 或上游任务 ID 的执行器错误。 */
export class ApiUpstreamExecutionError extends Error {
  /** 创建可供图片和视频状态机按外呼阶段分类的安全错误。 */
  constructor(
    readonly code:
      | "invalid_configuration"
      | "request_script_failed"
      | "transport_failed"
      | "response_read_failed"
      | "platform_busy"
      | "response_script_failed",
    readonly stage: ApiUpstreamExecutionFailureStage,
    cause?: unknown,
    readonly retryAfterSeconds?: number,
    readonly requestId?: string
  ) {
    const baseMessage =
      code === "platform_busy"
        ? "服务繁忙，请稍后重试"
        : code === "transport_failed" || code === "response_read_failed"
          ? "供应商请求失败，请稍后重试"
          : "供应商请求处理失败，请联系管理员";
    const shouldExposeRequestId =
      requestId &&
      (code === "request_script_failed" || code === "response_script_failed");
    super(
      shouldExposeRequestId
        ? `${baseMessage}（请求标识：${requestId}）`
        : baseMessage,
      { cause }
    );
    this.name = "ApiUpstreamExecutionError";
  }
}

/**
 * 判断一次查询执行错误是否应消耗“连续适配失败”预算。
 *
 * 平台容量和网络传输属于瞬时基础设施问题；配置、脚本与响应读取错误在重复出现时
 * 才说明固定适配版本无法继续完成已接受任务。
 */
export function countsTowardApiUpstreamAdapterFailure(
  error: ApiUpstreamExecutionError
): boolean {
  return [
    "invalid_configuration",
    "request_script_failed",
    "response_read_failed",
    "response_script_failed",
  ].includes(error.code);
}

/**
 * 操作专属编码器用于标记“脚本输出形状非法”，区别于宿主路径或认证配置错误。
 *
 * 此错误只能在外呼前创建，且消息不会直接暴露给用户或结构化日志。
 */
export class ApiUpstreamRequestScriptOutputError extends Error {
  /** 包装操作专属编码失败原因，供通用执行器稳定分类。 */
  constructor(cause: unknown) {
    super("API 上游请求脚本输出无法编码", { cause });
    this.name = "ApiUpstreamRequestScriptOutputError";
  }
}

/** 已执行操作的原始或脚本标准化响应。 */
export type ApiUpstreamExecutionResult =
  | {
      kind: "built_in";
      response: Response;
    }
  | {
      kind: "scripted";
      response: Response;
      result: ApiUpstreamResponseResult;
      pollAfterSeconds?: number;
    };

type UpstreamFetch = (
  url: string,
  init: MediaUpstreamFetchInit
) => Promise<Response>;
type EncodedUpstreamBody = NonNullable<MediaUpstreamFetchInit["body"]>;

/** 判断脚本运行时错误是否属于平台容量，而不是管理员脚本缺陷。 */
function isApiUpstreamRuntimeBusy(
  error: unknown
): error is ApiUpstreamScriptRuntimeError {
  return (
    error instanceof ApiUpstreamScriptRuntimeError &&
    (error.code === "runtime_saturated" || error.code === "runtime_closed")
  );
}

/** 把运行时容量错误映射为不影响供应商账号健康的平台繁忙错误。 */
function createPlatformBusyError(
  stage: ApiUpstreamExecutionFailureStage,
  error: ApiUpstreamScriptRuntimeError,
  requestId: string
): ApiUpstreamExecutionError {
  return new ApiUpstreamExecutionError(
    "platform_busy",
    stage,
    error,
    error.retryAfterSeconds ?? 1,
    requestId
  );
}

/** 创建脚本错误并写入一次脱敏结构化事件。 */
function createScriptFailureError(input: {
  code: "request_script_failed" | "response_script_failed";
  stage: ApiUpstreamExecutionFailureStage;
  cause: unknown;
  requestId: string;
  operation: ApiUpstreamAdapterOperationId;
  platformModelId: string;
  taskId?: string;
  observability?: ApiUpstreamObservabilityContext;
}): ApiUpstreamExecutionError {
  const requestSent = input.stage !== "before_send";
  logApiUpstreamScriptFailure({
    operation: input.operation,
    stage: input.code === "request_script_failed" ? "request" : "response",
    code: input.code,
    requestSent,
    retryAction: requestSent
      ? "hold_accepted_task"
      : input.taskId
        ? "hold_accepted_task"
        : input.code === "request_script_failed"
          ? "switch_member"
          : "fail_before_send",
    requestId: input.requestId,
    platformModelId: input.platformModelId,
    taskSummary: input.taskId ? "accepted_task" : "generation_submission",
    observability: input.observability,
  });
  return new ApiUpstreamExecutionError(
    input.code,
    input.stage,
    input.cause,
    undefined,
    input.requestId
  );
}

/** JSON 操作的默认正文编码器。 */
function encodeJsonBody(body: unknown): EncodedUpstreamBody {
  return JSON.stringify(body);
}

/** Header 名按大小写不敏感语义判断相等。 */
function hasHeaderName(
  headers: Readonly<Record<string, string>>,
  name: string
): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some(
    (candidate) => candidate.toLowerCase() === normalized
  );
}

/**
 * 执行一个固定版本供应商操作。
 *
 * @param input 当前密钥、不可变版本、标准请求、脱敏模型事实与可注入传输。
 * @returns 空响应脚本交回原 Response，非空响应脚本返回统一任务结果。
 * @sideEffects 预留 Worker 响应许可，并在请求脚本成功后最多发起一次 HTTP 请求。
 * @throws ApiUpstreamExecutionError 携带外呼阶段，不暴露供应商数据。
 */
export async function executeApiUpstreamOperation(input: {
  adapter: ApiUpstreamAdapterDraft;
  apiKey: string | null;
  operation: ApiUpstreamAdapterOperationId;
  platformModelId: string;
  upstreamModelId: string;
  contentType: "application/json" | "multipart/form-data";
  query?: ApiUpstreamQuery;
  body?: unknown;
  taskId?: string;
  opaqueValues?: ApiUpstreamOpaqueValues;
  signal?: AbortSignal;
  /** 省略时由底层传输自行治理；下载与图片调用方仍应显式给出边界。 */
  maxResponseBytes?: number;
  encodeBody?: (body: unknown) => EncodedUpstreamBody;
  fetcher?: UpstreamFetch;
  now?: Date;
  observability?: ApiUpstreamObservabilityContext;
  onRequestSnapshot?: (
    snapshot: ApiUpstreamRequestSnapshot
  ) => Promise<void> | void;
  /**
   * 所有脚本、编码和响应脚本许可均准备完成后，在 fetch 前执行一次。
   * 视频创建用它原子预留尝试账本；回调失败时不得发送请求。
   */
  onBeforeSend?: () => Promise<void> | void;
  /**
   * 请求执行前的可选回调。视频创建用它预留尝试账本，使请求脚本、响应脚本
   * 许可或正文编码等发送前失败也会消耗有限的账号级重试额度。
   */
  onBeforeRequestScript?: () => Promise<void> | void;
  /** 调用方已持久化的服务端请求标识；省略时由执行器生成。 */
  requestId?: string;
}): Promise<ApiUpstreamExecutionResult> {
  const requestId = input.requestId ?? createApiUpstreamRequestId();
  const operationConfig = input.adapter.operations[input.operation];
  if (operationConfig.requestScript) {
    try {
      await input.onBeforeRequestScript?.();
    } catch (error) {
      throw new ApiUpstreamExecutionError(
        "invalid_configuration",
        "before_send",
        error,
        undefined,
        requestId
      );
    }
  }
  let envelope: Awaited<ReturnType<typeof resolveApiUpstreamRequestEnvelope>>;
  try {
    const requestContext: ApiUpstreamScriptContext = {
      operation: input.operation,
      stage: "request",
      contentType: input.contentType,
      platformModelId: input.platformModelId,
      upstreamModelId: input.upstreamModelId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
    envelope = await resolveApiUpstreamRequestEnvelope({
      operation: input.operation,
      operationConfig,
      query: input.query,
      body: input.body,
      context: requestContext,
      opaqueValues: input.opaqueValues,
    });
  } catch (error) {
    if (isApiUpstreamRuntimeBusy(error)) {
      throw createPlatformBusyError("before_send", error, requestId);
    }
    if (operationConfig.requestScript) {
      throw createScriptFailureError({
        code: "request_script_failed",
        stage: "before_send",
        cause: error,
        requestId,
        operation: input.operation,
        platformModelId: input.platformModelId,
        taskId: input.taskId,
        observability: input.observability,
      });
    }
    throw new ApiUpstreamExecutionError(
      "invalid_configuration",
      "before_send",
      error,
      undefined,
      requestId
    );
  }

  let target: URL;
  let headers: Record<string, string>;
  let encodedBody: EncodedUpstreamBody | undefined;
  let requestSnapshot: ApiUpstreamRequestSnapshot | undefined;
  try {
    target = resolveApiUpstreamRequestUrl({
      baseUrl: input.adapter.baseUrl,
      operation: input.operation,
      operations: input.adapter.operations,
      taskId: input.taskId,
      query: envelope.query,
    });
    const authenticationHeaderName = getApiUpstreamAuthenticationHeaderName(
      input.adapter.authentication
    );
    if (
      authenticationHeaderName &&
      hasHeaderName(envelope.headers, authenticationHeaderName)
    ) {
      throw new Error("请求脚本不能覆盖认证 Header");
    }
    headers = {
      Accept: "application/json",
      ...envelope.headers,
      ...createApiUpstreamAuthenticationHeaders(
        input.adapter.authentication,
        input.apiKey
      ),
    };
    if (!isApiUpstreamQueryOperation(input.operation)) {
      if (envelope.body === undefined) {
        throw new Error("API 上游生成操作缺少请求正文");
      }
      if (input.contentType === "multipart/form-data" && !input.encodeBody) {
        throw new Error("API 上游 multipart 操作缺少专用正文编码器");
      }
      encodedBody = (input.encodeBody ?? encodeJsonBody)(envelope.body);
      if (input.contentType === "application/json") {
        headers["Content-Type"] = "application/json";
      }
      requestSnapshot = createApiUpstreamRequestSnapshot({
        operation: input.operation,
        contentType: input.contentType,
        body: envelope.body,
      });
    }
  } catch (error) {
    if (
      operationConfig.requestScript &&
      error instanceof ApiUpstreamRequestScriptOutputError
    ) {
      throw createScriptFailureError({
        code: "request_script_failed",
        stage: "before_send",
        cause: error,
        requestId,
        operation: input.operation,
        platformModelId: input.platformModelId,
        taskId: input.taskId,
        observability: input.observability,
      });
    }
    throw new ApiUpstreamExecutionError(
      "invalid_configuration",
      "before_send",
      error
    );
  }

  // WHY：快照必须在 fetch 前持久化，才能覆盖网络失败和上游 HTTP 拒绝；调用方将
  // 失败处理为脱敏日志并允许请求继续，避免调试数据反向成为生成硬依赖。
  if (requestSnapshot) {
    await input.onRequestSnapshot?.(requestSnapshot);
  }

  const permit = operationConfig.responseScript
    ? await reserveApiUpstreamResponsePermit().catch((error: unknown) => {
        if (isApiUpstreamRuntimeBusy(error)) {
          throw createPlatformBusyError("before_send", error, requestId);
        }
        throw createScriptFailureError({
          code: "response_script_failed",
          stage: "before_send",
          cause: error,
          requestId,
          operation: input.operation,
          platformModelId: input.platformModelId,
          taskId: input.taskId,
          observability: input.observability,
        });
      })
    : undefined;

  try {
    await input.onBeforeSend?.();
  } catch (error) {
    permit?.release();
    throw new ApiUpstreamExecutionError(
      "invalid_configuration",
      "before_send",
      error,
      undefined,
      requestId
    );
  }

  let response: Response;
  try {
    response = await (input.fetcher ?? fetchMediaUpstream)(target.toString(), {
      method: isApiUpstreamQueryOperation(input.operation) ? "GET" : "POST",
      headers,
      ...(encodedBody === undefined ? {} : { body: encodedBody }),
      signal: input.signal,
      maxResponseBytes: input.maxResponseBytes,
    });
  } catch (error) {
    permit?.release();
    throw new ApiUpstreamExecutionError(
      "transport_failed",
      "transport_uncertain",
      error
    );
  }

  if (!operationConfig.responseScript) {
    return { kind: "built_in", response };
  }
  try {
    if (!permit) {
      throw new Error("API 上游响应脚本缺少预留许可");
    }
    const parsed = await parseApiUpstreamScriptedResponse({
      operation: input.operation,
      permit,
      response,
      script: operationConfig.responseScript,
      context: {
        operation: input.operation,
        stage: "response",
        contentType: input.contentType,
        platformModelId: input.platformModelId,
        upstreamModelId: input.upstreamModelId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      },
      now: input.now,
    });
    return { kind: "scripted", response, ...parsed };
  } catch (error) {
    permit?.release();
    if (isApiUpstreamRuntimeBusy(error)) {
      throw createPlatformBusyError("after_send", error, requestId);
    }
    if (error instanceof ApiUpstreamResponseReadError) {
      throw new ApiUpstreamExecutionError(
        "response_read_failed",
        "after_send",
        error
      );
    }
    throw createScriptFailureError({
      code: "response_script_failed",
      stage: "after_send",
      cause: error,
      requestId,
      operation: input.operation,
      platformModelId: input.platformModelId,
      taskId: input.taskId,
      observability: input.observability,
    });
  }
}
