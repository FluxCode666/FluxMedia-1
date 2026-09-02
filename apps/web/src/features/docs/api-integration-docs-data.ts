/**
 * 公开 API 接入文档的数据源。
 *
 * 内容从管理员系统文档的外接 API 章节提炼。数据源公开列出模型、积分、图片生成、
 * 图片编辑、图片任务，以及视频能力、视频生成和视频任务八个现行端点。
 */
import { getSiteBaseUrl } from "@repo/shared/config";

import {
  DOCUMENTATION_BASE_URL_PLACEHOLDER,
  replaceDocumentationBaseUrl,
} from "./documentation-base-url";
import {
  IMAGE_SIZE_DOC_TABLE_HEADERS_EN,
  IMAGE_SIZE_DOC_TABLE_HEADERS_ZH,
  IMAGE_SIZE_DOC_TABLE_NOTE_EN,
  IMAGE_SIZE_DOC_TABLE_NOTE_ZH,
  IMAGE_SIZE_DOC_TABLE_ROWS,
} from "./image-size-docs";

export type ApiIntegrationParameter = {
  name: string;
  requirement: string;
  defaultValue?: string;
  description: string;
};

export type ApiIntegrationResponseField = {
  name: string;
  description: string;
};

export type ApiIntegrationEndpointGroup = {
  id: string;
  title: string;
  description: string;
  endpointIds: readonly string[];
};

export type ApiIntegrationProtocol = "fluxmedia" | "gemini";

export type ApiIntegrationEndpointContent = {
  title: string;
  method: "GET" | "POST";
  path: string;
  contentType: string;
  description: string;
  deprecationNotice?: string;
  requestExample: string;
  responseExample: string;
  parameters: readonly ApiIntegrationParameter[];
  responses: readonly ApiIntegrationResponseField[];
  notes: readonly string[];
};

export type ApiIntegrationEndpoint = ApiIntegrationEndpointContent & {
  id: string;
  operation: "models" | "credits" | "image_generation" | "image_edit" | "video";
  protocols?: Partial<
    Record<ApiIntegrationProtocol, ApiIntegrationEndpointContent>
  >;
};

export type ApiIntegrationDocsContent = {
  eyebrow: string;
  title: string;
  subtitle: string;
  baseUrl: string;
  baseUrlLabel: string;
  authLabel: string;
  authValue: string;
  directoryTitle: string;
  directoryDescription: string;
  endpointsTitle: string;
  parametersTitle: string;
  responsesTitle: string;
  notesTitle: string;
  requestExampleTitle: string;
  responseExampleTitle: string;
  protocolTabs: {
    ariaLabel: string;
    fluxmedia: string;
    gemini: string;
  };
  parameterHeaders: readonly [string, string, string, string];
  responseHeaders: readonly [string, string];
  copyLabels: {
    copy: string;
    copied: string;
    copyFailed: string;
  };
  groups: readonly ApiIntegrationEndpointGroup[];
  endpoints: readonly ApiIntegrationEndpoint[];
  imageSizeTable: {
    title: string;
    description: string;
    headers: readonly string[];
    rows: readonly (readonly string[])[];
    note: string;
  };
};

/** 首页快速集成只需要的最小公开 API 文档契约。 */
export type ApiIntegrationHomepageContract = {
  endpoint: Pick<ApiIntegrationEndpoint, "contentType" | "method" | "path">;
  authentication: {
    headerName: "Authorization";
    scheme: "Bearer";
    environmentVariable: "FLUXMEDIA_API_KEY";
  };
  copyLabels: ApiIntegrationDocsContent["copyLabels"];
};

const IMAGE_GENERATION_ENDPOINT_ID = "image-generations";
const API_INTEGRATION_GROUP_ENDPOINT_IDS = {
  basics: ["models", "credits"],
  images: ["image-generations", "image-edits", "image-task"],
  videos: ["video-generations", "video-capabilities", "video-task"],
} as const;
const API_KEY_AUTHENTICATION = {
  headerName: "Authorization",
  scheme: "Bearer",
  environmentVariable: "FLUXMEDIA_API_KEY",
} as const;

/** Gemini 视频兼容端点的公开文档变体；不暴露内部任务字段或供应商配置。 */
function getGeminiVideoProtocolVariants(
  locale: "zh" | "en"
): Record<
  "video-generations" | "video-capabilities" | "video-task",
  ApiIntegrationEndpointContent
