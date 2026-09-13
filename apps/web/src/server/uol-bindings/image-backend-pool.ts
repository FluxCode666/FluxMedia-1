/**
 * 统一媒体后端号池 UOL late binding。
 *
 * 职责：把分组、成员启停、API 上游脚本测试和进程诊断绑定到共享 operation；
 * 管理 Action 只调用 UOL，本模块是唯一可接触领域服务和生产 Worker 的适配层。
 */

import {
  type ApiUpstreamAdapterOperationId,
  apiUpstreamRequestInputSchema,
  apiUpstreamResponseInputSchema,
  apiUpstreamResponseResultForOperationSchema,
  apiUpstreamScriptContextSchema,
  parseApiUpstreamRequestEnvelope,
} from "@repo/shared/image-backend/api-upstream-script-contract";
import type { BackendMemberAdminSummary } from "@/features/image-backend-pool/member-service";
import { assertApiUpstreamOpaqueValuesPreserved, createApiUpstreamOpaqueToken, restoreApiUpstreamOpaqueValues } from "@/features/image-backend-pool/api-upstream-opaque-values";
import { getApiUpstreamScriptPoolDiagnostics } from "@/features/image-backend-pool/api-upstream-script-pool";
import { runApiUpstreamScript } from "@/features/image-backend-pool/api-upstream-script-runtime";
import { bindExecute, OperationError } from "@repo/shared/uol";
import { requestGoJson, GoBackendRequestError } from "@/server/go-backend-client";


/** 无网络脚本测试 operation 的严格输入。 */
export interface ApiUpstreamAdapterTestInput {
  operation: ApiUpstreamAdapterOperationId;
  stage: "request" | "response";
  script: string;
  sample: unknown;
}

/** UOL 绑定只保留脚本测试端口；持久化操作统一通过 Go HTTP。 */
export interface ImageBackendPoolBindingDependencies {
  runScript: typeof runApiUpstreamScript;
  getRuntimeDiagnostics: typeof getApiUpstreamScriptPoolDiagnostics;
}

const defaultDependencies: ImageBackendPoolBindingDependencies = {
  runScript: runApiUpstreamScript,
  getRuntimeDiagnostics: getApiUpstreamScriptPoolDiagnostics,
};

/** 判断未知 JSON 值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * 构造通用号池成员 DTO。
 *
 * @param members 成员服务的内部管理摘要。
 * @returns 不含 refresh/余额错误正文的 UOL 输出；专用 human-only 详情另行读取。
 * @sideEffects 无；不修改输入对象。
 */
export function buildAdminPoolMembers(
  members: readonly BackendMemberAdminSummary[]
): Array<
  Omit<BackendMemberAdminSummary, "config"> & {
    config: Record<string, unknown>;
  }
> {
  return members.map((member) => {
    const config: Record<string, unknown> = { ...member.config };
    return { ...member, config };
  });
}

/** 从管理员样例中读取模型 ID，仅用于构造脱敏脚本上下文。 */
function readSampleModelId(sample: unknown): string {
  if (!isRecord(sample)) return "sample-model";
  const body = isRecord(sample.body) ? sample.body : null;
  if (!body) return "sample-model";
  const model = body.model;
  return typeof model === "string" && model.trim()
    ? model.trim().slice(0, 240)
    : "sample-model";
}

/** 从管理员样例中读取任务 ID；原值只进入当前 Worker 作业，不进入日志。 */
function readSampleTaskId(sample: unknown): string {
  if (isRecord(sample)) {
    const candidates = [
      sample,
      ...(isRecord(sample.body) ? [sample.body] : []),
      ...(isRecord(sample.query) ? [sample.query] : []),
    ];
    for (const candidate of candidates) {
      for (const key of ["taskId", "task_id", "id"]) {
        const value = candidate[key];
        if (typeof value === "string" && value.trim()) {
          return value.trim().slice(0, 1_024);
        }
      }
    }
  }
  return "sample-task";
}

