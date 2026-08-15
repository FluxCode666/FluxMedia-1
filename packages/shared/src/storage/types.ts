/**
 * 存储系统类型定义
 *
 * 定义存储提供者接口和相关类型
 */

// ============================================
// 存储提供者接口
// ============================================

/** 前缀扫描返回的单个对象元数据。 */
export type StorageObjectEntry = {
  key: string;
  lastModified: Date;
};

/** 有界对象页；cursor 由 provider 解释，调用方不得解析。 */
export type StorageObjectPage = {
  objects: StorageObjectEntry[];
  nextCursor: string | null;
};

/** 未完成 multipart 的传输无关清理句柄。 */
export type StorageMultipartUploadEntry = {
  key: string;
  initiatedAt: Date;
  cleanupToken: string;
};

/** 有界 multipart 页；cleanupToken 与 cursor 都由 provider 解释。 */
export type StorageMultipartUploadPage = {
  uploads: StorageMultipartUploadEntry[];
  nextCursor: string | null;
};

/**
 * 存储提供者接口
 *
 * 所有存储后端 (S3, R2, MinIO 等) 都需要实现此接口
 */
export interface StorageProvider {
  /**
   * 获取签名读取 URL
   *
   * 用于安全地读取存储中的文件
   *
   * @param key - 文件键名 (路径)
   * @param bucket - 存储桶名称
   * @param expiresIn - URL 有效期 (秒)
   * @returns 签名后的 URL
   */
  getSignedUrl(key: string, bucket: string, expiresIn: number): Promise<string>;

  /**
   * 获取签名上传 URL
   *
   * 用于客户端直接上传文件到存储
   *
   * @param key - 文件键名 (路径)
   * @param bucket - 存储桶名称
   * @param contentType - 文件 MIME 类型
   * @param expiresIn - URL 有效期 (秒，可选，默认 300)
   * @returns 签名后的上传 URL
   */
  getSignedUploadUrl(
    key: string,
    bucket: string,
    contentType: string,
    expiresIn?: number
  ): Promise<string>;

  /**
   * 删除文件
   *
   * @param key - 文件键名 (路径)
   * @param bucket - 存储桶名称
   */
  deleteObject(key: string, bucket: string): Promise<void>;

  /**
   * 按受限前缀分页枚举对象，供后台清理不可达文件。
   *
   * @param prefix 只允许扫描的对象前缀。
   * @param bucket 存储桶名称。
   * @param options opaque cursor 与单页上限。
   * @returns 当前页对象键和最后修改时间，不缓存完整前缀。
   */
  listObjects?(
    prefix: string,
    bucket: string,
    options: { cursor?: string | null; limit: number }
  ): Promise<StorageObjectPage>;

  /**
   * 分页枚举未完成的 multipart 上传，由业务层排除仍活跃的租约。
   *
   * local provider 不需要实现；S3 provider 必须只处理指定前缀。
   *
   * @param prefix 只允许清理的对象前缀。
   * @param bucket 存储桶名称。
   * @param options opaque cursor 与单页上限。
   * @returns 本页上传清理句柄及下一页 cursor。
   */
  listMultipartUploads?(
    prefix: string,
    bucket: string,
    options: { cursor?: string | null; limit: number }
  ): Promise<StorageMultipartUploadPage>;

  /**
   * 终止一个已由调用方确认不属于活跃租约的 multipart 上传。
   *
   * @param key 对象键。
   * @param bucket 存储桶名称。
   * @param cleanupToken provider 列表返回的 opaque 清理句柄。
   */
  abortMultipartUpload?(
    key: string,
    bucket: string,
    cleanupToken: string
  ): Promise<void>;

  /**
   * 获取文件内容
   *
   * @param key - 文件键名 (路径)
   * @param bucket - 存储桶名称
   * @param options - 可选项；`signal` 在调用方取消时（如客户端切换页面打断了
   *   缩略图请求）中止底层下载，立即释放网络与处理资源，而非空跑到底再丢弃结果。
   * @returns 文件内容 Buffer
   */
  getObject(
    key: string,
    bucket: string,
    options?: { signal?: AbortSignal }
  ): Promise<Buffer>;

  /**
   * 流式读取文件，供大文件受控下载使用。
   *
   * @param key 文件键名。
   * @param bucket 存储桶名称。
   * @param options 可选取消信号。
   * @returns 不要求调用方把完整对象载入内存的异步字节流。
   */
  getObjectStream?(
    key: string,
    bucket: string,
    options?: { signal?: AbortSignal }
  ): Promise<AsyncIterable<Uint8Array>>;

  /**
   * 写入文件。
   *
   * @param key 文件键名。
   * @param bucket 存储桶名称。
   * @param data 文件字节。
   * @param contentType 文件 MIME 类型。
   * @param options 可选取消信号；取消后 provider 必须尽快终止底层写入。
   */
  putObject(
    key: string,
    bucket: string,
    data: Buffer,
    contentType: string,
    options?: { signal?: AbortSignal }
  ): Promise<void>;

  /**
   * 流式写入文件，供后台生成不限行数的导出文件。
   *
   * @param key 文件键名。
   * @param bucket 存储桶名称。
   * @param data 异步字节流。
   * @param contentType 文件 MIME 类型。
   * @param options 可选取消信号。
   */
  putObjectStream?(
    key: string,
    bucket: string,
    data: AsyncIterable<Uint8Array>,
    contentType: string,
    options?: { signal?: AbortSignal }
  ): Promise<void>;
}

// ============================================
// 存储配置类型
// ============================================

/**
 * S3 兼容存储配置
 */
export interface S3StorageConfig {
  /** 访问密钥 ID */
  accessKeyId: string;
  /** 访问密钥 */
  secretAccessKey: string;
  /** 端点 URL (如 Cloudflare R2, MinIO) */
  endpoint: string;
  /** 区域 (如 auto, us-east-1) */
  region: string;
}

// ============================================
// 上传相关类型
// ============================================

/**
 * 上传 URL 请求参数
 */
export interface GetUploadUrlParams {
  /** 文件键名 (完整路径，如 avatars/user-123.jpg) */
  key: string;
  /** 文件 MIME 类型 */
  contentType: string;
  /** 存储桶名称 (可选，默认使用头像桶) */
  bucket?: string;
}

/**
 * 上传 URL 响应
 */
export interface GetUploadUrlResult {
  /** 签名上传 URL */
  uploadUrl: string;
  /** 文件键名 */
  key: string;
  /** 存储桶名称 */
  bucket: string;
  /** 系统统一单文件大小上限 */
  maxFileSizeBytes?: number;
}

// ============================================
// 允许的文件类型
// ============================================

/**
 * 允许上传的图片 MIME 类型
 */
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/**
 * 允许的图片类型
 */
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/**
 * 最大文件大小 (5MB)
 */
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * 默认签名 URL 有效期 (秒)
 */
export const DEFAULT_SIGNED_URL_EXPIRES = 3600; // 1 小时

/**
 * 默认上传 URL 有效期 (秒)
 */
export const DEFAULT_UPLOAD_URL_EXPIRES = 300; // 5 分钟