> {
  if (locale === "zh") {
    return {
      "video-generations": {
        title: "Gemini 创建视频",
        method: "POST",
        path: "/v1beta/models/{model}:predictLongRunning",
        contentType: "application/json",
        description:
          "按 Gemini Veo predictLongRunning 请求格式创建视频，并返回可轮询的 Gemini Operation。模型名称位于 URL，不放在请求体中。",
        requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1beta/models/veo-3.1-generate-preview:predictLongRunning \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: gemini-video-request-001" \\
  -d '{
    "instances": [
      {
        "prompt": "A hero walking through a neon city",
        "image": {
          "inlineData": {
            "mimeType": "image/png",
            "data": "<BASE64_FIRST_FRAME_IMAGE>"
          }
        },
        "reference_videos": ["https://media.example/reference.mp4"],
        "reference_audios": ["https://media.example/reference.mp3"]
      }
    ],
    "parameters": {
      "aspectRatio": "16:9",
      "resolution": "720p",
      "durationSeconds": "8"
    }
  }'`,
        responseExample: `{
  "name": "models/veo-3.1-generate-preview/operations/operation_0123456789abcdef",
  "done": false
}`,
        parameters: [
          {
            name: "model",
            requirement: "必填路径参数",
            description:
              "Gemini 模型名，例如 veo-3.1-generate-preview；必须放在 URL 路径中，不能在 body 中传 model。",
          },
          {
            name: "instances",
            requirement: "必填",
            description:
              "只允许一个实例，实例必须包含 prompt；可选 image、lastFrame 或 referenceImages。",
          },
          {
            name: "instances[].prompt",
            requirement: "必填",
            description: "视频提示词，最多 100000 字符。",
          },
          {
            name: "instances[].image (首帧) / lastFrame",
            requirement: "可选",
            defaultValue: "无",
            description:
              "使用 inlineData 传入 base64 图片；lastFrame 必须同时提供 image。",
          },
          {
            name: "instances[].referenceImages",
            requirement: "可选",
            defaultValue: "无",
            description:
              "最多 3 张带 referenceType 的 inlineData 图片；不能与 image 同时传入。",
          },
          {
            name: "instances[].reference_videos",
            requirement: "可选",
            defaultValue: "空数组",
            description:
              "HTTPS mp4/mov 参考视频直链，最多 3 个；每个不超过 200 MB，单条 4-10 秒，全部合计不超过 15 秒。",
          },
          {
            name: "instances[].reference_audios",
            requirement: "可选",
            defaultValue: "空数组",
            description:
              "HTTPS mp3/wav 参考音频直链，最多 1 个；不超过 15 MB 且不超过 15 秒。",
          },
          {
            name: "parameters.aspectRatio",
            requirement: "可选",
            defaultValue: "16:9",
            description: "视频宽高比。",
          },
          {
            name: "parameters.resolution",
            requirement: "可选",
            defaultValue: "720p",
            description: "视频输出分辨率。",
          },
          {
            name: "parameters.durationSeconds",
            requirement: "可选",
            defaultValue: "8",
            description:
              '视频时长，按 Gemini REST 的 int64 JSON 形式传字符串 "4"、"6" 或 "8"。',
          },
          {
            name: "Idempotency-Key / x-request-id",
            requirement: "可选 header",
            defaultValue: "服务端生成",
            description:
              "幂等请求标识；两个 header 同时提供时必须一致，最长 128 个字符。",
          },
        ],
        responses: [
          { name: "name", description: "Gemini Operation 名称。" },
          {
            name: "done",
            description: "任务完成或失败时为 true；排队中为 false。",
          },
          {
            name: "error",
            description: "创建阶段立即失败时返回的 Google Status 风格错误。",
          },
        ],
        notes: [
          "接口返回 Gemini Long-Running Operation，不会在当前连接中等待视频完成。",
          "使用 GET /v1beta/models/{model}/operations/{operationId} 查询同一任务。",
          "Authorization 仍使用 FluxMedia API Key；请求体字段遵循 Gemini 格式。",
        ],
      },
      "video-capabilities": {
        title: "Gemini 能力发现",
        method: "GET",
        path: "不适用",
        contentType: "无请求体",
        description:
          "Gemini 视频协议没有与 FluxMedia /v1/videos/capabilities 等价的独立能力接口；请根据 Gemini 模型文档选择模型和参数。",
        requestExample:
          "# Gemini 协议没有对应的能力发现请求\n# 直接使用支持的模型路径调用 predictLongRunning",
        responseExample: "// Gemini 协议没有对应的能力发现响应",
        parameters: [],
        responses: [],
        notes: [
          "本卡片仅用于说明协议差异，不对应 FluxMedia 已提供的可调用路由。",
          "创建请求中的 model、aspectRatio、resolution 和 durationSeconds 仍会由服务端校验；durationSeconds 使用字符串形式。",
        ],
      },
      "video-task": {
        title: "查询 Gemini Operation",
        method: "GET",
        path: "/v1beta/models/{model}/operations/{operationId}",
        contentType: "无请求体",
        description: "按 Gemini Operation 名称查询视频生成状态和结果。",
        requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1beta/models/veo-3.1-generate-preview/operations/operation_0123456789abcdef \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY"`,
        responseExample: `{
  "name": "models/veo-3.1-generate-preview/operations/operation_0123456789abcdef",
  "done": true,
  "response": {
    "generateVideoResponse": {
      "generatedSamples": [
        {
          "video": {
            "uri": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."
          }
        }
      ]
    }
  }
}`,
        parameters: [
          {
            name: "model",
            requirement: "必填路径参数",
            description: "创建 Operation 时使用的 Gemini 模型名。",
          },
          {
            name: "operationId",
            requirement: "必填路径参数",
            description: "创建接口响应 name 中 operations/ 后面的不透明 ID。",
          },
        ],
        responses: [
          { name: "name", description: "完整 Gemini Operation 名称。" },
          { name: "done", description: "任务完成或失败时为 true。" },
          {
            name: "response.generateVideoResponse.generatedSamples[].video.uri",
            description: "任务完成后返回的视频 HTTPS URL。",
          },
          {
            name: "error",
            description: "任务失败时返回的 Google Status 风格错误。",
          },
        ],
        notes: [
          "任务进行中只返回 name 和 done=false，不返回 response 或 error。",
          "任务完成时返回 response；任务失败时返回 error，二者不会同时出现。",
          "Operation 只能由创建它的 API Key 查询，并且可跨服务重启查询。",
        ],
      },
    };
  }

  return {
    "video-generations": {
      title: "Create Gemini video",
      method: "POST",
      path: "/v1beta/models/{model}:predictLongRunning",
      contentType: "application/json",
      description:
        "Create a video with the Gemini Veo predictLongRunning request shape and return a pollable Gemini Operation. The model is in the URL, not the request body.",
      requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1beta/models/veo-3.1-generate-preview:predictLongRunning \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: gemini-video-request-001" \\
  -d '{
    "instances": [
      {
        "prompt": "A hero walking through a neon city",
        "image": {
          "inlineData": {
            "mimeType": "image/png",
            "data": "<BASE64_FIRST_FRAME_IMAGE>"
          }
        },
        "reference_videos": ["https://media.example/reference.mp4"],
        "reference_audios": ["https://media.example/reference.mp3"]
      }
    ],
    "parameters": {
      "aspectRatio": "16:9",
      "resolution": "720p",
      "durationSeconds": "8"
    }
  }'`,
      responseExample: `{
  "name": "models/veo-3.1-generate-preview/operations/operation_0123456789abcdef",
  "done": false
}`,
      parameters: [
        {
          name: "model",
          requirement: "Required path parameter",
          description:
            "Gemini model name such as veo-3.1-generate-preview. Put it in the URL; body.model is not accepted.",
        },
        {
          name: "instances",
          requirement: "Required",
          description:
            "Exactly one instance containing prompt; image, lastFrame, or referenceImages are optional.",
        },
        {
          name: "instances[].prompt",
          requirement: "Required",
          description: "Video prompt, up to 100,000 characters.",
        },
        {
          name: "instances[].image (first frame) / lastFrame",
          requirement: "Optional",
          defaultValue: "None",
          description: "Base64 image in inlineData; lastFrame requires image.",
        },
        {
          name: "instances[].referenceImages",
          requirement: "Optional",
          defaultValue: "None",
          description:
            "Up to three inlineData images with referenceType; mutually exclusive with image.",
        },
        {
          name: "parameters.aspectRatio",
          requirement: "Optional",
          defaultValue: "16:9",
          description: "Video aspect ratio.",
        },
        {
          name: "parameters.resolution",
          requirement: "Optional",
          defaultValue: "720p",
          description: "Video output resolution.",
        },
        {
          name: "parameters.durationSeconds",
          requirement: "Optional",
          defaultValue: "8",
          description:
            'Video duration as a Gemini REST int64 JSON string: "4", "6", or "8".',
        },
        {
          name: "Idempotency-Key / x-request-id",
          requirement: "Optional header",
          defaultValue: "Generated by the server",
          description:
            "Idempotency request identifier. If both headers are sent they must match; maximum 128 characters.",
        },
      ],
      responses: [
        { name: "name", description: "Gemini Operation name." },
        {
          name: "done",
          description: "False while queued; true on completion or failure.",
        },
        {
          name: "error",
          description: "Google Status-style error for an immediate failure.",
        },
      ],
      notes: [
        "The endpoint returns a Gemini Long-Running Operation and does not wait for video completion.",
        "Poll GET /v1beta/models/{model}/operations/{operationId} for the same task.",
        "Authorization uses a FluxMedia API Key while the request body follows the Gemini shape.",
      ],
    },
    "video-capabilities": {
      title: "Gemini capability discovery",
      method: "GET",
      path: "Not applicable",
      contentType: "No request body",
      description:
        "Gemini video has no standalone capability endpoint equivalent to FluxMedia /v1/videos/capabilities. Choose the model and parameters from the Gemini model documentation.",
      requestExample:
        "# Gemini has no equivalent capability request\n# Call predictLongRunning with a supported model instead",
      responseExample: "// Gemini has no equivalent capability response",
      parameters: [],
      responses: [],
      notes: [
        "This tab documents a protocol difference; it is not a callable FluxMedia route.",
        "The create request still validates model, aspectRatio, resolution, and durationSeconds; durationSeconds uses the string form.",
      ],
    },
    "video-task": {
      title: "Get Gemini Operation",
      method: "GET",
      path: "/v1beta/models/{model}/operations/{operationId}",
      contentType: "No request body",
      description:
        "Get video generation status and results by Gemini Operation name.",
      requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1beta/models/veo-3.1-generate-preview/operations/operation_0123456789abcdef \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY"`,
      responseExample: `{
  "name": "models/veo-3.1-generate-preview/operations/operation_0123456789abcdef",
  "done": true,
  "response": {
    "generateVideoResponse": {
      "generatedSamples": [
        {
          "video": {
            "uri": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."
          }
        }
      ]
    }
  }
}`,
      parameters: [
        {
          name: "model",
          requirement: "Required path parameter",
          description: "The Gemini model name used to create the Operation.",
        },
        {
          name: "operationId",
          requirement: "Required path parameter",
          description:
            "The opaque ID after operations/ in the create response name.",
        },
      ],
      responses: [
        { name: "name", description: "Full Gemini Operation name." },
        { name: "done", description: "True when the task completes or fails." },
        {
          name: "response.generateVideoResponse.generatedSamples[].video.uri",
          description: "HTTPS video URL returned after completion.",
        },
        {
          name: "error",
          description: "Google Status-style error when the task fails.",
        },
      ],
      notes: [
        "While running, only name and done=false are returned; response and error are omitted.",
        "A completed Operation contains response or error, never both.",
        "Only the API Key that created the Operation can query it, including after service restarts.",
      ],
    },
  };
}

