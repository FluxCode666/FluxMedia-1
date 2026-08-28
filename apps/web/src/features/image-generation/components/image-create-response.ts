/**
 * 简易生图页的 JSON/SSE 响应解析器。
 *
 * 职责：校验站内图片接口的单次、批量与 SSE 完成/错误事件，过滤 keep-alive 和
 * 局部图片事件，只向页面返回可结算的最终结果。使用方为 `ImageCreatePanel`。
 */

import { z } from "zod";

/**
 * 判断图片结果地址是否可交给浏览器展示。
 *
 * 站内存储接口会按部署桶名返回同源相对地址；外部兼容路径只接受 HTTP(S)，
 * 避免把任意协议或非存储相对路径注入图片元素。
 */
function isSupportedImageUrl(value: string) {
  try {
    if (value.startsWith("/")) {
      if (!value.startsWith("/api/storage/")) return false;
      const localOrigin = "http://local.invalid";
      const url = new URL(value, localOrigin);
      return (
        url.origin === localOrigin && url.pathname.startsWith("/api/storage/")
      );
    }

    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const imageUrlSchema = z.string().refine(isSupportedImageUrl);

const imageOutputSchema = z
  .object({
    imageUrl: imageUrlSchema.optional(),
  })
  .passthrough();

const generationResultSchema = z
  .object({
    error: z.string().nullable().optional(),
    generationId: z.string().optional(),
    taskId: z.string().optional(),
    status: z
      .enum([
        "queued",
        "running",
        "pending",
        "processing",
        "completed",
        "failed",
      ])
      .optional(),
    imageUrl: imageUrlSchema.optional(),
    imageOutputs: z.array(imageOutputSchema).optional(),
    creditsConsumed: z.number().nonnegative().optional(),
  })
  .passthrough();

const generationResponseSchema = generationResultSchema.extend({
  results: z.array(generationResultSchema).optional(),
});

const generationStreamEventSchema = generationResultSchema.extend({
  type: z.enum(["partial_image", "completed", "error", "done"]),
});

export type ImageGenerationResponse = z.infer<typeof generationResponseSchema>;

/** 从单次或批量响应中提取所有成功图片 URL。 */
export function collectImageUrls(response: ImageGenerationResponse): string[] {
  const results = response.results ?? [response];
  const urls = results.flatMap((result) => [
    ...(result.imageUrl ? [result.imageUrl] : []),
    ...(result.imageOutputs ?? []).flatMap((output) =>
      output.imageUrl ? [output.imageUrl] : []
    ),
  ]);
  return Array.from(new Set(urls));
}

/** 从响应中返回首个稳定错误消息。 */
export function getResponseError(
  response: ImageGenerationResponse
): string | null {
  const results = response.results ?? [response];
  return results.find((result) => result.error)?.error ?? null;
}

/** 合计本次响应实际消耗的积分。 */
export function getConsumedCredits(response: ImageGenerationResponse): number {
  const results = response.results ?? [response];
  return results.reduce(
    (total, result) => total + (result.creditsConsumed ?? 0),
    0
  );
}

/** 校验 JSON 响应，并把非 2xx 的结构化错误转成页面异常。 */
async function readJsonResponse(response: Response) {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = generationResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      response.ok
        ? "图片服务返回了无效响应"
        : `请求失败 HTTP ${response.status}`
    );
  }
  if (!response.ok) {
    throw new Error(
      getResponseError(parsed.data) ?? `请求失败 HTTP ${response.status}`
    );
  }
  return parsed.data;
}

/** 从一个 SSE 数据块中提取并校验事件；注释心跳返回 null。 */
function parseStreamBlock(block: string) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error("图片服务返回了无效流事件");
  }
  const parsed = generationStreamEventSchema.safeParse(payload);
  if (!parsed.success) throw new Error("图片服务返回了无效流事件");
  return parsed.data;
}

/**
 * 读取并校验站内媒体 API 的 JSON 或 SSE 响应。
 *
 * @param response 浏览器 fetch 返回的响应。
 * @returns 单次结果或由多个 completed 事件组成的批量结果。
 * @throws HTTP 失败、流截断、非法 JSON/SSE 或没有终态事件时抛出友好错误。
 */
export async function readGenerationResponse(
  response: Response
): Promise<ImageGenerationResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return readJsonResponse(response);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("图片服务返回了空流");
  const decoder = new TextDecoder();
  const completed: z.infer<typeof generationResultSchema>[] = [];
  let failed: z.infer<typeof generationResultSchema> | null = null;
  let buffer = "";

  const processBlock = (block: string) => {
    const event = parseStreamBlock(block);
    if (!event) return;
    if (event.type === "completed") {
      completed.push(event);
    } else if (event.type === "error") {
      failed ??= event;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) processBlock(block);
    if (done) break;
  }
  if (buffer.trim()) processBlock(buffer);

  if (completed.length === 1) return completed[0] ?? {};
  if (completed.length > 1) return { results: completed };
  if (failed) return failed;
  throw new Error("图片服务未返回完成结果");
}