/**
 * 把 `mock://media/*` 样例叶子替换为生产格式的不透明令牌。
 *
 * @param value 管理员提供的合成 JSON 样例。
 * @param opaqueValues 保存令牌与展示占位符的宿主映射。
 * @returns 不含真实媒体、可发送到 QuickJS Worker 的 JSON 树。
 */
function tokenizeMockMedia(
  value: unknown,
  opaqueValues: Map<string, unknown>
): unknown {
  if (typeof value === "string" && value.startsWith("mock://media/")) {
    const token = createApiUpstreamOpaqueToken();
    opaqueValues.set(token, value);
    return token;
  }
  if (Array.isArray(value)) {
    return value.map((item) => tokenizeMockMedia(item, opaqueValues));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      tokenizeMockMedia(child, opaqueValues),
    ])
  );
}

/**
 * 执行一次无网络 API 上游脚本测试。
 *
 * 空请求脚本预览空修改信封；空响应脚本要求样例本身已是标准结果。非空脚本
 * 使用生产 Worker、共享 schema 和模拟媒体令牌，不读取成员、密钥或网络。
 */
export async function executeApiUpstreamAdapterTestBinding(
  input: ApiUpstreamAdapterTestInput,
  dependencies: Pick<
    ImageBackendPoolBindingDependencies,
    "runScript"
  > = defaultDependencies
): Promise<{ preview: unknown }> {
  try {
    const sample =
      input.stage === "request"
        ? apiUpstreamRequestInputSchema.parse(input.sample)
        : apiUpstreamResponseInputSchema.parse(input.sample);
    const opaqueValues = new Map<string, unknown>();
    const tokenizedSample = Object.hasOwn(sample, "body")
      ? {
          ...sample,
          body: tokenizeMockMedia(sample.body, opaqueValues),
        }
      : sample;
    assertApiUpstreamOpaqueValuesPreserved(tokenizedSample, opaqueValues);
    const modelId = readSampleModelId(sample);
    const context = apiUpstreamScriptContextSchema.parse({
      operation: input.operation,
      stage: input.stage,
      contentType:
        input.operation === "images.edit"
          ? "multipart/form-data"
          : "application/json",
      platformModelId: modelId,
      upstreamModelId: modelId,
      ...(input.operation.includes("query")
        ? { taskId: readSampleTaskId(sample) }
        : {}),
    });
    const rawOutput = input.script.trim()
      ? await dependencies.runScript(tokenizedSample, input.script, context, {
          operation: input.operation,
          stage: input.stage,
          priority: "admin",
        })
      : input.stage === "request"
        ? {}
        : tokenizedSample;
    const parsed =
      input.stage === "request"
        ? parseApiUpstreamRequestEnvelope(input.operation, rawOutput)
        : apiUpstreamResponseResultForOperationSchema(input.operation).parse(
            rawOutput
          );
    if (input.stage === "request") {
      const requestSample =
        apiUpstreamRequestInputSchema.parse(tokenizedSample);
      assertApiUpstreamOpaqueValuesPreserved(
        {
          query: "query" in parsed ? parsed.query : requestSample.query,
          headers: "headers" in parsed ? parsed.headers : {},
          ...(requestSample.body !== undefined ||
          ("body" in parsed && parsed.body !== undefined)
            ? {
                body:
                  "body" in parsed && parsed.body !== undefined
                    ? parsed.body
                    : requestSample.body,
              }
            : {}),
        },
        opaqueValues
      );
    } else {
      assertApiUpstreamOpaqueValuesPreserved(parsed, opaqueValues);
    }
    return {
      preview: restoreApiUpstreamOpaqueValues(parsed, opaqueValues),
    };
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError(
      "validation_error",
      "供应商请求处理脚本测试失败，请检查脚本和样例"
    );
  }
}

