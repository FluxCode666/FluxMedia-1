/**
 * 公开 API 接入文档的数据源。
 *
 * 内容从管理员系统文档的外接 API 章节提炼。数据源保留五个已整理端点，公开读取时
 * 统一过滤暂不展示的视频端点；图片任务的路径 ID 属于必要契约，因此显式保留。
 */

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

export type ApiIntegrationEndpoint = {
  id: string;
  category: string;
  operation: "image_generation" | "image_edit" | "video";
  title: string;
  method: "GET" | "POST";
  path: string;
  contentType: string;
  description: string;
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
  baseUrlLabel: string;
  authLabel: string;
  authValue: string;
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
const API_KEY_AUTHENTICATION = {
  headerName: "Authorization",
  scheme: "Bearer",
  environmentVariable: "FLUXMEDIA_API_KEY",
} as const;

const zhContent = {
  eyebrow: "FluxMedia External API",
  title: "API 接入文档",
  subtitle:
    "面向服务端集成的图像接口参考。这里仅展示通用兼容参数，不包含 FluxMedia 站点扩展参数。",
  baseUrlLabel: "Base URL",
  authLabel: "鉴权",
  authValue: "Authorization: Bearer <API_KEY>",
  endpointsTitle: "接口详情",
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
  endpoints: [
    {
      id: "image-generations",
      category: "外部文生图 API",
      operation: "image_generation",
      title: "创建图片",
      method: "POST",
      path: "/v1/images/generations",
      contentType: "application/json",
      description:
        "根据文本提示词生成图片，兼容 OpenAI Images generation 请求形态。",
      requestExample: `curl https://gpt2image.superapi.buzz/v1/images/generations \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "A quiet reading room in the morning sun",
    "n": 1,
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
      "url": "https://gpt2image.superapi.buzz/api/storage/generations/...",
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
          name: "n",
          requirement: "可选",
          defaultValue: "1",
          description: "生成数量，须在当前套餐允许的批量范围内。",
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
      category: "外部图生图 API",
      operation: "image_edit",
      title: "编辑图片",
      method: "POST",
      path: "/v1/images/edits",
      contentType: "multipart/form-data 或 application/json",
      description:
        "根据提示词编辑一张或多张输入图片，兼容 OpenAI Images edit 请求形态。",
      requestExample: `curl https://gpt2image.superapi.buzz/v1/images/edits \\
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
      "url": "https://gpt2image.superapi.buzz/api/storage/generations/...",
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
          name: "n",
          requirement: "可选",
          defaultValue: "1",
          description: "生成数量，须在当前套餐允许的批量范围内。",
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
      category: "外部视频 API",
      operation: "video",
      title: "创建视频",
      method: "POST",
      path: "/v1/videos/generations",
      contentType: "application/json",
      description: "根据文本提示词或参考图创建视频。",
      requestExample: `curl https://gpt2image.superapi.buzz/v1/videos/generations \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "client_request_id": "video-request-001",
    "model": "firefly-veo31-8s-16x9-1080p",
    "prompt": "A corgi running along the beach at sunset",
    "negative_prompt": "low resolution, blur, watermark",
    "generate_audio": false
  }'`,
      responseExample: `{
  "created": 1713833628,
  "model": "firefly-veo31-8s-16x9-1080p",
  "data": [
    {
      "url": "https://gpt2image.superapi.buzz/api/storage/generations/..."
    }
  ]
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
            "视频模型 ID，格式为 firefly-<family>-<dur>s-<ratio>[-<res>]。",
        },
        {
          name: "negative_prompt / negativePrompt",
          requirement: "可选",
          description: "负向提示词，最多 8000 字符。",
        },
        {
          name: "generate_audio / generateAudio",
          requirement: "可选",
          description:
            "是否生成声音。Seedance 2.0（含 Fast）与 Kling 3.0 Omni 默认关闭，Kling 3.0 默认开启；不支持音频的模型不能传 true。",
        },
        {
          name: "image",
          requirement: "可选",
          description: "base64 image data URL 数组，最多 3 张参考图。",
        },
      ],
      responses: [
        { name: "created", description: "Unix 秒时间戳。" },
        { name: "model", description: "本次使用的视频模型 ID。" },
        { name: "data[].url", description: "生成视频的存储 URL。" },
      ],
      notes: [
        "视频生成耗时通常长于图片生成，请为客户端配置足够的读取超时时间。",
        "模型 ID 中的时长和画幅必须属于该模型支持的组合。",
      ],
    },
    {
      id: "image-task",
      category: "外部异步图片任务",
      operation: "image_generation",
      title: "查询图片任务",
      method: "GET",
      path: "/v1/images/{task_id}",
      contentType: "无请求体",
      description: "按任务 ID 查询图片生成状态和结果。",
      requestExample: `curl https://gpt2image.superapi.buzz/v1/images/task_... \\
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
      "url": "https://gpt2image.superapi.buzz/api/storage/generations/..."
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
      category: "外部异步视频任务",
      operation: "video",
      title: "查询视频任务",
      method: "GET",
      path: "/v1/videos/{id}",
      contentType: "无请求体",
      description: "按任务 ID 查询视频生成状态和结果。",
      requestExample: `curl https://gpt2image.superapi.buzz/v1/videos/task_... \\
  -H "Authorization: Bearer $FLUXMEDIA_API_KEY"`,
      responseExample: `{
  "id": "task_...",
  "object": "video",
  "status": "completed",
  "created": 1713833628,
  "created_at": "2026-05-28T00:00:00.000Z",
  "completed_at": "2026-05-28T00:01:40.000Z",
  "data": [
    {
      "url": "https://gpt2image.superapi.buzz/api/storage/generations/..."
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
          name: "id",
          requirement: "必填路径参数",
          description: "视频任务 ID，与请求路径中的 {id} 对应。",
        },
      ],
      responses: [
        { name: "id", description: "视频任务 ID。" },
        { name: "object", description: "任务对象类型。" },
        {
          name: "status",
          description: "processing、needs_attention、completed 或 failed。",
        },
        {
          name: "data[].url",
          description: "任务完成后返回的视频 URL。",
        },
        {
          name: "created / created_at / completed_at",
          description: "任务创建与完成时间；未完成时不返回完成时间。",
        },
      ],
      notes: [
        "只能查询当前 API 密钥所属用户创建的任务。",
        "任务仍在执行时 status 为 processing，失败时 error.message 会给出原因。",
      ],
    },
  ],
} satisfies ApiIntegrationDocsContent;

/**
 * 读取英文文档复用的中文端点骨架。
 *
 * @param index - 五个固定端点中的位置。
 * @returns 对应端点；数据源不完整时在模块初始化阶段显式失败。
 */
function getZhEndpointTemplate(index: number): ApiIntegrationEndpoint {
  const endpoint = zhContent.endpoints[index];
  if (!endpoint) {
    throw new Error(`Missing API integration endpoint template at ${index}`);
  }
  return endpoint;
}

const enContent = {
  eyebrow: "FluxMedia External API",
  title: "API Integration Guide",
  subtitle:
    "Image API reference for server-side integrations. This page lists only compatible parameters and omits FluxMedia-specific extension parameters.",
  baseUrlLabel: "Base URL",
  authLabel: "Authentication",
  authValue: "Authorization: Bearer <API_KEY>",
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
  endpoints: [
    {
      ...getZhEndpointTemplate(0),
      category: "Text-to-image API",
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
          name: "n",
          requirement: "Optional",
          defaultValue: "1",
          description:
            "Number of images, within the current plan's batch limit.",
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
      ...getZhEndpointTemplate(1),
      category: "Image-to-image API",
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
          name: "n",
          requirement: "Optional",
          defaultValue: "1",
          description:
            "Number of images, within the current plan's batch limit.",
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
      ...getZhEndpointTemplate(2),
      category: "Video API",
      title: "Create video",
      description: "Create a video from a text prompt or reference images.",
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
            "Video model ID in the form firefly-<family>-<dur>s-<ratio>[-<res>].",
        },
        {
          name: "negative_prompt / negativePrompt",
          requirement: "Optional",
          description: "Negative prompt, up to 8,000 characters.",
        },
        {
          name: "generate_audio / generateAudio",
          requirement: "Optional",
          description:
            "Whether to generate audio. Seedance 2.0, including Fast, and Kling 3.0 Omni default to false, while Kling 3.0 defaults to true; models without audio support cannot accept true.",
        },
        {
          name: "image",
          requirement: "Optional",
          description: "An array of up to three base64 image data URLs.",
        },
      ],
      responses: [
        { name: "created", description: "Unix timestamp in seconds." },
        { name: "model", description: "Video model ID used for this request." },
        {
          name: "data[].url",
          description: "Storage URL of the generated video.",
        },
      ],
      notes: [
        "Video generation usually takes longer than image generation. Configure a sufficient client read timeout.",
        "The duration and aspect ratio in the model ID must be supported by that model.",
      ],
    },
    {
      ...getZhEndpointTemplate(3),
      category: "Asynchronous image task",
      title: "Get image task",
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
      ...getZhEndpointTemplate(4),
      category: "Asynchronous video task",
      title: "Get video task",
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
            "Video task ID corresponding to {id} in the request path.",
        },
      ],
      responses: [
        { name: "id", description: "Video task ID." },
        { name: "object", description: "Task object type." },
        {
          name: "status",
          description: "processing, needs_attention, completed, or failed.",
        },
        {
          name: "data[].url",
          description: "Video URL returned after completion.",
        },
        {
          name: "created / created_at / completed_at",
          description:
            "Creation and completion times; completion fields are absent while running.",
        },
      ],
      notes: [
        "Only tasks created by the user who owns the current API key can be queried.",
        "A running task has status processing. A failed task includes the reason in error.message.",
      ],
    },
  ],
} satisfies ApiIntegrationDocsContent;

// 视频能力仍在内部系统文档和真实 API 中保留；公开接入页按当前产品决策临时隐藏。
// 恢复展示时只需从本集合移除对应 ID，避免复制或删除已经校对过的双语契约。
const TEMPORARILY_HIDDEN_ENDPOINT_IDS = new Set([
  "video-generations",
  "video-task",
]);

/**
 * 按路由语言返回公开接入文档。
 *
 * @param locale - Next.js 路由语言；只有 zh 使用中文，其余安全回退英文。
 * @returns 不含站点扩展参数的只读文档数据。
 */
export function getApiIntegrationDocs(
  locale?: string
): ApiIntegrationDocsContent {
  const content = locale === "zh" ? zhContent : enContent;
  return {
    ...content,
    endpoints: content.endpoints.filter(
      (endpoint) => !TEMPORARILY_HIDDEN_ENDPOINT_IDS.has(endpoint.id)
    ),
  };
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
