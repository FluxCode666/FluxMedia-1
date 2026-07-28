/**
 * Adobe Firefly（adobe2api）请求适配器（纯函数，DB-free，可单测）。
 *
 * 职责：把站内统一的图像参数（prompt + size WxH + 模型家族）适配成 adobe2api 的
 * OpenAI 兼容请求——adobe2api 把宽高比/分辨率/时长编码进 model id
 * （上游仍使用 `firefly-<family>-<resolution>-<ratio>`），输入图以 base64 data URL 放在
 * messages content 的 image_url 里。
 * 使用方：image-generation 的 adobe 后端适配（apps/web 侧请求构造）。
 * 关键依赖：无（纯字符串/数值计算）。
 */

// adobe2api 图像模型家族（视频家族见 Phase 3）。
export type AdobeImageFamily =
  | "gpt-image-2"
  | "gpt-image-1.5"
  | "nano-banana"
  | "nano-banana2"
  | "nano-banana-pro";

// adobe2api 通用宽高比（nano-banana2 另支持 1x8/1x4/4x1/8x1，本映射只用通用集）。
export type AdobeRatio = "1x1" | "16x9" | "9x16" | "4x3" | "3x4";

export type AdobeImageResolution = "1k" | "2k" | "4k";

const RATIO_VALUES: Array<{ ratio: AdobeRatio; value: number }> = [
  { ratio: "1x1", value: 1 },
  { ratio: "16x9", value: 16 / 9 },
  { ratio: "9x16", value: 9 / 16 },
  { ratio: "4x3", value: 4 / 3 },
  { ratio: "3x4", value: 3 / 4 },
];

/**
 * 解析 "WxH" 尺寸字符串为像素宽高；非法/auto 返回 null。
 */
export function parseSizeWxH(
  size?: string | null
): { width: number; height: number } | null {
  const match = (size || "").trim().toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * 把任意 WxH 尺寸映射到 adobe 支持的 {ratio, resolution}（Phase 1 用）。
 *
 * - ratio：按宽高比取最接近的通用比例（1x1/16x9/9x16/4x3/3x4）。
 * - resolution：按长边——<=1024→1k，<=2048→2k，否则 4k。
 * - size 非法/auto 时回退到 fallback（默认 1x1 + 2k）。
 */
export function mapSizeToAdobe(
  size?: string | null,
  fallback: { ratio: AdobeRatio; resolution: AdobeImageResolution } = {
    ratio: "1x1",
    resolution: "2k",
  }
): { ratio: AdobeRatio; resolution: AdobeImageResolution } {
  const parsed = parseSizeWxH(size);
  if (!parsed) return fallback;

  const target = parsed.width / parsed.height;
  let best: { ratio: AdobeRatio; value: number } = { ratio: "1x1", value: 1 };
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const candidate of RATIO_VALUES) {
    const delta = Math.abs(candidate.value - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = candidate;
    }
  }

  const maxEdge = Math.max(parsed.width, parsed.height);
  const resolution: AdobeImageResolution =
    maxEdge <= 1024 ? "1k" : maxEdge <= 2048 ? "2k" : "4k";

  return { ratio: best.ratio, resolution };
}

/**
 * 组装平台公开图像 model id：`<family>-<resolution>-<ratio>`。
 */
export function composeAdobeImageModelId(params: {
  family: AdobeImageFamily;
  resolution: AdobeImageResolution;
  ratio: AdobeRatio;
}): string {
  return `${params.family}-${params.resolution}-${params.ratio}`;
}

/**
 * 把图片二进制编码为 adobe2api 接受的 base64 data URL。
 */
export function toAdobeImageDataUrl(file: {
  data: Buffer | Uint8Array;
  type?: string | null;
}): string {
  const mime = (file.type || "").trim() || "image/png";
  const base64 = Buffer.from(file.data).toString("base64");
  return `data:${mime};base64,${base64}`;
}

export type AdobeImageInput = { data: Buffer | Uint8Array; type?: string | null };

/**
 * 构建 adobe2api 图像请求（/v1/chat/completions 统一入口）。
 *
 * 文生图：messages 仅 text；图生图：text + 各输入图的 image_url（base64 data URL）。
 * 宽高比/分辨率已编码进 model id；不发送 OpenAI 非标准的 width/height/response_format。
 */
export function buildAdobeImageRequestBody(params: {
  family: AdobeImageFamily;
  prompt: string;
  size?: string | null;
  ratio?: AdobeRatio;
  resolution?: AdobeImageResolution;
  images?: AdobeImageInput[];
  stream?: boolean;
}): Record<string, unknown> {
  const mapped =
    params.ratio && params.resolution
      ? { ratio: params.ratio, resolution: params.resolution }
      : mapSizeToAdobe(params.size);
  const ratio = params.ratio ?? mapped.ratio;
  const resolution = params.resolution ?? mapped.resolution;
  // adobe2api gateway 的协议仍依赖旧前缀；只在上游适配边界补回，不能让该前缀重新
  // 泄漏到平台目录、成员能力或外部 API。
  const model = `firefly-${composeAdobeImageModelId({
    family: params.family,
    resolution,
    ratio,
  })}`;

  const inputs = params.images ?? [];
  const content =
    inputs.length > 0
      ? [
          { type: "text", text: params.prompt },
          ...inputs.map((image) => ({
            type: "image_url",
            image_url: { url: toAdobeImageDataUrl(image) },
          })),
        ]
      : params.prompt;

  return {
    model,
    messages: [{ role: "user", content }],
    ...(params.stream ? { stream: true } : {}),
  };
}
