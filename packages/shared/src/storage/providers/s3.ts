/**
 * S3 兼容存储提供者
 *
 * 支持 AWS S3、Cloudflare R2、MinIO 等 S3 兼容存储
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  DEFAULT_SIGNED_URL_EXPIRES,
  DEFAULT_UPLOAD_URL_EXPIRES,
  type S3StorageConfig,
  type StorageProvider,
} from "../types";
import {
  createS3ClientFingerprint,
  getStorageRuntimeConfig,
  type StorageRuntimeConfig,
} from "./runtime-config";

// ============================================
// S3 客户端单例
// ============================================

/** 进程内 S3 client 缓存，仅保存安全指纹与 client，不保存独立明文缓存键。 */
let cachedS3Client:
  | {
      fingerprint: string;
      client: S3Client;
    }
  | undefined;

const S3_MULTIPART_PART_BYTES = 5 * 1024 * 1024;

/**
 * 校验并收窄 S3 存储配置
 *
 * @param config 当前运行时配置快照
 * @returns endpoint 与凭证均完整的 S3 配置
 * @throws S3 必需配置缺失时抛出不含密钥值的错误
 */
function requireS3StorageConfig(config: StorageRuntimeConfig): S3StorageConfig {
  if (!config.accessKeyId || !config.secretAccessKey || !config.endpoint) {
    throw new Error(
      "存储配置缺失: 请设置 STORAGE_ACCESS_KEY_ID、STORAGE_SECRET_ACCESS_KEY、STORAGE_ENDPOINT"
    );
  }

  return {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    endpoint: config.endpoint,
    region: config.region,
  };
}

/**
 * 当连接配置变化时销毁旧 S3 client。
 *
 * @param config 当前存储配置快照
 * @remarks 不创建新 client；仅在安全指纹变化时释放旧连接池
 */
export function prepareS3ClientConfig(config: StorageRuntimeConfig): void {
  const fingerprint = createS3ClientFingerprint(config);
  if (cachedS3Client && cachedS3Client.fingerprint !== fingerprint) {
    cachedS3Client.client.destroy();
    cachedS3Client = undefined;
  }
}

/**
 * 销毁当前缓存的 S3 client。
 *
 * @remarks local/S3 模式切换时调用；无缓存时为空操作
 */
export function destroyCachedS3Client(): void {
  cachedS3Client?.client.destroy();
  cachedS3Client = undefined;
}

/**
 * 获取与配置指纹匹配的 S3 client。
 *
 * @param runtimeConfig 当前存储配置快照
 * @returns 可复用的 S3Client
 * @throws endpoint 或凭证缺失时抛出明确配置错误
 */
function getS3Client(runtimeConfig: StorageRuntimeConfig): S3Client {
  const config = requireS3StorageConfig(runtimeConfig);
  const fingerprint = createS3ClientFingerprint(runtimeConfig);
  prepareS3ClientConfig(runtimeConfig);

  if (!cachedS3Client) {
    cachedS3Client = {
      fingerprint,
      client: new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        // Cloudflare R2 与 MinIO 需要路径风格寻址。
        forcePathStyle: true,
      }),
    };
  }

  return cachedS3Client.client;
}

/** 构造标准 AbortError，供 multipart 上传在取消时停止并清理。 */
function createStorageAbortError(): DOMException {
  return new DOMException("存储操作已取消", "AbortError");
}