const zhContent = {
  eyebrow: "FluxMedia External API",
  title: "API 接入文档",
  subtitle:
    "面向服务端集成的媒体 API 参考。先查询当前密钥可见模型与积分额度，再调用图片或视频生成接口并轮询任务状态。",
  baseUrl: DOCUMENTATION_BASE_URL_PLACEHOLDER,
  baseUrlLabel: "Base URL",
  authLabel: "鉴权",
  authValue: "Authorization: Bearer <API_KEY>",
  directoryTitle: "接口目录",
  directoryDescription: "展开模块后，点击具体接口定位。",
  endpointsTitle: "接口参考",
  parametersTitle: "请求参数",
  responsesTitle: "响应字段",
  notesTitle: "使用说明",
  requestExampleTitle: "请求示例",
  responseExampleTitle: "响应示例",
  protocolTabs: {
    ariaLabel: "视频接口规范",
    fluxmedia: "FluxMedia 接口规范",
    gemini: "Gemini 接口规范",
  },
  parameterHeaders: ["参数", "要求", "默认值", "说明"],
  responseHeaders: ["字段", "说明"],
  copyLabels: {
    copy: "复制",
    copied: "已复制",
    copyFailed: "复制失败",
  },
  groups: [
    {
      id: "api-basics",
      title: "接入基础",
      description: "确认当前密钥可用的模型范围、账户积分与独立额度。",
      endpointIds: API_INTEGRATION_GROUP_ENDPOINT_IDS.basics,
    },
    {
      id: "image-api",
      title: "生成图片",
      description: "创建、编辑图片，并查询图片任务状态与结果。",
      endpointIds: API_INTEGRATION_GROUP_ENDPOINT_IDS.images,
    },
    {
      id: "video-api",
      title: "生成视频",
      description: "发现模型能力，创建视频并查询持久化任务。",
      endpointIds: API_INTEGRATION_GROUP_ENDPOINT_IDS.videos,
    },
  ],
  imageSizeTable: {
    title: "图片尺寸表",
    description:
      "尺寸配置集按分辨率和宽高比维护到上游尺寸的映射；图片接口不再接受 size 参数。",
    headers: IMAGE_SIZE_DOC_TABLE_HEADERS_ZH,
    rows: IMAGE_SIZE_DOC_TABLE_ROWS,
    note: IMAGE_SIZE_DOC_TABLE_NOTE_ZH,
  },
  endpoints: [
    {
      id: "models",
      operation: "models",
      title: "查询可用模型",
      method: "GET",
      path: "/v1/models",
      contentType: "无请求体",
      description: "列出当前 API 密钥绑定分组实际可用的图片与视频模型。",
      requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/models \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY"`,
      responseExample: `{
  "object": "list",
  "data": [
    {
      "id": "gpt-image-2",
      "object": "model",
      "created": 0,
      "owned_by": "gpt2image"
    },
    {
      "id": "seedance2",
      "object": "model",
      "created": 0,
      "owned_by": "gpt2image"
    }
  ]
}`,
      parameters: [
        {
          name: "Authorization",
          requirement: "必填 header",
          description: "Bearer <API_KEY>。",
        },
      ],
      responses: [
        { name: "object", description: "固定为 list。" },
        {
          name: "data[].id",
          description:
            "当前密钥可调度的真实模型 ID；未配置可达成员时列表可能为空。",
        },
        {
          name: "data[].object / created / owned_by",
          description: "兼容 OpenAI model object 的固定元数据。",
        },
      ],
      notes: [
        "结果受 API 密钥绑定分组、组内启用成员的显式模型列表和系统能力开关约束。",
        "只提供模型列表，不提供 /v1/models/{model} 详情端点。",
        "响应使用 Cache-Control: no-store；生成前应重新查询，不要在客户端维护固定模型清单。",
      ],
    },
    {
      id: "credits",
      operation: "credits",
      title: "查询积分与密钥额度",
      method: "GET",
      path: "/v1/credits",
      contentType: "无请求体",
      description:
        "查询当前 API 密钥的积分限额、已用额度、剩余额度和所属账户余额。",
      requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/credits \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY"`,
      responseExample: `{
  "object": "credit_balance",
  "account": {
    "balance": 15702.45,
    "total_earned": 20000,
    "total_spent": 4297.55,
    "status": "active"
  },
  "api_key": {
    "id": "key_...",
    "name": "Production",
    "key_prefix": "fm_live_",
    "last_four": "a1b2",
    "is_active": true,
    "credit_limit": 1000,
    "credits_used": 12.7,
    "credits_remaining": 987.3,
    "unlimited": false,
    "last_used_at": "2026-08-03T01:02:03.000Z",
    "created_at": "2026-08-01T01:02:03.000Z"
  }
}`,
      parameters: [
        {
          name: "Authorization",
          requirement: "必填 header",
          description: "Bearer <API_KEY>。",
        },
      ],
      responses: [
        {
          name: "account.balance",
          description: "API 密钥所属账户的当前可用积分余额。",
        },
        {
          name: "account.total_earned / total_spent / status",
          description: "账户累计获得、累计消耗和当前状态。",
        },
        {
          name: "api_key.id / name / key_prefix / last_four / is_active",
          description: "当前 API 密钥的安全摘要和启用状态，不返回完整密钥。",
        },
        {
          name: "api_key.credit_limit / credits_used / credits_remaining / unlimited",
          description: "当前密钥的额度、已用额度、剩余额度和不限额标记。",
        },
        {
          name: "api_key.last_used_at / created_at",
          description:
            "最近使用时间和创建时间；从未使用时 last_used_at 为 null。",
        },
      ],
      notes: [
        "credit_limit 为 null 时表示不限额，此时 credits_remaining 为 null，unlimited 为 true。",
        "密钥额度和账户余额会共同限制请求；任一不足都可能导致生成请求失败。",
        "响应使用 Cache-Control: no-store，不应由共享缓存保存。",
      ],
    },
    {
      id: "image-generations",
      operation: "image_generation",
      title: "创建图片",
      method: "POST",
      path: "/v1/images/generations",
      contentType: "application/json",
      description:
        "根据文本提示词生成图片，兼容 OpenAI Images generation 请求形态。",
      requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "A quiet reading room in the morning sun",
    "aspectRatio": "1:1",
    "resolution": "1k",
    "quality": "medium",
    "response_format": "url",
    "output_format": "png",
    "background": "auto"
  }'`,
      responseExample: `{
  "created": 1713833628,
  "data": [
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
      "revised_prompt": "..."
    }
  ]
}`,
      parameters: [
        {
          name: "prompt",
          requirement: "必填",
          description: "图片提示词，最多 32000 字符。",
        },
        {
          name: "model",
          requirement: "必填",
          description: "图片模型 ID；可用模型以当前 API 密钥可见范围为准。",
        },
        {
          name: "aspectRatio / aspect_ratio",
          requirement: "可选",
          defaultValue: "未指定（上游决定）",
          description: "图片宽高比，例如 1:1、16:9。两种命名任选其一。",
        },
        {
          name: "resolution",
          requirement: "可选",
          defaultValue: "未指定（上游决定）",
          description:
            "图片分辨率档位，具体可用值取决于所选模型和供应商尺寸配置。",
        },
        {
          name: "quality",
          requirement: "可选",
          defaultValue: "auto",
          description:
            "auto、low、medium 或 high；当前仅 gpt-image-2 可用，其他图片模型不要传此参数。",
        },
        {
          name: "response_format",
          requirement: "可选",
          defaultValue: "b64_json",
          description: "url 或 b64_json；默认返回 b64_json。",
        },
        {
          name: "output_format",
          requirement: "可选",
          defaultValue: "未指定（上游决定）",
          description: "png、jpeg 或 webp。",
        },
        {
          name: "output_compression",
          requirement: "可选",
          defaultValue: "未指定（上游决定）",
          description:
            "控制输出图片的压缩级别，取值 0 到 100：数值越大，压缩力度越大，通常文件越小、画质损失越明显；0 表示不压缩，100 表示最大压缩。仅在 output_format 为 jpeg 或 webp 时生效，不同上游的实际压缩结果可能略有差异。",
        },
        {
          name: "background",
          requirement: "可选",
          defaultValue: "未指定（上游决定）",
          description: "transparent、opaque 或 auto；透明能力取决于模型。",
        },
        {
          name: "stream",
          requirement: "可选",
          defaultValue: "false",
          description:
            "设为 true 或请求 Accept: text/event-stream 时返回事件流。",
        },
      ],
      responses: [
        { name: "created", description: "Unix 秒时间戳。" },
        {
          name: "data[].b64_json / data[].url",
          description: "按 response_format 返回 base64 图片或图片 URL。",
        },
        {
          name: "data[].revised_prompt",
          description: "上游返回的改写提示词；没有改写时可能缺省。",
        },
        {
          name: "SSE image_generation.partial_image",
          description: "流式模式下返回的局部图片事件。",
        },
        {
          name: "SSE image_generation.completed",
          description: "流式模式下表示单张图片已完成。",
        },
      ],
      notes: [
        "response_format 控制返回 URL 或 base64，output_format 控制图片文件格式。",
        "不同模型对尺寸、透明背景和输出格式的支持范围可能不同。",
      ],
    },
    {
      id: "image-edits",
      operation: "image_edit",
      title: "编辑图片",
      method: "POST",
      path: "/v1/images/edits",
      contentType: "multipart/form-data 或 application/json",
      description:
        "根据提示词编辑一张或多张输入图片，兼容 OpenAI Images edit 请求形态。",
      requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY" \\
  -F "model=gpt-image-2" \\
  -F "prompt=Replace the sky with a clear sunset" \\
  -F "image=@./input.png" \\
  -F "aspectRatio=1:1" \\
  -F "resolution=1k" \\
  -F "quality=medium" \\
  -F "response_format=url"`,
      responseExample: `{
  "created": 1713833628,
  "data": [
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
      "revised_prompt": "..."
    }
  ]
}`,
      parameters: [
        {
          name: "prompt",
          requirement: "必填",
          description: "编辑提示词，最多 32000 字符。",
        },
        {
          name: "image / image[] / image_*",
          requirement: "multipart 必填",
          description: "上传图片文件，最多 16 张。",
        },
        {
          name: "images",
          requirement: "JSON 必填",
          description: "JSON 请求中的图片引用数组。",
        },
        {
          name: "mask",
          requirement: "可选",
          defaultValue: "无",
          description: "遮罩图片；透明区域表示需要编辑的范围。",
        },
        {
          name: "model",
          requirement: "必填",
          description: "图片模型 ID；可用模型以当前 API 密钥可见范围为准。",
        },
        {
          name: "aspectRatio / aspect_ratio",
          requirement: "可选",
          defaultValue: "未指定（上游决定）",
          description: "图片宽高比，例如 1:1、16:9。两种命名任选其一。",
        },
        {
          name: "resolution",
          requirement: "可选",
          defaultValue: "未指定（上游决定）",
          description:
            "图片分辨率档位，具体可用值取决于所选模型和供应商尺寸配置。",
        },
        {
          name: "quality",
          requirement: "可选",
          defaultValue: "auto",
          description:
            "auto、low、medium 或 high；当前仅 gpt-image-2 可用，其他图片模型不要传此参数。",
        },
        {
          name: "response_format",
          requirement: "可选",
          defaultValue: "b64_json",
          description: "url 或 b64_json；默认返回 b64_json。",
        },
        {
          name: "output_format",
          requirement: "可选",
          defaultValue: "未指定（上游决定）",
          description: "png、jpeg 或 webp。",
        },
        {
          name: "output_compression",
          requirement: "可选",
          defaultValue: "未指定（上游决定）",
          description:
            "控制输出图片的压缩级别，取值 0 到 100：数值越大，压缩力度越大，通常文件越小、画质损失越明显；0 表示不压缩，100 表示最大压缩。仅在 output_format 为 jpeg 或 webp 时生效，不同上游的实际压缩结果可能略有差异。",
        },
        {
          name: "background",
          requirement: "可选",
          defaultValue: "未指定（上游决定）",
          description: "transparent、opaque 或 auto；透明能力取决于模型。",
        },
        {
          name: "stream",
          requirement: "可选",
          defaultValue: "false",
          description:
            "设为 true 或请求 Accept: text/event-stream 时返回事件流。",
        },
      ],
      responses: [
        { name: "created", description: "Unix 秒时间戳。" },
        {
          name: "data[].b64_json / data[].url",
          description: "按 response_format 返回 base64 图片或图片 URL。",
        },
        {
          name: "data[].revised_prompt",
          description: "上游返回的改写提示词；没有改写时可能缺省。",
        },
        {
          name: "SSE image_edit.partial_image",
          description: "流式模式下返回的局部图片事件。",
        },
        {
          name: "SSE image_edit.completed",
          description: "流式模式下表示单张图片编辑已完成。",
        },
      ],
      notes: [
        "multipart/form-data 适合直接上传文件；JSON 请求使用 images 传入图片引用。",
        "mask 的尺寸与输入图片应保持一致。",
      ],
    },
    {
      id: "video-generations",
      operation: "video",
      title: "创建视频",
      method: "POST",
      path: "/v1/videos/generations",
      contentType: "application/json",
      description:
        "按 FluxMedia 视频协议根据文本提示词或参考图创建持久视频任务。",
      deprecationNotice:
        "POST /v1/videos 已不再提供视频创建，请使用 POST /v1/videos/generations 或 /api/v1/videos/generations。",
      requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos/generations \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "client_request_id": "video-request-001",
    "model": "seedance2",
    "seconds": 8,
    "aspect_ratio": "16:9",
    "resolution": "1080p",
    "prompt": "A hero walking through a neon city",
    "negative_prompt": "low resolution, blur, watermark",
    "quote_token": "opaque-current-quote-token",
    "generate_audio": true,
    "reference_images": ["data:image/png;base64,..."],
    "reference_videos": ["https://media.example/reference.mp4"],
    "reference_audios": ["https://media.example/reference.mp3"]
  }'`,
      responseExample: `{
  "object": "video.task",
  "id": "video_0123456789abcdef0123456789abcdef01234567",
  "task_id": "video_0123456789abcdef0123456789abcdef01234567",
  "generation_id": "video_0123456789abcdef0123456789abcdef01234567",
  "status": "queued",
  "model": "seedance2",
  "duration": 8,
  "duration_seconds": 8,
  "aspectRatio": "16:9",
  "aspect_ratio": "16:9",
  "resolution": "1080p",
  "billing": {
    "kind": "snapshot",
    "mode": "per_second",
    "unit": "second",
    "unitPrice": 3,
    "creditsPerSecond": 3,
    "durationSeconds": 8,
    "quotedCredits": 24,
    "actualCredits": 0
  },
  "generateAudio": true,
  "generate_audio": true
}`,
      parameters: [
        {
          name: "client_request_id / clientRequestId",
          requirement: "必填",
          description: "调用方生成的幂等请求 ID，最长 128 个字符。",
        },
        {
          name: "prompt",
          requirement: "必填",
          description: "视频提示词，最多 32000 字符。",
        },
        {
          name: "model",
          requirement: "必填",
          description:
            "真实视频模型 ID，例如 seedance2、seedance2-fast 或 veo31。不得拼接时长、比例或分辨率；复合 ID 会被拒绝。",
        },
        {
          name: "seconds / duration / duration_seconds",
          requirement: "必填",
          description:
            "独立视频时长（秒）。seconds 兼容正整数或正整数字符串；三个别名并存时必须一致，且归一化值必须受所选模型支持。",
        },
        {
          name: "aspectRatio / aspect_ratio",
          requirement: "必填",
          description: "独立视频宽高比，必须属于所选模型能力。",
        },
        {
          name: "resolution",
          requirement: "必填",
          description: "独立小写输出分辨率，必须属于所选模型能力。",
        },
        {
          name: "quote_token / quoteToken",
          requirement: "可选",
          defaultValue: "省略时由服务端按当前报价创建",
          description:
            "来自 GET /v1/videos/capabilities 对应模型和分辨率 billing 行的短期不透明报价令牌；报价已变化时返回 409 与最新 currentQuote，确认后以新令牌重试。",
        },
        {
          name: "negative_prompt / negativePrompt",
          requirement: "可选",
          defaultValue: "无",
          description: "负向提示词，最多 8000 字符。",
        },
        {
          name: "generate_audio / generateAudio",
          requirement: "可选",
          defaultValue: "模型默认值",
          description:
            "是否生成声音。Seedance 2.0（含 Fast）与 Kling 3.0 Omni 默认关闭，Kling 3.0 默认开启；Runway Gen-4.5 与 Ray 3.14（含 HDR）不支持声音，不支持音频的模型不能传 true。",
        },
        {
          name: "firstFrame / first_frame、lastFrame / last_frame",
          requirement: "可选",
          defaultValue: "无",
          description:
            "首帧与可选尾帧的 base64 image data URL。尾帧必须与首帧同时提供；是否支持尾帧由模型能力决定。",
        },
        {
          name: "referenceImages / reference_images",
          requirement: "可选",
          defaultValue: "空数组",
          description:
            "有序参考图 base64 data URL 数组；数量上限由模型能力决定，Seedance 默认 10 且管理员可配置。参考图与首尾帧对所有模型互斥。",
        },
        {
          name: "referenceVideos / reference_videos",
          requirement: "可选",
          defaultValue: "空数组",
          description:
            "HTTPS mp4/mov 参考视频直链，最多 3 个；单文件不超过 200 MB，单条 4-10 秒，合计不超过 15 秒。仅路由到已声明支持参考视频的账号。",
        },
        {
          name: "referenceAudios / reference_audios",
          requirement: "可选",
          defaultValue: "空数组",
          description:
            "HTTPS mp3/wav 参考音频直链，最多 1 个；不超过 15 MB 且不超过 15 秒。仅路由到已声明支持参考音频的账号。",
        },
        {
          name: "callback_url / callbackUrl",
          requirement: "可选",
          defaultValue: "无",
          description:
            "任务完成或失败时接收任务对象的公网 https webhook 地址。",
        },
      ],
      responses: [
        {
          name: "task_id / id / generation_id",
          description: "同一个持久视频任务 ID。",
        },
        { name: "object", description: "固定为 video.task。" },
        { name: "status", description: "任务初始状态，通常为 queued。" },
        { name: "model", description: "本次使用的真实视频模型 ID。" },
        {
          name: "duration / duration_seconds、aspectRatio / aspect_ratio、resolution",
          description: "本次任务使用的独立视频参数。",
        },
        {
          name: "billing",
          description:
            "创建时锁定的账单快照。mode=per_second 时单价乘时长；mode=per_item 时每条只收 unitPrice，且没有 creditsPerSecond。",
        },
      ],
      notes: [
        "接口始终以 HTTP 202 返回持久任务，不同步等待视频完成；请使用 GET /v1/videos/{id} 轮询。",
        "模型、时长、比例和分辨率分别校验，不会从模型 ID 解析参数。",
        "billing 是不可变创建报价；已存在 client_request_id 的幂等重试始终返回原任务账单，不重新按当前配置计价。",
      ],
      protocols: {
        gemini: getGeminiVideoProtocolVariants("zh")["video-generations"],
      },
    },
    {
      id: "video-capabilities",
      operation: "video",
      title: "查询视频模型能力",
      method: "GET",
      path: "/v1/videos/capabilities",
      contentType: "无请求体",
      description:
        "查询当前 API 密钥可见的真实视频模型、独立生成参数、输入图和声音能力，以及账号池是否已配置可达。",
      requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos/capabilities \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY"`,
      responseExample: `{
  "items": [
    {
      "model": "seedance2",
      "displayName": "Seedance 2.0",
      "durations": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      "aspectRatios": ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
      "resolutions": ["1080p", "720p", "480p"],
      "input": {
        "frames": "first-and-optional-last",
        "referenceImages": {
          "maxCount": 10,
          "configurable": true
        },
        "framesAndReferencesMutuallyExclusive": true
      },
      "audio": {
        "supported": true,
        "defaultEnabled": false
      },
      "billing": [
        {
          "kind": "current_quote",
          "resolution": "1080p",
          "mode": "per_second",
          "unit": "second",
          "unitPrice": 3,
          "creditsPerSecond": 3,
          "quoteToken": "opaque-current-quote-token"
        }
      ],
      "configuredReachable": true
    }
  ],
  "limits": {
    "maxMediaInputCount": 256,
    "maxMediaInputBytes": 536870912
  }
}`,
      parameters: [
        {
          name: "Authorization",
          requirement: "必填 header",
          description: "Bearer <API_KEY>。",
        },
      ],
      responses: [
        {
          name: "items[].model / displayName",
          description: "真实视频模型 ID 与展示名称。",
        },
        {
          name: "items[].durations / aspectRatios / resolutions",
          description: "该模型允许的独立时长、宽高比和分辨率集合。",
        },
        {
          name: "items[].input.frames",
          description:
            "none、first-only 或 first-and-optional-last，表示帧输入能力。",
        },
        {
          name: "items[].input.referenceImages",
          description:
            "参考图数量上限及该上限是否允许管理员配置；应使用响应中的当前值。",
        },
        {
          name: "items[].input.framesAndReferencesMutuallyExclusive",
          description: "固定指示首尾帧与参考图不能同时传入。",
        },
        {
          name: "items[].audio",
          description: "声音生成支持情况与未传 generate_audio 时的默认值。",
        },
        {
          name: "items[].billing[]",
          description:
            "每个输出分辨率的当前有效报价和 quoteToken。per_second 含 creditsPerSecond；per_item 只按 unitPrice/条计费。",
        },
        {
          name: "items[].configuredReachable",
          description:
            "当前可信账号池分组是否配置了可执行该模型的账号；不代表实时容量。",
        },
        {
          name: "limits",
          description:
            "整次媒体输入的基础设施数量与字节上限；单模型限制仍以 items[].input 为准。",
        },
      ],
      notes: [
        "提交视频前应从本接口选择 model、duration、aspect_ratio 和 resolution，不要自行拼接复合模型 ID。",
        "报价 token 与当前 API Key、模型和分辨率绑定；可省略以维持兼容。若携带的 token 过期，创建接口以 409 conflict 返回最新 currentQuote。",
        "configuredReachable 只表示配置可达性，不包含账号、凭据、健康、并发或实时剩余容量。",
        "响应使用 Cache-Control: no-store；管理员调整 Seedance 参考图上限后应重新查询。",
      ],
      protocols: {
        gemini: getGeminiVideoProtocolVariants("zh")["video-capabilities"],
      },
    },
    {
      id: "image-task",
      operation: "image_generation",
      title: "查询图片任务",
      method: "GET",
      path: "/v1/images/{task_id}",
      contentType: "无请求体",
      description: "按任务 ID 查询图片生成状态和结果。",
      requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/task_... \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY"`,
      responseExample: `{
  "id": "task_...",
  "object": "image",
  "status": "completed",
  "created": 1713833628,
  "created_at": "2026-05-28T00:00:00.000Z",
  "completed": 1713833700,
  "completed_at": "2026-05-28T00:01:12.000Z",
  "data": [
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."
    }
  ]
}`,
      parameters: [
        {
          name: "Authorization",
          requirement: "必填 header",
          description: "Bearer <API_KEY>。",
        },
        {
          name: "task_id",
          requirement: "必填路径参数",
          description: "图片任务 ID，与请求路径中的 {task_id} 对应。",
        },
      ],
      responses: [
        { name: "id", description: "图片任务 ID。" },
        { name: "object", description: "任务对象类型。" },
        {
          name: "status",
          description: "processing、needs_attention、completed 或 failed。",
        },
        {
          name: "data[].b64_json / data[].url",
          description: "任务完成后返回的图片结果。",
        },
        {
          name: "created / created_at / completed / completed_at",
          description: "任务创建与完成时间；未完成时不返回完成时间。",
        },
      ],
      notes: [
        "只能查询当前 API 密钥所属用户创建的任务。",
        "任务仍在执行时 status 为 processing，失败时 error.message 会给出原因。",
      ],
    },
    {
      id: "video-task",
      operation: "video",
      title: "查询视频任务",
      method: "GET",
      path: "/v1/videos/{id}",
      contentType: "无请求体",
      description: "按任务 ID 查询视频生成状态和结果。",
      requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos/video_0123456789abcdef0123456789abcdef01234567 \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY"`,
      responseExample: `{
  "object": "video.task",
  "id": "video_0123456789abcdef0123456789abcdef01234567",
  "task_id": "video_0123456789abcdef0123456789abcdef01234567",
  "generation_id": "video_0123456789abcdef0123456789abcdef01234567",
  "status": "completed",
  "model": "seedance2",
  "duration": 8,
  "duration_seconds": 8,
  "aspectRatio": "16:9",
  "aspect_ratio": "16:9",
  "resolution": "1080p",
  "generateAudio": true,
  "generate_audio": true,
  "input": { "mode": "references", "count": 1 },
  "billing": {
    "kind": "snapshot",
    "mode": "per_item",
    "unit": "item",
    "unitPrice": 3,
    "durationSeconds": 8,
    "quotedCredits": 3,
    "actualCredits": 3
  },
  "created_at": "2026-05-28T00:00:00.000Z",
  "completed_at": "2026-05-28T00:01:40.000Z",
  "video_url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
  "data": [{"url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}]
}`,
      parameters: [
        {
          name: "Authorization",
          requirement: "必填 header",
          description: "Bearer <API_KEY>。",
        },
        {
          name: "id",
          requirement: "必填路径参数",
          description:
            "创建接口返回的持久视频任务 ID，与请求路径中的 {id} 对应。最长 128 字符，仅可查询当前 API 密钥所属用户的任务。",
        },
      ],
      responses: [
        {
          name: "id / task_id / generation_id",
          description: "同一个持久视频任务 ID。",
        },
        { name: "object", description: "固定为 video.task。" },
        {
          name: "status",
          description: "queued、in_progress、completed 或 failed。",
        },
        {
          name: "model、duration / duration_seconds、aspectRatio / aspect_ratio、resolution",
          description: "任务的真实模型 ID 与独立视频参数。",
        },
        {
          name: "input",
          description: "输入模式与输入数量，不包含用户输入图内容。",
        },
        {
          name: "billing",
          description:
            "不可变报价与实际消费。旧任务标记为 legacy，单价和原报价为未知，不会伪造为当前价格。",
        },
        {
          name: "data[].url / video_url",
          description: "任务完成后返回的同一视频 URL。",
        },
        {
          name: "created_at / completed_at",
          description: "ISO 创建与完成时间；未完成时不返回 completed_at。",
        },
      ],
      notes: [
        "只能查询当前 API 密钥所属用户创建的任务。",
        "任务持久保存并可跨进程重启或多实例查询；响应带 Cache-Control: no-store。",
        "snapshot 的 actualCredits 会随扣费或退款结果变化；退款后保留原 quotedCredits，actualCredits 为 0。",
        "任务失败时 error.message 会给出原因。",
      ],
      protocols: {
        gemini: getGeminiVideoProtocolVariants("zh")["video-task"],
      },
    },
  ],
} satisfies ApiIntegrationDocsContent;