/** 读取当前进程的脱敏 Worker 快照并映射到共享 UOL 输出。 */
export function executeApiUpstreamRuntimeDiagnosticsBinding(
  dependencies: Pick<
    ImageBackendPoolBindingDependencies,
    "getRuntimeDiagnostics"
  > = defaultDependencies
) {
  const diagnostics = dependencies.getRuntimeDiagnostics();
  return {
    lifecycle: diagnostics.state,
    workerCount: diagnostics.configuredWorkers,
    liveWorkerCount: diagnostics.readyWorkers,
    requestQueueLength: diagnostics.queuedRequests,
    responseQueueLength: diagnostics.queuedResponses,
    responsePermitsInUse: diagnostics.activeResponsePermits,
    responsePermitCapacity: diagnostics.responsePermitCapacity,
    saturationCount: diagnostics.saturationCount,
    replacementCount: diagnostics.replacementCount,
  } as const;
}

/** 把 Go HTTP 错误映射为 UOL 稳定错误码。 */
function throwGoPoolError(error: unknown): never {
  if (error instanceof GoBackendRequestError) {
    const code = error.code === "FORBIDDEN" ? "forbidden" : error.code === "NOT_FOUND" ? "not_found" : error.code === "CONFLICT" ? "conflict" : error.code === "INVALID_REQUEST" ? "validation_error" : "internal_error";
    throw new OperationError(code, error.message);
  }
  throw error;
}

async function requestPool<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  try {
    return await requestGoJson<T>(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throwGoPoolError(error);
  }
}

/** 获取用户可选择的启用分组。 */
bindExecute("pool.getGroupOptions", async () => requestPool("/api/image-backend/groups/options"));

/** 读取统一分组和成员的脱敏管理快照。 */
bindExecute("pool.getAdminPool", async () => requestPool("/api/admin/image-backend/pool"));

/** 按人工页面筛选分页成员。Go 端负责权限和分页。 */
bindExecute("pool.listAdminMembers", async (input: Record<string, unknown>) => {
  const query = new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]));
  return requestPool(`/api/admin/image-backend/members?${query}`);
});

/** 按人工页面名称条件分页分组。 */
bindExecute("pool.listAdminGroups", async (input: Record<string, unknown>) => {
  const query = new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]));
  return requestPool(`/api/admin/image-backend/groups?${query}`);
});

bindExecute("pool.listImageSizeConfigs", async () => requestPool("/api/admin/image-backend/size-configs"));
bindExecute("pool.getImageSizeConfigOptions", async () => {
  const result = await requestPool<{ configs: Array<{ id: string; name: string }> }>("/api/admin/image-backend/size-configs");
  return { options: result.configs.map(({ id, name }) => ({ id, name })) };
});
bindExecute("pool.saveImageSizeConfig", async (input: unknown) => requestPool("/api/admin/image-backend/size-configs", "POST", input));
bindExecute("pool.deleteImageSizeConfig", async (input: { id: string }) => requestPool(`/api/admin/image-backend/size-configs/${encodeURIComponent(input.id)}`, "DELETE"));
bindExecute("pool.saveGroup", async (input: unknown) => requestPool("/api/admin/image-backend/groups", "POST", input));
bindExecute("pool.deleteGroup", async (input: { id: string }) => requestPool(`/api/admin/image-backend/groups/${encodeURIComponent(input.id)}`, "DELETE"));
bindExecute("pool.saveMember", async (input: unknown) => requestPool("/api/admin/image-backend/members", "POST", input));
bindExecute("pool.testApiUpstreamAdapter", async (input: ApiUpstreamAdapterTestInput) => requestPool("/api/admin/image-backend/script-runtime/test", "POST", input));
bindExecute("pool.getApiUpstreamRuntimeDiagnostics", async () => requestPool("/api/admin/image-backend/script-runtime/diagnostics"));
bindExecute("pool.resetMemberStatus", async (input: { id: string }) => requestPool(`/api/admin/image-backend/members/${encodeURIComponent(input.id)}/reset-status`, "POST"));
bindExecute("pool.setMemberEnabled", async (input: { id: string; isEnabled: boolean }) => requestPool(`/api/admin/image-backend/members/${encodeURIComponent(input.id)}/enabled`, "POST", { isEnabled: input.isEnabled }));
bindExecute("pool.deleteMember", async (input: { id: string }) => requestPool(`/api/admin/image-backend/members/${encodeURIComponent(input.id)}`, "DELETE"));

