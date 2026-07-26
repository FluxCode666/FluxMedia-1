/**
 * 模型广场内置品牌兼容标识与默认封面的唯一公开路径映射。
 *
 * 使用方是公开目录构建器和模型卡片；本模块只返回随 Web 应用部署的第一方静态路径，
 * 不读取文件、不访问第三方 CDN，也不根据未知模型猜测品牌。
 */
import type {
  ModelMarketplaceIconKey,
  ModelMarketplacePublicCategory,
} from "@repo/shared/model-marketplace";

/** 共享契约中每个 iconKey 对应的唯一第一方 SVG 路径。 */
export const MODEL_MARKETPLACE_ICON_PATHS = {
  openai: "/model-marketplace/brands/openai.svg",
  google: "/model-marketplace/brands/google.svg",
  kling: "/model-marketplace/brands/kling.svg",
  xai: "/model-marketplace/brands/xai.svg",
  generic: "/model-marketplace/brands/generic.svg",
} as const satisfies Record<ModelMarketplaceIconKey, string>;

/** 图像与视频模型缺少自定义封面时使用的唯一第一方 WebP 路径。 */
export const MODEL_MARKETPLACE_DEFAULT_COVER_PATHS = {
  image: "/model-marketplace/default-image.webp",
  video: "/model-marketplace/default-video.webp",
} as const satisfies Record<ModelMarketplacePublicCategory, string>;

/**
 * 取得共享图标键对应的本地兼容标识路径。
 *
 * @param iconKey - 已由共享 DTO schema 收窄的品牌或通用图标键。
 * @returns 随应用部署且不依赖第三方网络的 SVG 根路径。
 * @sideEffects 无。
 * @failure 类型边界保证键完整，运行时不会回退或猜测未知品牌。
 */
export function getModelMarketplaceIconPath(
  iconKey: ModelMarketplaceIconKey
): string {
  return MODEL_MARKETPLACE_ICON_PATHS[iconKey];
}

/**
 * 取得媒体类别对应的内置默认封面路径。
 *
 * @param category - 公开模型允许的 image 或 video 类别。
 * @returns 固定 1200×800、3:2 的本地 WebP 根路径。
 * @sideEffects 无。
 * @failure 类型边界排除 fallback，运行时不会返回不存在的兜底路径。
 */
export function getDefaultModelMarketplaceCoverPath(
  category: ModelMarketplacePublicCategory
): string {
  return MODEL_MARKETPLACE_DEFAULT_COVER_PATHS[category];
}
