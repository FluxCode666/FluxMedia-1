/**
 * 模型广场自定义封面引用的 Web 安全边界。
 *
 * 使用方是管理读取、公开目录和公共存储路由；本模块只接受服务端内容寻址流程生成的
 * bucket 与对象 key，并集中构造不会被 URL 规范化改写到其他路由的第一方读取路径。
 */
import type {
  ModelMarketplaceCoverRef,
  ModelMarketplacePublicCategory,
} from "@repo/shared/model-marketplace";
import { modelMarketplaceCoverObjectKeySchema } from "@repo/shared/model-marketplace";

const STORAGE_BUCKET_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;

/** 模型资产 bucket 或内容寻址 key 违反持久化契约。 */
export class ModelMarketplaceAssetReferenceError extends Error {
  /**
   * 创建不包含底层存储凭据的稳定引用错误。
   *
   * @param message - 可写入服务端诊断但不包含原始数据库 JSON 的错误消息。
   */
  constructor(message: string) {
    super(message);
    this.name = "ModelMarketplaceAssetReferenceError";
  }
}

/**
 * 收窄可安全放入单个 URL path segment 的模型资产 bucket。
 *
 * @param value - 运行时系统设置读取出的未知可选文本。
 * @returns 去除首尾空白且不含斜杠、控制字符、百分号或点目录的 bucket。
 * @sideEffects 无。
 * @failure 缺失、过长、含路径字符或等于 `.`/`..` 时显式抛错。
 */
export function parseModelMarketplaceAssetBucketName(
  value: string | null | undefined
): string {
  const bucket = value?.trim() ?? "";
  if (
    !STORAGE_BUCKET_PATTERN.test(bucket) ||
    bucket === "." ||
    bucket === ".."
  ) {
    throw new ModelMarketplaceAssetReferenceError("模型资产存储桶名称无效");
  }
  return bucket;
}

/**
 * 验证持久化封面确实属于专用 bucket 和当前媒体类别的内容寻址命名空间。
 *
 * @param category - 当前条目的 image 或 video 类别。
 * @param cover - 数据库配置中的非空封面引用。
 * @param assetBucket - 已通过 bucket 名称校验的专用资产 bucket。
 * @returns 原引用；调用方可在校验后继续构造 URL 或访问对象存储。
 * @sideEffects 无。
 * @failure bucket 跨域、key 不是三段小写 SHA-256 WebP 或类别不一致时显式抛错。
 */
export function assertModelMarketplaceCoverReference(
  category: ModelMarketplacePublicCategory,
  cover: ModelMarketplaceCoverRef,
  assetBucket: string
): ModelMarketplaceCoverRef {
  if (cover.bucket !== assetBucket) {
    throw new ModelMarketplaceAssetReferenceError("模型封面引用了非法存储桶");
  }
  const parsedKey = modelMarketplaceCoverObjectKeySchema.safeParse(cover.key);
  if (!parsedKey.success || !parsedKey.data.startsWith(`${category}/`)) {
    throw new ModelMarketplaceAssetReferenceError(
      "模型封面对象 key 不符合内容寻址契约"
    );
  }
  return cover;
}

/**
 * 构造经过完整引用校验的第一方模型封面读取 URL。
 *
 * @param category - 当前模型类别，用于阻止 image/video 命名空间串用。
 * @param cover - 服务端持久化的封面引用。
 * @param assetBucket - 当前专用模型资产 bucket。
 * @returns 仅包含安全 path segment 的 `/api/storage/...` 相对 URL。
 * @sideEffects 无。
 * @failure 完整透传 bucket 或对象 key 校验错误，不生成部分 URL。
 */
export function buildModelMarketplaceCoverUrl(
  category: ModelMarketplacePublicCategory,
  cover: ModelMarketplaceCoverRef,
  assetBucket: string
): string {
  const reference = assertModelMarketplaceCoverReference(
    category,
    cover,
    assetBucket
  );
  const encodedBucket = encodeURIComponent(reference.bucket);
  const encodedKey = reference.key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/storage/${encodedBucket}/${encodedKey}`;
}
