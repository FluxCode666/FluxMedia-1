/**
 * 跨运行时媒体输入常量。
 *
 * 职责：集中定义浏览器、服务端与统一接口层共享的 MIME、数量和字节硬上限。
 * 本模块不得引入 Node 专属依赖，客户端能力面板会直接消费这些常量。
 */

const BYTES_PER_MB = 1024 * 1024;

/** 单项和单次媒体输入的安全硬上限；套餐限制可进一步收紧。 */
export const MAX_MEDIA_INPUT_BYTES = 200 * BYTES_PER_MB;

/** 单次媒体引用数量硬上限；套餐 maxEditImages 可进一步收紧。 */
export const MAX_MEDIA_INPUT_COUNT = 256;

/** 保留媒体链路允许的输入图片 MIME。 */
export const MEDIA_INPUT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