/**
 * 读取英文文档复用的中文端点骨架。
 *
 * @param id - 中文端点的稳定文档 ID。
 * @returns 对应端点；数据源不完整时在模块初始化阶段显式失败。
 */
function getZhEndpointTemplate(id: string): ApiIntegrationEndpoint {
  const endpoint = zhContent.endpoints.find((candidate) => candidate.id === id);
  if (!endpoint) {
    throw new Error(`Missing API integration endpoint template: ${id}`);
  }
  return endpoint;
}

const enContent = {
  eyebrow: "FluxMedia External API",
  title: "API Integration Guide",
  subtitle:
    "Media API reference for server-side integrations. Discover models and credit quota first, then create images or videos and poll task status.",
  baseUrl: DOCUMENTATION_BASE_URL_PLACEHOLDER,
  baseUrlLabel: "Base URL",
  authLabel: "Authentication",
  authValue: "Authorization: Bearer <API_KEY>",
  directoryTitle: "Endpoint directory",
  directoryDescription: "Expand a module, then select an endpoint to jump.",
  endpointsTitle: "Endpoint reference",
  parametersTitle: "Request parameters",
  responsesTitle: "Response fields",
  notesTitle: "Usage notes",
  requestExampleTitle: "Request example",
  responseExampleTitle: "Response example",
  protocolTabs: {
    ariaLabel: "Video interface specification",
    fluxmedia: "FluxMedia specification",
    gemini: "Gemini specification",
  },
  parameterHeaders: ["Parameter", "Requirement", "Default", "Description"],
  responseHeaders: ["Field", "Description"],
  copyLabels: {
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed",
  },
  groups: [
    {
      id: "api-basics",
      title: "Integration basics",
      description:
        "Confirm the models, account credits, and key quota available to the current API key.",
      endpointIds: API_INTEGRATION_GROUP_ENDPOINT_IDS.basics,
    },
    {
      id: "image-api",
      title: "Generate images",
      description:
        "Create or edit images, then query image task status and results.",
      endpointIds: API_INTEGRATION_GROUP_ENDPOINT_IDS.images,
    },
    {
      id: "video-api",
      title: "Generate videos",
      description:
        "Discover model capabilities, create videos, and query persistent tasks.",
      endpointIds: API_INTEGRATION_GROUP_ENDPOINT_IDS.videos,
    },
  ],
  imageSizeTable: {
    title: "Image Size Table",
    description:
      "Size configuration sets map resolution and aspect ratio to an upstream size; image endpoints no longer accept size.",
    headers: IMAGE_SIZE_DOC_TABLE_HEADERS_EN,
    rows: IMAGE_SIZE_DOC_TABLE_ROWS,
    note: IMAGE_SIZE_DOC_TABLE_NOTE_EN,
  },
  endpoints: [
    {
      ...getZhEndpointTemplate("models"),
      title: "List available models",
      contentType: "No request body",
      description:
        "List the image and video models actually available to the current API key's bound backend group.",
      parameters: [
        {
          name: "Authorization",
          requirement: "Required header",
          description: "Bearer <API_KEY>.",
        },
      ],
      responses: [
        { name: "object", description: "Always list." },
        {
          name: "data[].id",
          description:
            "Real model IDs schedulable by this key. The list can be empty when no reachable member is configured.",
        },
        {
          name: "data[].object / created / owned_by",
          description: "Fixed metadata compatible with an OpenAI model object.",
        },
      ],
      notes: [
        "Results are filtered by system capability switches, the API key's backend group, and the explicit model lists of enabled group members.",
        "Only model listing is available; /v1/models/{model} is not implemented.",
        "Responses use Cache-Control: no-store. Query again before generation instead of maintaining a fixed client-side model list.",
      ],
    },
    {
      ...getZhEndpointTemplate("credits"),
      title: "Get credits and key quota",
      contentType: "No request body",
      description:
        "Return the current API key's credit limit, usage, remaining quota, and owning account balance.",
      parameters: [
        {
          name: "Authorization",
          requirement: "Required header",
          description: "Bearer <API_KEY>.",
        },
      ],
      responses: [
        {
          name: "account.balance",
          description: "Current available credits on the owning account.",
        },
        {
          name: "account.total_earned / total_spent / status",
          description:
            "Cumulative credits earned, cumulative credits spent, and current account status.",
        },
        {
          name: "api_key.id / name / key_prefix / last_four / is_active",
          description:
            "Safe summary and activation state for the current API key; the full key is never returned.",
        },
        {
          name: "api_key.credit_limit / credits_used / credits_remaining / unlimited",
          description:
            "The key limit, used quota, remaining quota, and unlimited flag.",
        },
        {
          name: "api_key.last_used_at / created_at",
          description:
            "Last-use and creation timestamps. last_used_at is null before the first use.",
        },
      ],
      notes: [
        "When credit_limit is null, the key is unlimited, credits_remaining is null, and unlimited is true.",
        "Both key quota and account balance gate requests; insufficient value in either can reject a generation request.",
        "Responses use Cache-Control: no-store and must not be retained by shared caches.",
      ],
    },
    {
      ...getZhEndpointTemplate("image-generations"),
      title: "Create image",
      description:
        "Generate images from a text prompt using an OpenAI Images generation-compatible request.",
      parameters: [
        {
          name: "prompt",
          requirement: "Required",
          description: "Image prompt, up to 32,000 characters.",
        },
        {
          name: "model",
          requirement: "Required",
          description: "Image model ID available to the current API key.",
        },
        {
          name: "aspectRatio / aspect_ratio",
          requirement: "Optional",
          defaultValue: "Unset (upstream decides)",
          description: "Image aspect ratio, for example 1:1 or 16:9.",
        },
        {
          name: "resolution",
          requirement: "Optional",
          defaultValue: "Unset (upstream decides)",
          description:
            "Image resolution tier; available values depend on the selected model and provider size configuration.",
        },
        {
          name: "quality",
          requirement: "Optional",
          defaultValue: "auto",
          description:
            "auto, low, medium, or high; currently supported only by gpt-image-2. Do not send it for other image models.",
        },
        {
          name: "response_format",
          requirement: "Optional",
          defaultValue: "b64_json",
          description: "url or b64_json; defaults to b64_json.",
        },
        {
          name: "output_format",
          requirement: "Optional",
          defaultValue: "Unset (upstream decides)",
          description: "png, jpeg, or webp.",
        },
        {
          name: "output_compression",
          requirement: "Optional",
          defaultValue: "Unset (upstream decides)",
          description:
            "Controls the output image compression level from 0 to 100. Higher values apply stronger compression, typically producing smaller files with more quality loss; 0 means no compression and 100 means maximum compression. It only applies when output_format is jpeg or webp, and exact results may vary by upstream provider.",
        },
        {
          name: "background",
          requirement: "Optional",
          defaultValue: "Unset (upstream decides)",
          description:
            "transparent, opaque, or auto; support depends on the model.",
        },
        {
          name: "stream",
          requirement: "Optional",
          defaultValue: "false",
          description:
            "Return an event stream when true or when Accept is text/event-stream.",
        },
      ],
      responses: [
        { name: "created", description: "Unix timestamp in seconds." },
        {
          name: "data[].b64_json / data[].url",
          description: "Base64 image or image URL selected by response_format.",
        },
        {
          name: "data[].revised_prompt",
          description: "The upstream revised prompt, when available.",
        },
        {
          name: "SSE image_generation.partial_image",
          description: "Partial image event in streaming mode.",
        },
        {
          name: "SSE image_generation.completed",
          description:
            "Signals that one image has completed in streaming mode.",
        },
      ],
      notes: [
        "response_format selects URL or base64 output; output_format selects the image file format.",
        "Supported sizes, transparent backgrounds, and output formats vary by model.",
      ],
    },
    {
      ...getZhEndpointTemplate("image-edits"),
      title: "Edit image",
      description:
        "Edit one or more input images from a prompt using an OpenAI Images edit-compatible request.",
      parameters: [
        {
          name: "prompt",
          requirement: "Required",
          description: "Edit prompt, up to 32,000 characters.",
        },
        {
          name: "image / image[] / image_*",
          requirement: "Required for multipart",
          description: "Uploaded image files, up to 16 images.",
        },
        {
          name: "images",
          requirement: "Required for JSON",
          description: "Image reference array in a JSON request.",
        },
        {
          name: "mask",
          requirement: "Optional",
          defaultValue: "None",
          description:
            "Mask image whose transparent area indicates the edit region.",
        },
        {
          name: "model",
          requirement: "Required",
          description: "Image model ID available to the current API key.",
        },
        {
          name: "aspectRatio / aspect_ratio",
          requirement: "Optional",
          defaultValue: "Unset (upstream decides)",
          description: "Image aspect ratio, for example 1:1 or 16:9.",
        },
        {
          name: "resolution",
          requirement: "Optional",
          defaultValue: "Unset (upstream decides)",
          description:
            "Image resolution tier; available values depend on the selected model and provider size configuration.",
        },
        {
          name: "quality",
          requirement: "Optional",
          defaultValue: "auto",
          description:
            "auto, low, medium, or high; currently supported only by gpt-image-2. Do not send it for other image models.",
        },
        {
          name: "response_format",
          requirement: "Optional",
          defaultValue: "b64_json",
          description: "url or b64_json; defaults to b64_json.",
        },
        {
          name: "output_format",
          requirement: "Optional",
          defaultValue: "Unset (upstream decides)",
          description: "png, jpeg, or webp.",
        },
        {
          name: "output_compression",
          requirement: "Optional",
          defaultValue: "Unset (upstream decides)",
          description:
            "Controls the output image compression level from 0 to 100. Higher values apply stronger compression, typically producing smaller files with more quality loss; 0 means no compression and 100 means maximum compression. It only applies when output_format is jpeg or webp, and exact results may vary by upstream provider.",
        },
        {
          name: "background",
          requirement: "Optional",
          defaultValue: "Unset (upstream decides)",
          description:
            "transparent, opaque, or auto; support depends on the model.",
        },
        {
          name: "stream",
          requirement: "Optional",
          defaultValue: "false",
          description:
            "Return an event stream when true or when Accept is text/event-stream.",
        },
      ],
      responses: [
        { name: "created", description: "Unix timestamp in seconds." },
        {
          name: "data[].b64_json / data[].url",
          description: "Base64 image or image URL selected by response_format.",
        },
        {
          name: "data[].revised_prompt",
          description: "The upstream revised prompt, when available.",
        },
        {
          name: "SSE image_edit.partial_image",
          description: "Partial image event in streaming mode.",
        },
        {
          name: "SSE image_edit.completed",
          description:
            "Signals that one image edit has completed in streaming mode.",
        },
      ],
      notes: [
        "Use multipart/form-data for direct file uploads; JSON requests pass image references through images.",
        "The mask dimensions should match the input image.",
      ],
    },
    {
      ...getZhEndpointTemplate("video-generations"),
      title: "Create video",
      description:
        "Create a persistent video task from a text prompt or reference images using the OpenAI-style route.",
      deprecationNotice:
        "POST /v1/videos is no longer a video creation endpoint. Use POST /v1/videos/generations or /api/v1/videos/generations.",
      parameters: [
        {
          name: "client_request_id / clientRequestId",
          requirement: "Required",
          description:
            "A caller-generated idempotency key of up to 128 characters.",
        },
        {
          name: "prompt",
          requirement: "Required",
          description: "Video prompt, up to 32,000 characters.",
        },
        {
          name: "model",
          requirement: "Required",
          description:
            "Real video model ID such as seedance2, seedance2-fast, or veo31. Duration, ratio, and resolution must not be encoded in the ID; composite IDs are rejected.",
        },
        {
          name: "seconds / duration / duration_seconds",
          requirement: "Required",
          description:
            "Separate video duration in seconds. seconds accepts a positive integer or decimal integer string; supplied aliases must agree and the normalized value must be supported by the selected model.",
        },
        {
          name: "aspectRatio / aspect_ratio",
          requirement: "Required",
          description:
            "Separate video aspect ratio supported by the selected model.",
        },
        {
          name: "resolution",
          requirement: "Required",
          description:
            "Separate lowercase output resolution supported by the selected model.",
        },
        {
          name: "quote_token / quoteToken",
          requirement: "Optional",
          defaultValue: "Omit to create with the current server quote",
          description:
            "Short-lived opaque quote token from the matching model and resolution billing row of GET /v1/videos/capabilities. A changed quote returns 409 with the latest currentQuote; confirm it and retry with the new token.",
        },
        {
          name: "negative_prompt / negativePrompt",
          requirement: "Optional",
          defaultValue: "None",
          description: "Negative prompt, up to 8,000 characters.",
        },
        {
          name: "generate_audio / generateAudio",
          requirement: "Optional",
          defaultValue: "Model default",
          description:
            "Whether to generate audio. Seedance 2.0, including Fast, and Kling 3.0 Omni default to false, while Kling 3.0 defaults to true. Runway Gen-4.5 and Ray 3.14, including HDR, do not support audio, and models without audio support cannot accept true.",
        },
        {
          name: "firstFrame / first_frame, lastFrame / last_frame",
          requirement: "Optional",
          defaultValue: "None",
          description:
            "First frame and optional last frame as base64 image data URLs. lastFrame requires firstFrame; last-frame support is model-specific.",
        },
        {
          name: "referenceImages / reference_images",
          requirement: "Optional",
          defaultValue: "Empty array",
          description:
            "Ordered base64 image data URL array. The limit is model-specific; Seedance defaults to 10 and admins may configure it. Reference images and frame inputs are mutually exclusive for every model.",
        },
        {
          name: "callback_url / callbackUrl",
          requirement: "Optional",
          defaultValue: "None",
          description:
            "Public https webhook that receives the task object when the task completes or fails.",
        },
      ],
      responses: [
        {
          name: "task_id / id / generation_id",
          description: "The same persistent video task ID.",
        },
        { name: "object", description: "Always video.task." },
        {
          name: "status",
          description: "Initial task status, usually queued.",
        },
        {
          name: "model",
          description: "Real video model ID used for this request.",
        },
        {
          name: "duration / duration_seconds, aspectRatio / aspect_ratio, resolution",
          description: "Separate video parameters used by this task.",
        },
        {
          name: "billing",
          description:
            "Snapshot locked at creation. mode=per_second multiplies the unit price by duration; mode=per_item charges unitPrice once and has no creditsPerSecond.",
        },
      ],
      notes: [
        "The endpoint always returns a persistent task with HTTP 202 and never waits synchronously for the video; poll GET /v1/videos/{id}.",
        "Model, duration, ratio, and resolution are validated independently and are never parsed from the model ID.",
        "billing is an immutable creation quote. An idempotent retry with an existing client_request_id always returns the original task billing instead of repricing from current configuration.",
      ],
      protocols: {
        gemini: getGeminiVideoProtocolVariants("en")["video-generations"],
      },
    },
    {
      ...getZhEndpointTemplate("video-capabilities"),
      title: "List video model capabilities",
      contentType: "No request body",
      description:
        "List real video models visible to the current API key, their independent generation parameters, image input and audio capabilities, and whether the account pool is configured to reach them.",
      parameters: [
        {
          name: "Authorization",
          requirement: "Required header",
          description: "Bearer <API_KEY>.",
        },
      ],
      responses: [
        {
          name: "items[].model / displayName",
          description: "Real video model ID and display name.",
        },
        {
          name: "items[].durations / aspectRatios / resolutions",
          description:
            "Allowed independent duration, aspect ratio, and resolution values for the model.",
        },
        {
          name: "items[].input.frames",
          description:
            "none, first-only, or first-and-optional-last, describing frame input support.",
        },
        {
          name: "items[].input.referenceImages",
          description:
            "Reference-image limit and whether admins can configure that limit; use the current response value.",
        },
        {
          name: "items[].input.framesAndReferencesMutuallyExclusive",
          description:
            "Indicates that frame inputs and reference images cannot be sent together.",
        },
        {
          name: "items[].audio",
          description:
            "Audio generation support and the default used when generate_audio is omitted.",
        },
        {
          name: "items[].billing[]",
          description:
            "Current effective quote and quoteToken for each output resolution. per_second includes creditsPerSecond; per_item is charged only by unitPrice per item.",
        },
        {
          name: "items[].configuredReachable",
          description:
            "Whether the trusted account-pool group is configured with an account capable of running this model; this is not real-time capacity.",
        },
        {
          name: "limits",
          description:
            "Infrastructure-wide input count and byte limits; per-model limits still come from items[].input.",
        },
      ],
      notes: [
        "Before creating a video, select model, duration, aspect_ratio, and resolution from this endpoint. Do not construct composite model IDs.",
        "A quote token is bound to the current API key, model, and resolution and may be omitted for compatibility. When a supplied token is stale, creation returns 409 conflict with the latest currentQuote.",
        "configuredReachable reports configuration reachability only. It exposes no accounts, credentials, health, concurrency, or live remaining capacity.",
        "Responses use Cache-Control: no-store. Query again after an admin changes a Seedance reference-image limit.",
      ],
      protocols: {
        gemini: getGeminiVideoProtocolVariants("en")["video-capabilities"],
      },
    },
    {
      ...getZhEndpointTemplate("image-task"),
      title: "Get image task",
      contentType: "No request body",
      description: "Get image generation status and results by task ID.",
      parameters: [
        {
          name: "Authorization",
          requirement: "Required header",
          description: "Bearer <API_KEY>.",
        },
        {
          name: "task_id",
          requirement: "Required path parameter",
          description:
            "Image task ID corresponding to {task_id} in the request path.",
        },
      ],
      responses: [
        { name: "id", description: "Image task ID." },
        { name: "object", description: "Task object type." },
        {
          name: "status",
          description: "processing, needs_attention, completed, or failed.",
        },
        {
          name: "data[].b64_json / data[].url",
          description: "Image results returned after completion.",
        },
        {
          name: "created / created_at / completed / completed_at",
          description:
            "Creation and completion times; completion fields are absent while running.",
        },
      ],
      notes: [
        "Only tasks created by the user who owns the current API key can be queried.",
        "A running task has status processing. A failed task includes the reason in error.message.",
      ],
    },
    {
      ...getZhEndpointTemplate("video-task"),
      title: "Get video task",
      contentType: "No request body",
      description: "Get video generation status and results by task ID.",
      parameters: [
        {
          name: "Authorization",
          requirement: "Required header",
          description: "Bearer <API_KEY>.",
        },
        {
          name: "id",
          requirement: "Required path parameter",
          description:
            "Persistent video task ID returned by the create endpoint, corresponding to {id} in the request path. Maximum 128 characters; only tasks owned by the current API key user are queryable.",
        },
      ],
      responses: [
        {
          name: "id / task_id / generation_id",
          description: "The same persistent video task ID.",
        },
        { name: "object", description: "Always video.task." },
        {
          name: "status",
          description: "queued, in_progress, completed, or failed.",
        },
        {
          name: "model, duration / duration_seconds, aspectRatio / aspect_ratio, resolution",
          description:
            "The task's real model ID and separate video parameters.",
        },
        {
          name: "input",
          description:
            "Input mode and count without the user-supplied image contents.",
        },
        {
          name: "billing",
          description:
            "Immutable quote and actual consumption. Legacy tasks are marked legacy with unknown unit price and quote; no current price is fabricated.",
        },
        {
          name: "data[].url / video_url",
          description: "The same video URL returned after completion.",
        },
        {
          name: "created_at / completed_at",
          description:
            "ISO creation and completion times; completed_at is absent while running.",
        },
      ],
      notes: [
        "Only tasks created by the user who owns the current API key can be queried.",
        "Tasks are persisted and remain queryable across process restarts or multiple instances; responses use Cache-Control: no-store.",
        "snapshot actualCredits follows consumption or refund results; a refund preserves quotedCredits and sets actualCredits to 0.",
        "A failed task includes the reason in error.message.",
      ],
      protocols: {
        gemini: getGeminiVideoProtocolVariants("en")["video-task"],
      },
    },
  ],
} satisfies ApiIntegrationDocsContent;

