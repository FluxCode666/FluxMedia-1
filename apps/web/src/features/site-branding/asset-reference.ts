/**
 * 网站品牌资产引用的 Web 安全边界。
 *
 * 职责：解析专用站点资产 bucket、校验内容寻址 Logo 引用，并构造第一方读取 URL。
 * 使用方：公共存储读取路由、Logo 上传服务与站点品牌配置读取服务。
 * 关键依赖：无；本模块保持纯函数，供 DB-free 测试复用。
 */

/** 未显式配置时使用的专用网站资产 bucket。 */
export const DEFAULT_SITE_ASSETS_BUCKET_NAME = "site-assets";

const STORAGE_BUCKET_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;
const SITE_LOGO_OBJECT_KEY_PATTERN = /^logo\/[a-f0-9]{64}\.(?:png|svg|ico)$/;

/** 服务端持久化的网站 Logo 对象引用。 */
export interface SiteLogoAssetReference {
  bucket: string;
  key: string;
}

/** 原样持久化的 Logo 扩展名与公开响应 MIME。 */
export type SiteLogoAssetExtension = "png" | "svg" | "ico";

/** 网站资产 bucket 或 Logo key 违反持久化契约。 */
export class SiteBrandingAssetReferenceError extends Error {
  /**
   * 创建不包含原始配置值或对象内容的稳定引用错误。
   *
   * @param message - 可安全写入服务端诊断的错误消息。
   */
  constructor(message: string) {
    super(message);
    this.name = "SiteBrandingAssetReferenceError";
  }
}

/**
 * 解析专用网站资产 bucket。
 *
 * @param value - 运行时系统设置；缺失时采用稳定默认值，显式空白视为配置错误。
 * @returns 可安全放入单个 URL path segment 的 bucket 名称。
 * @sideEffects 无。
 * @failure 名称含路径字符、百分号、控制字符或点目录时显式抛错。
 */
export function parseSiteAssetsBucketName(
  value: string | null | undefined
): string {
  const bucket =
    value === undefined || value === null
      ? DEFAULT_SITE_ASSETS_BUCKET_NAME
      : value.trim();
  if (
    !STORAGE_BUCKET_PATTERN.test(bucket) ||
    bucket === "." ||
    bucket === ".."
  ) {
    throw new SiteBrandingAssetReferenceError("网站资产存储桶名称无效");
  }
  return bucket;
}

/**
 * 验证 Logo 引用属于当前专用 bucket 且使用严格内容寻址的原始格式 key。
 *
 * @param reference - 尚未信任的持久化对象引用。
 * @param siteAssetsBucket - 已解析的当前专用网站资产 bucket。
 * @returns 原引用，供调用方继续读取对象或构造 URL。
 * @sideEffects 无。
 * @failure 跨 bucket、非小写 SHA-256、错误目录或不支持的扩展名时显式抛错。
 */
export function assertSiteLogoAssetReference(
  reference: SiteLogoAssetReference,
  siteAssetsBucket: string
): SiteLogoAssetReference {
  if (reference.bucket !== siteAssetsBucket) {
    throw new SiteBrandingAssetReferenceError("网站 Logo 引用了非法存储桶");
  }
  if (!SITE_LOGO_OBJECT_KEY_PATTERN.test(reference.key)) {
    throw new SiteBrandingAssetReferenceError(
      "网站 Logo 对象 key 不符合内容寻址契约"
    );
  }
  return reference;
}

/**
 * 构造经过完整引用校验的第一方网站 Logo URL。
 *
 * @param reference - 服务端持久化的网站 Logo 对象引用。
 * @param siteAssetsBucket - 已解析的当前专用网站资产 bucket。
 * @returns 只包含安全 path segment 的 `/api/storage/...` 相对 URL。
 * @sideEffects 无。
 * @failure 完整透传 bucket 或对象 key 校验错误，不生成部分 URL。
 */
export function buildSiteLogoAssetUrl(
  reference: SiteLogoAssetReference,
  siteAssetsBucket: string
): string {
  const validReference = assertSiteLogoAssetReference(
    reference,
    siteAssetsBucket
  );
  return `/api/storage/${encodeURIComponent(validReference.bucket)}/${validReference.key}`;
}

/**
 * 使用最终文件哈希和真实扩展名构造内容寻址 Logo key。
 *
 * @param sha256 - 原始上传字节的小写 SHA-256。
 * @param extension - 真实格式对应的扩展名。
 * @returns logo/<sha256>.<extension>。
 * @sideEffects 无。
 * @failure 哈希或扩展名不符合安全契约时抛错。
 */
export function buildSiteLogoObjectKey(
  sha256: string,
  extension: SiteLogoAssetExtension
): string {
  const key = `logo/${sha256}.${extension}`;
  if (!SITE_LOGO_OBJECT_KEY_PATTERN.test(key)) {
    throw new SiteBrandingAssetReferenceError(
      "网站 Logo 对象 key 不符合内容寻址契约"
    );
  }
  return key;
}
