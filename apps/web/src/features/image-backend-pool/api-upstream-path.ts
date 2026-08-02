/**
 * API 上游操作路径解析。
 *
 * 职责：把版本化相对路径固定在管理员 baseUrl 下，并只由宿主替换任务 ID、编码 Query。
 * 使用方：通用 API 上游执行器；脚本与上游响应都不能提供或覆盖目标 URL。
 */
import {
  type ApiUpstreamOperations,
  resolveApiUpstreamOperationPath,
} from "@repo/shared/image-backend/api-upstream-adaptation";
import type {
  ApiUpstreamAdapterOperationId,
  ApiUpstreamQueryValue,
} from "@repo/shared/image-backend/api-upstream-script-contract";

import { parseMediaUpstreamUrl } from "./media-upstream-url";

/** 将单个 Query 值按保序重复参数编码；null 由合并阶段删除，不进入 URL。 */
function appendQueryValue(
  searchParams: URLSearchParams,
  key: string,
  value: Exclude<ApiUpstreamQueryValue, null>
): void {
  for (const item of Array.isArray(value) ? value : [value]) {
    searchParams.append(key, String(item));
  }
}

/**
 * 解析一个固定供应商操作的最终 URL。
 *
 * @param input 版本化路径、任务 ID 和已校验 Query。
 * @returns 与 baseUrl 同源且保留 base path 的 HTTP(S) URL。
 * @throws 查询操作缺少路径/任务 ID或最终 URL 改变 origin 时失败关闭。
 */
export function resolveApiUpstreamRequestUrl(input: {
  baseUrl: string;
  operation: ApiUpstreamAdapterOperationId;
  operations: ApiUpstreamOperations;
  taskId?: string;
  query: Readonly<Record<string, ApiUpstreamQueryValue>>;
}): URL {
  const base = parseMediaUpstreamUrl(input.baseUrl);
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("API 上游 baseUrl 不能包含用户信息、Query 或 Fragment");
  }
  const configuredPath = resolveApiUpstreamOperationPath(
    input.operation,
    input.operations[input.operation].path
  );
  if (!configuredPath) {
    throw new Error("API 上游查询操作未配置路径");
  }
  let path = configuredPath;
  if (path.includes("{task_id}")) {
    if (!input.taskId?.trim()) {
      throw new Error("API 上游查询操作缺少任务 ID");
    }
    // WHY：WHATWG URL 会把字面量及百分号编码的 `.` / `..` 路径段归一化。
    // `encodeURIComponent` 不编码点号，因此必须在替换前拒绝这两个完整段，避免
    // 查询请求带认证信息逃离管理员配置的固定路径。
    if (input.taskId === "." || input.taskId === "..") {
      throw new Error("API 上游任务 ID 不能是路径 dot segment");
    }
    path = path.replace("{task_id}", encodeURIComponent(input.taskId));
  }
  const target = parseMediaUpstreamUrl(
    `${base.toString().replace(/\/+$/, "")}${path}`
  );
  if (target.origin !== base.origin) {
    throw new Error("API 上游操作路径改变了目标 origin");
  }
  for (const [key, value] of Object.entries(input.query)) {
    if (value !== null) appendQueryValue(target.searchParams, key, value);
  }
  return target;
}