/**
 * 为单次请求创建绑定当前域名的接入文档副本。
 *
 * @param content - 当前语言的静态文档模板。
 * @param baseUrl - 当前请求对应且不带尾斜杠的 HTTP(S) origin。
 * @returns 只替换 Base URL、请求示例和响应示例的新文档对象。
 * @sideEffects 无；不会修改模块级模板，避免多域名并发请求互相串值。
 */
function bindApiIntegrationBaseUrl(
  content: ApiIntegrationDocsContent,
  baseUrl: string
): ApiIntegrationDocsContent {
  return {
    ...content,
    baseUrl,
    endpoints: content.endpoints.map((endpoint) => {
      const bindContent = (
        endpointContent: ApiIntegrationEndpointContent
      ): ApiIntegrationEndpointContent => ({
        ...endpointContent,
        requestExample: replaceDocumentationBaseUrl(
          endpointContent.requestExample,
          baseUrl
        ),
        responseExample: replaceDocumentationBaseUrl(
          endpointContent.responseExample,
          baseUrl
        ),
      });
      const protocols = endpoint.protocols
        ? (
            Object.entries(endpoint.protocols) as Array<
              [
                ApiIntegrationProtocol,
                ApiIntegrationEndpointContent | undefined,
              ]
            >
          ).reduce<
            Partial<
              Record<ApiIntegrationProtocol, ApiIntegrationEndpointContent>
            >
          >((result, [protocol, variant]) => {
            if (variant) result[protocol] = bindContent(variant);
            return result;
          }, {})
        : undefined;
      return {
        ...endpoint,
        ...bindContent(endpoint),
        ...(protocols ? { protocols } : {}),
      };
    }),
  };
}