/** 将 S3 Web 流收窄为纯字节异步迭代器。 */
async function* readS3ObjectStream(body: {
  transformToWebStream(): ReadableStream<Uint8Array>;
}): AsyncGenerator<Uint8Array> {
  const reader = body.transformToWebStream().getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================
// S3 存储提供者实现
// ============================================

/**
 * S3 兼容存储提供者
 *
 * 实现 StorageProvider 接口，支持：
 * - Cloudflare R2
 * - AWS S3
 * - MinIO
 * - 其他 S3 兼容存储
 */
export function createS3StorageProvider(
  config: StorageRuntimeConfig
): StorageProvider {
  return {
    /**
     * 获取签名读取 URL
     *
     * @param key - 文件键名
     * @param bucket - 存储桶名称
     * @param expiresIn - 有效期 (秒)
     * @returns 签名 URL
     */
    async getSignedUrl(
      key: string,
      bucket: string,
      expiresIn: number = DEFAULT_SIGNED_URL_EXPIRES
    ): Promise<string> {
      const client = getS3Client(config);

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const signedUrl = await getSignedUrl(client, command, {
        expiresIn,
      });

      return signedUrl;
    },

    /**
     * 获取签名上传 URL
     *
     * @param key - 文件键名
     * @param bucket - 存储桶名称
     * @param contentType - 文件 MIME 类型
     * @param expiresIn - 有效期 (秒)
     * @returns 签名上传 URL
     */
    async getSignedUploadUrl(
      key: string,
      bucket: string,
      contentType: string,
      expiresIn: number = DEFAULT_UPLOAD_URL_EXPIRES
    ): Promise<string> {
      const client = getS3Client(config);

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
      });

      const signedUrl = await getSignedUrl(client, command, {
        expiresIn,
      });

      return signedUrl;
    },

    /**
     * 删除文件
     *
     * @param key - 文件键名
     * @param bucket - 存储桶名称
     */
    async deleteObject(key: string, bucket: string): Promise<void> {
      const client = getS3Client(config);

      const command = new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      await client.send(command);
    },

    /**
     * 获取文件内容
     *
     * @param key - 文件键名
     * @param bucket - 存储桶名称
     * @returns 文件内容 Buffer
     */
    async getObject(
      key: string,
      bucket: string,
      options?: { signal?: AbortSignal }
    ): Promise<Buffer> {
      const client = getS3Client(config);

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      // 透传 abortSignal：调用方取消（如缩略图请求被页面切换打断）时，SDK 会
      // 中止进行中的下载并断开连接，立即释放资源。exactOptionalPropertyTypes 下
      // 不能传 abortSignal: undefined，故用条件展开仅在有信号时附带该字段。
      const response = await client.send(
        command,
        options?.signal ? { abortSignal: options.signal } : {}
      );

      if (!response.Body) {
        throw new Error(`File not found: ${key}`);
      }

      // 将 ReadableStream 转换为 Buffer
      const chunks: Uint8Array[] = [];
      const reader = response.Body.transformToWebStream().getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      return Buffer.concat(chunks);
    },

    async getObjectStream(
      key: string,
      bucket: string,
      options?: { signal?: AbortSignal }
    ): Promise<AsyncIterable<Uint8Array>> {
      const client = getS3Client(config);
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        options?.signal ? { abortSignal: options.signal } : {}
      );
      if (!response.Body) throw new Error(`File not found: ${key}`);
      return readS3ObjectStream(response.Body);
    },

    async putObject(
      key: string,
      bucket: string,
      data: Buffer,
      contentType: string,
      options?: { signal?: AbortSignal }
    ): Promise<void> {
      const client = getS3Client(config);
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      });
      await client.send(
        command,
        options?.signal ? { abortSignal: options.signal } : {}
      );
    },

    async putObjectStream(
      key: string,
      bucket: string,
      data: AsyncIterable<Uint8Array>,
      contentType: string,
      options?: { signal?: AbortSignal }
    ): Promise<void> {
      const client = getS3Client(config);
      const requestOptions = options?.signal
        ? { abortSignal: options.signal }
        : {};
      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType,
        }),
        requestOptions
      );
      if (!created.UploadId) {
        throw new Error("S3 multipart upload did not return an upload id");
      }
      const uploadId = created.UploadId;
      const completedParts: { ETag: string; PartNumber: number }[] = [];
      let pending: Buffer[] = [];
      let pendingBytes = 0;

      /** 上传当前已聚合的一段，并立即释放其内存。 */
      const flushPart = async () => {
        const partNumber = completedParts.length + 1;
        const response = await client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: Buffer.concat(pending, pendingBytes),
          }),
          requestOptions
        );
        if (!response.ETag) throw new Error("S3 multipart part missing ETag");
        completedParts.push({ ETag: response.ETag, PartNumber: partNumber });
        pending = [];
        pendingBytes = 0;
      };

      try {
        for await (const value of data) {
          let offset = 0;
          const chunk = Buffer.from(value);
          while (offset < chunk.length) {
            if (options?.signal?.aborted) throw createStorageAbortError();
            const available = S3_MULTIPART_PART_BYTES - pendingBytes;
            const length = Math.min(available, chunk.length - offset);
            pending.push(chunk.subarray(offset, offset + length));
            pendingBytes += length;
            offset += length;
            if (pendingBytes === S3_MULTIPART_PART_BYTES) await flushPart();
          }
        }
        if (options?.signal?.aborted) throw createStorageAbortError();
        if (pendingBytes > 0 || completedParts.length === 0) await flushPart();
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: completedParts },
          }),
          requestOptions
        );
      } catch (error) {
        await client
          .send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
            })
          )
          .catch(() => undefined);
        throw error;
      }
    },
  };
}

/**
 * 兼容直接导入 s3Provider 的旧调用方。
 *
 * 每次操作读取最新运行时配置，并由指纹缓存复用或轮换底层 S3 client。
 */
export const s3Provider: StorageProvider = {
  async getSignedUrl(key, bucket, expiresIn) {
    const provider = await getDynamicS3Provider();
    return provider.getSignedUrl(key, bucket, expiresIn);
  },
  async getSignedUploadUrl(key, bucket, contentType, expiresIn) {
    const provider = await getDynamicS3Provider();
    return provider.getSignedUploadUrl(key, bucket, contentType, expiresIn);
  },
  async deleteObject(key, bucket) {
    const provider = await getDynamicS3Provider();
    return provider.deleteObject(key, bucket);
  },
  async getObject(key, bucket, options) {
    const provider = await getDynamicS3Provider();
    return provider.getObject(key, bucket, options);
  },
  async getObjectStream(key, bucket, options) {
    const provider = await getDynamicS3Provider();
    return provider.getObjectStream(key, bucket, options);
  },
  async putObject(key, bucket, data, contentType, options) {
    const provider = await getDynamicS3Provider();
    return provider.putObject(key, bucket, data, contentType, options);
  },
  async putObjectStream(key, bucket, data, contentType, options) {
    const provider = await getDynamicS3Provider();
    return provider.putObjectStream(key, bucket, data, contentType, options);
  },
};

/**
 * 读取当前配置并创建轻量 S3 provider。
 *
 * @returns 绑定当前配置快照的 provider
 */
async function getDynamicS3Provider(): Promise<StorageProvider> {
  return createS3StorageProvider(await getStorageRuntimeConfig());
}

// ============================================
// 便捷函数导出
// ============================================

/**
 * 获取 S3 存储提供者
 *
 * 当前默认使用 S3 兼容存储
 */
export function getS3StorageProvider(): StorageProvider {
  return s3Provider;
}
