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

export type ApiIntegrationEndpoint = {
  id: string;
  operation: "models" | "credits" | "image_generation" | "image_edit" | "video";
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
  parameterHeaders: readonly [string, string, string, string];
  responseHeaders: readonly [string, string];
  copyLabels: {
    copy: string;
    copied: string;
    copyFailed: string;
  };
  groups: readonly ApiIntegrationEndpointGroup[];
  endpoints: readonly ApiIntegrationEndpoint[];
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
    "size": "1024x1024",
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
          name: "size",
          requirement: "可选",
          defaultValue: "1024x1024",
          description: "目标图片尺寸，例如 1024x1024。",
        },
        {
          name: "quality",
          requirement: "可选",
          defaultValue: "auto",
          description: "auto、low、medium 或 high。",
        },
        {
          name: "moderation",
          requirement: "可选",
          defaultValue: "auto",
          description: "auto 或 low，作为上游图像生成参数传递。",
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
  -F "size=1024x1024" \\
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
          name: "size",
          requirement: "可选",
          defaultValue: "1024x1024",
          description: "目标图片尺寸，例如 1024x1024。",
        },
        {
          name: "quality",
          requirement: "可选",
          defaultValue: "auto",
          description: "auto、low、medium 或 high。",
        },
        {
          name: "moderation",
          requirement: "可选",
          defaultValue: "auto",
          description: "auto 或 low，作为上游图像编辑参数传递。",
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
      path: "/v1/videos",
      contentType: "application/json",
      description: "按 OpenAI 风格地址根据文本提示词或参考图创建持久视频任务。",
      deprecationNotice:
        "警告：旧创建地址 POST /v1/videos/generations（以及 /api/v1/videos/generations 等价地址）即将废弃下线，请尽快迁移至 POST /v1/videos（或 /api/v1/videos）；具体下线版本另行发布。",
      requestExample: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos \\
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
    "reference_images": ["data:image/png;base64,..."]
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
            "真实视频模型 ID，例如 seedance2、seedance2-fast 或 veo31。不得拼接时长、比例或分辨率；旧 firefly-* 与复合 ID 会被拒绝。",
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
          name: "size",
          requirement: "Optional",
          defaultValue: "1024x1024",
          description: "Target image size, for example 1024x1024.",
        },
        {
          name: "quality",
          requirement: "Optional",
          defaultValue: "auto",
          description: "auto, low, medium, or high.",
        },
        {
          name: "moderation",
          requirement: "Optional",
          defaultValue: "auto",
          description: "auto or low, forwarded as an upstream image parameter.",
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
          name: "size",
          requirement: "Optional",
          defaultValue: "1024x1024",
          description: "Target image size, for example 1024x1024.",
        },
        {
          name: "quality",
          requirement: "Optional",
          defaultValue: "auto",
          description: "auto, low, medium, or high.",
        },
        {
          name: "moderation",
          requirement: "Optional",
          defaultValue: "auto",
          description: "auto or low, forwarded as an upstream edit parameter.",
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
        "Warning: The legacy POST /v1/videos/generations route and its /api/v1/videos/generations alias are scheduled for deprecation and removal. Migrate to POST /v1/videos or /api/v1/videos; the removal release will be announced separately.",
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
            "Real video model ID such as seedance2, seedance2-fast, or veo31. Duration, ratio, and resolution must not be encoded in the ID; legacy firefly-* and composite IDs are rejected.",
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
    endpoints: content.endpoints.map((endpoint) => ({
      ...endpoint,
      requestExample: replaceDocumentationBaseUrl(
        endpoint.requestExample,
        baseUrl
      ),
      responseExample: replaceDocumentationBaseUrl(
        endpoint.responseExample,
        baseUrl
      ),
    })),
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