/**
 * 按路由语言返回公开接入文档。
 *
 * @param locale - Next.js 路由语言；只有 zh 使用中文，其余安全回退英文。
 * @param baseUrl - 当前请求 origin；缺省仅供无请求上下文的纯契约消费者使用站点配置。
 * @returns 绑定单次请求域名并包含现行模型、积分、图片与视频端点的完整只读数据源。
 * @sideEffects 缺省 baseUrl 时只读访问公开站点配置；不修改共享模板。
 */
export function getApiIntegrationDocs(
  locale?: string,
  baseUrl = getSiteBaseUrl()
): ApiIntegrationDocsContent {
  return bindApiIntegrationBaseUrl(
    locale === "zh" ? zhContent : enContent,
    baseUrl
  );
}

/**
 * 提取首页快速集成需要的端点、鉴权和复制文案。
 *
 * @param locale - Next.js 路由语言；只有 zh 使用中文，其余安全回退英文。
 * @returns 不含旧固定域名、固定模型或响应示例的最小共享契约。
 * @sideEffects 无。
 * @failure 若公开文档误删图片生成端点，则在服务端渲染阶段显式抛错，避免展示伪造契约。
 */
export function getApiIntegrationHomepageContract(
  locale?: string
): ApiIntegrationHomepageContract {
  const content = getApiIntegrationDocs(locale);
  const endpoint = content.endpoints.find(
    (candidate) => candidate.id === IMAGE_GENERATION_ENDPOINT_ID
  );
  if (!endpoint) {
    throw new Error("Missing public image generation API contract");
  }

  return {
    endpoint: {
      contentType: endpoint.contentType,
      method: endpoint.method,
      path: endpoint.path,
    },
    authentication: API_KEY_AUTHENTICATION,
    copyLabels: content.copyLabels,
  };
}
