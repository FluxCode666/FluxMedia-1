/**
 * 简易生图页的 HTTP 请求契约构造器。
 *
 * 职责：集中生成文生图 JSON 与图生图 multipart 请求，保持两个入口的默认参数、
 * SSE 开关和模型分组选择一致。使用方仅为 `ImageCreatePanel` 及其 DB-free 单元测试。
 */

export type ImageCreateRequestFields = {
  generationId: string;
  prompt: string;
  size: string;
  model: string;
  backendGroupId: string;
  quality: string;
  background: string;
};

export type ImageEditRequestFields = ImageCreateRequestFields & {
  images: readonly File[];
  mask: File | null;
};

/** 页面图片接口统一使用 SSE，以五秒心跳跨过反向代理空闲超时。 */
export const IMAGE_CREATE_REQUEST_HEADERS = {
  Accept: "text/event-stream",
} as const;

/**
 * 构造文生图 JSON 请求体。
 *
 * @param input 已由页面校验的模型、分组、提示词和输出设置。
 * @returns PNG、自动审核、关闭后处理的单项 SSE 请求体。
 */
export function buildImageGenerateRequestBody(input: ImageCreateRequestFields) {
  return {
    ...input,
    stream: true,
    moderation: "auto" as const,
    output_format: "png" as const,
    hd_repair: false,
    block_repair: false,
  };
}

/**
 * 构造图生图或蒙版编辑 multipart 请求体。
 *
 * @param input 已校验的公共字段、至少一张来源图片与可选 PNG 蒙版。
 * @returns 可直接发送给 `/api/images/edit` 的 FormData；不执行网络或文件读取。
 */
export function buildImageEditRequestBody(
  input: ImageEditRequestFields
): FormData {
  const body = new FormData();
  body.set("generationId", input.generationId);
  body.set("prompt", input.prompt);
  body.set("size", input.size);
  body.set("model", input.model);
  body.set("backendGroupId", input.backendGroupId);
  body.set("quality", input.quality);
  body.set("background", input.background);
  body.set("moderation", "auto");
  body.set("output_format", "png");
  body.set("hd_repair", "false");
  body.set("block_repair", "false");
  body.set("stream", "true");
  for (const image of input.images) body.append("image[]", image);
  if (input.mask) body.set("mask", input.mask);
  return body;
}
