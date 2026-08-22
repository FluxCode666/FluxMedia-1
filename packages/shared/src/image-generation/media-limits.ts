/**
 * 跨运行时媒体输入常量。
 *
 * 职责：集中定义浏览器、服务端与统一接口层共享的 MIME、数量和字节硬上限。
 * 本模块不得引入 Node 专属依赖，客户端能力面板会直接消费这些常量。
 */

const BYTES_PER_MB = 1024 * 1024;

/** 单个媒体输入的安全硬上限；运行时系统策略可进一步收紧。 */
export const MAX_MEDIA_INPUT_FILE_BYTES = 200 * BYTES_PER_MB;

/** 单次请求全部媒体输入的安全硬上限；运行时系统策略可进一步收紧。 */
export const MAX_MEDIA_INPUT_BYTES = 512 * BYTES_PER_MB;

/** 参考视频单文件业务上限。 */
export const MAX_REFERENCE_VIDEO_BYTES = 200 * BYTES_PER_MB;

/** 参考音频单文件业务上限。 */
export const MAX_REFERENCE_AUDIO_BYTES = 15 * BYTES_PER_MB;

/** 单次媒体引用数量硬上限；运行时编辑参考图策略可进一步收紧。 */
export const MAX_MEDIA_INPUT_COUNT = 256;

/** 视频参考输入允许的容器 MIME。 */
export const VIDEO_REFERENCE_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
] as const;

/** 音频参考输入允许的容器 MIME。 */
export const AUDIO_REFERENCE_MIME_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
] as const;

/** 保留媒体链路允许的输入 MIME。 */
export const MEDIA_INPUT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  ...VIDEO_REFERENCE_MIME_TYPES,
  ...AUDIO_REFERENCE_MIME_TYPES,
] as const;
