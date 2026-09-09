/**
 * API 上游适配器管理草稿与合成样例。
 *
 * 职责：为成员表单提供六操作稳定结构、媒体分区元数据和无网络测试样例；
 * 本模块不执行脚本、不读取账号密钥，也不依赖 React。
 */
import {
  API_UPSTREAM_BUILT_IN_PATHS,
  type ApiUpstreamAdapterDraft,
  type ApiUpstreamOperations,
  apiVideoInputFormatSchema,
  apiVideoProtocolModeSchema,
  createDefaultApiUpstreamOperations,
  DEFAULT_VIDEO_SUBMISSION_RETRY_COUNT,
  resolveApiUpstreamOperationPath,
} from "@repo/shared/image-backend/api-upstream-adaptation";
import type { ApiUpstreamAdapterOperationId } from "@repo/shared/image-backend/api-upstream-script-contract";

/** 管理表单中与账号密钥分离的 API 适配草稿。 */
export interface ApiUpstreamAdapterFormDraft {
  /** 图生图参考图是否先转存并转换为绝对公网 URL。 */
  convertReferenceImagesToPublicUrl: boolean;
  authentication: ApiUpstreamAdapterDraft["authentication"];
  videoSubmissionRetryCount: number;
  videoProtocolMode: ApiUpstreamAdapterDraft["videoProtocolMode"];
  videoInputFormat: NonNullable<ApiUpstreamAdapterDraft["videoInputFormat"]>;
  /** 兼容旧适配版本；管理表单不再编辑账号级输入能力。 */
  videoInputCapabilities: ApiUpstreamAdapterDraft["videoInputCapabilities"];
  videoInputCapabilitiesByModel: ApiUpstreamAdapterDraft["videoInputCapabilitiesByModel"];
  operations: ApiUpstreamOperations;
  expectedCurrentVersionId?: string;
}

/** 管理表单一个媒体折叠区的稳定描述。 */
export interface ApiUpstreamMediaSectionDefinition {
  id: "text-image" | "image-edit" | "video";
  title: string;
  description: string;
  generateOperation: ApiUpstreamAdapterOperationId;
  queryOperation: ApiUpstreamAdapterOperationId;
}

/** 三种媒体类型及其生成、查询操作映射。 */
export const API_UPSTREAM_MEDIA_SECTIONS = [
  {
    id: "text-image",
    title: "文生图",
    description: "文本生成图片；上游可同步返回图片，也可返回异步任务。",
    generateOperation: "images.generate",
    queryOperation: "images.generate.query",
  },
  {
    id: "image-edit",
    title: "图生图",
    description: "单图、多图或蒙版编辑；可选择 multipart 或公网 URL JSON。",
    generateOperation: "images.edit",
    queryOperation: "images.edit.query",
  },
  {
    id: "video",
    title: "生视频",
    description:
      "文生视频、首尾帧、参考图、参考视频或参考音频生成；能力由账号标签决定。",
    generateOperation: "videos.generate",
    queryOperation: "videos.query",
  },
] as const satisfies readonly ApiUpstreamMediaSectionDefinition[];

/** 创建新 API 成员的空脚本草稿。 */
export function createDefaultApiUpstreamAdapterFormDraft(): ApiUpstreamAdapterFormDraft {
  return {
    convertReferenceImagesToPublicUrl: false,
    authentication: { mode: "bearer" },
    videoSubmissionRetryCount: DEFAULT_VIDEO_SUBMISSION_RETRY_COUNT,
    videoProtocolMode: apiVideoProtocolModeSchema.parse("custom"),
    videoInputFormat: apiVideoInputFormatSchema.parse("url"),
    videoInputCapabilities: {
      referenceVideos: false,
      referenceAudios: false,
    },
    videoInputCapabilitiesByModel: {},
    operations: createDefaultApiUpstreamOperations(),
  };
}

/** 返回固定 HTTP Method，管理员和脚本都不能修改。 */
export function getApiUpstreamOperationMethod(
  operation: ApiUpstreamAdapterOperationId
): "GET" | "POST" {
  return operation.includes("query") ? "GET" : "POST";
}

/** 返回空路径采用的内置提示；图片查询没有内置接口。 */
export function getApiUpstreamBuiltInPathHint(
  operation: ApiUpstreamAdapterOperationId
): string {
  return API_UPSTREAM_BUILT_IN_PATHS[operation] ?? "无内置查询路径";
}

/** 判断查询操作当前是否存在内置或自定义路径。 */
export function hasApiUpstreamQueryPath(
  operation: ApiUpstreamAdapterOperationId,
  path: string
): boolean {
  try {
    return resolveApiUpstreamOperationPath(operation, path) !== null;
  } catch {
    return false;
  }
}

/** 为请求脚本提供不含密钥和真实媒体的合成输入。 */
function createRequestSample(
  operation: ApiUpstreamAdapterOperationId
): unknown {
  switch (operation) {
    case "images.generate":
      return {
        query: {},
        body: {
          model: "gpt-image-2",
          prompt: "A lighthouse at sunset",
          aspectRatio: "1:1",
          resolution: "1k",
          client_request_id: "sample-image-request",
        },
      };
    case "images.generate.query":
      return { query: {} };
    case "images.edit":
      return {
        query: {},
        body: {
          model: "gpt-image-2",
          prompt: "Change the sky to sunset",
          "image[]": ["mock://media/reference-1", "mock://media/reference-2"],
          mask: "mock://media/mask-1",
          client_request_id: "sample-edit-request",
        },
      };
    case "images.edit.query":
      return { query: {} };
    case "videos.generate":
      return {
        query: {},
        body: {
          model: "seedance2",
          prompt: "A hero walking through a neon city",
          duration: 8,
          aspect_ratio: "16:9",
          resolution: "1080p",
          reference_images: [
            "mock://media/reference-1",
            "mock://media/reference-2",
          ],
          reference_videos: ["https://media.example/reference.mp4"],
          reference_audios: ["https://media.example/reference.mp3"],
          client_request_id: "sample-video-request",
        },
      };
    case "videos.query":
      return { query: {} };
  }
}

/** 为响应脚本提供有界、无二进制正文的合成 HTTP 响应视图。 */
function createResponseSample(
  operation: ApiUpstreamAdapterOperationId
): unknown {
  const isQuery = operation.includes("query");
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      ...(isQuery ? { "retry-after": "5" } : {}),
    },
    body: isQuery
      ? { id: "sample-task", status: "processing", progress: 42 }
      : { id: "sample-task", status: "queued" },
  };
}

/** 返回指定操作与阶段的默认无网络测试样例。 */
export function getDefaultApiUpstreamScriptSample(
  operation: ApiUpstreamAdapterOperationId,
  stage: "request" | "response"
): unknown {
  return stage === "request"
    ? createRequestSample(operation)
    : createResponseSample(operation);
}

/** 把合成样例格式化为管理员可编辑的 JSON。 */
export function formatApiUpstreamScriptSample(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
