/**
 * API 上游请求脚本信封合并。
 *
 * 职责：只向 Worker 提供 Query、令牌化 Body 与脱敏上下文，校验部分信封后按“省略即
 * 保留”语义合并，并验证受保护媒体令牌恰好保留一次。
 */
import type { ApiUpstreamOperationConfig } from "@repo/shared/image-backend/api-upstream-adaptation";
import {
  type ApiUpstreamAdapterOperationId,
  type ApiUpstreamQuery,
  type ApiUpstreamQueryValue,
  type ApiUpstreamRequestEnvelope,
  type ApiUpstreamScriptContext,
  apiUpstreamRequestInputSchema,
  apiUpstreamQuerySchema,
  parseApiUpstreamRequestEnvelope,
} from "@repo/shared/image-backend/api-upstream-script-contract";

import {
  type ApiUpstreamOpaqueValues,
  assertApiUpstreamOpaqueValuesPreserved,
  restoreApiUpstreamOpaqueValues,
} from "./api-upstream-opaque-values";
import { runApiUpstreamScript } from "./api-upstream-script-runtime";

/** 执行器可直接编码的完整请求信封。 */
export interface ResolvedApiUpstreamRequestEnvelope {
  query: ApiUpstreamQuery;
  headers: Record<string, string>;
  body?: unknown;
}

/** 以覆盖或删除语义合并内置 Query 与脚本 Query。 */
function mergeQuery(
  builtInQuery: ApiUpstreamQuery,
  scriptQuery: ApiUpstreamQuery | undefined
): ApiUpstreamQuery {
  const merged: Record<string, ApiUpstreamQueryValue> = { ...builtInQuery };
  for (const [key, value] of Object.entries(scriptQuery ?? {})) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/**
 * 执行并解析一个请求脚本。
 *
 * @param input 固定操作、内置请求、版本脚本、上下文和宿主媒体令牌。
 * @returns 合并后的 Query、业务 Header 与已恢复媒体的 Body。
 * @throws 脚本、信封或媒体令牌违反契约时失败关闭，且此时尚未外呼。
 */
export async function resolveApiUpstreamRequestEnvelope(input: {
  operation: ApiUpstreamAdapterOperationId;
  operationConfig: ApiUpstreamOperationConfig;
  query?: ApiUpstreamQuery;
  body?: unknown;
  context: ApiUpstreamScriptContext;
  opaqueValues?: ApiUpstreamOpaqueValues;
}): Promise<ResolvedApiUpstreamRequestEnvelope> {
  const builtInQuery = input.query ?? {};
  const opaqueValues = input.opaqueValues ?? new Map();
  if (input.body !== undefined) {
    assertApiUpstreamOpaqueValuesPreserved(input.body, opaqueValues);
  } else if (opaqueValues.size > 0) {
    throw new Error("API 上游媒体令牌缺少请求正文");
  }

  let scriptEnvelope: ApiUpstreamRequestEnvelope = {};
  if (input.operationConfig.requestScript) {
    const scriptInput = apiUpstreamRequestInputSchema.parse({
      query: builtInQuery,
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    const rawOutput = await runApiUpstreamScript(
      scriptInput,
      input.operationConfig.requestScript,
      input.context,
      {
        operation: input.operation,
        stage: "request",
        priority: "request",
      }
    );
    scriptEnvelope = parseApiUpstreamRequestEnvelope(
      input.operation,
      rawOutput
    );
  }

  const body =
    scriptEnvelope.body === undefined ? input.body : scriptEnvelope.body;
  const query = apiUpstreamQuerySchema.parse(
    mergeQuery(builtInQuery, scriptEnvelope.query)
  );
  const headers = scriptEnvelope.headers ?? {};
  const envelope = {
    // WHY：内置 Query 和脚本 Query 分别合法，不代表合并后的值数量与编码字节仍
    // 在预算内；最终外呼前必须对完整 Query 再做一次统一校验。
    query,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
  // WHY：真实媒体只会在 Body 中恢复，先检查 Body 可阻止脚本把令牌移动到 Query
  // 或 Header；随后检查完整信封，阻止在保留 Body 令牌的同时向其他位置复制。
  assertApiUpstreamOpaqueValuesPreserved(body, opaqueValues);
  assertApiUpstreamOpaqueValuesPreserved(envelope, opaqueValues);
  return {
    query,
    headers,
    ...(body !== undefined
      ? { body: restoreApiUpstreamOpaqueValues(body, opaqueValues) }
      : {}),
  };
}
