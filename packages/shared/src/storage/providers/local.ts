/**
 * 本地文件系统存储 provider。
 *
 * 使用方：统一 provider 选择器与兼容直连调用方。工厂实例绑定单次运行时路径
 * 快照；兼容导出则逐次读取路径。所有文件操作共享目录穿越防护。
 */

import { getRuntimeSettingString } from "../../system-settings";
import { buildSignedStorageImageUrl } from "../signed-url";
import type { StorageProvider } from "../types";

/**
 * 路径模块的最小接口
 *
 * 仅声明 resolveSafePath 所需的方法，便于在 DB-free 单测中直接注入
 * node:path，避免依赖运行时设置（getBaseDir → getRuntimeSettingString → DB）。
 */
type PathLike = Pick<typeof import("node:path"), "join" | "resolve" | "sep">;

/**
 * 解析并校验本地存储的最终文件路径（纯函数）
 *
 * baseDir 由调用方注入，因此不触达运行时设置，可独立单测。这是 local 存储
 * deleteObject/getObject/putObject 的唯一目录穿越防线：
 * - 先做 substring 快检拒绝明显的 ".." 穿越；
 * - 再用 path.resolve + startsWith(base + sep) 做权威校验。
 * WHY 必须带 path.sep：否则 base="/data/gen" 会错误接受 "/data/gen-evil/x"
 * 这类前缀混淆路径。
 *
 * @param path - 注入的 path 模块（运行时为 node:path）
 * @param baseDir - 存储根目录
 * @param bucket - 存储桶名称
 * @param key - 文件键名
 * @returns join(baseDir, bucket, key) 得到的安全路径
 * @throws 当 bucket/key 含目录穿越或解析后逃逸出 base 时
 */
export function resolveSafePath(
  path: PathLike,
  baseDir: string,
  bucket: string,
  key: string
): string {
  // Defense-in-depth: fast substring check rejects obvious traversal attempts early,
  // while the path.resolve + startsWith check below is the authoritative guard.
  if (key.includes("..") || bucket.includes("..")) {
    throw new Error("Invalid path: directory traversal not allowed");
  }
  const filePath = path.join(baseDir, bucket, key);

  // 防止路径遍历攻击：确保解析后的路径在允许的目录范围内
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir, bucket);
  if (
    !resolvedPath.startsWith(resolvedBase + path.sep) &&
    resolvedPath !== resolvedBase
  ) {
    throw new Error("Invalid path: directory traversal not allowed");
  }

  return filePath;
}

/**
 * 展开配置中的本地存储根目录。
 *
 * @param configured 管理后台或环境变量提供的路径
 * @returns 可交给 node:path 使用的路径；支持 ~/ 前缀
 */
async function resolveBaseDir(configured: string): Promise<string> {
  if (configured === "~" || configured.startsWith("~/")) {
    const os = await import("node:os");
    const path = await getPath();
    return path.join(os.homedir(), configured.slice(2));
  }
  return configured;
}

/** 获取延迟加载的文件系统模块，避免客户端 bundle 引入 Node.js API。 */
async function getFs(): Promise<typeof import("node:fs/promises")> {
  return await import("node:fs/promises");
}

/** 获取流式文件系统模块，避免客户端 bundle 引入 Node.js API。 */
async function getFsStream(): Promise<typeof import("node:fs")> {
  return await import("node:fs");
}

/** 获取延迟加载的路径模块，避免客户端 bundle 引入 Node.js API。 */
async function getPath(): Promise<typeof import("node:path")> {
  return await import("node:path");
}

/**
 * 按已绑定根目录解析安全文件路径。
 *
 * @param configuredBaseDir provider 创建时绑定的根目录配置
 * @param bucket 存储桶名称
 * @param key 文件键名
 * @returns 经过目录穿越校验的文件路径
 */
async function safePath(
  configuredBaseDir: string,
  bucket: string,
  key: string
): Promise<string> {
  const path = await getPath();
  const baseDir = await resolveBaseDir(configuredBaseDir);
  return resolveSafePath(path, baseDir, bucket, key);
}

/** 构造标准 AbortError，供 provider 在取消边界立即停止外部 I/O。 */
function createStorageAbortError(): DOMException {
  return new DOMException("存储操作已取消", "AbortError");
}

/** 将本地文件读取流收窄为纯字节异步迭代器。 */
async function* readLocalObjectStream(
  filePath: string,
  signal?: AbortSignal
): AsyncGenerator<Uint8Array> {
  const fs = await getFsStream();
  const stream = fs.createReadStream(filePath, signal ? { signal } : undefined);
  for await (const chunk of stream) {
    yield typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  }
}

/**
 * 本地存储提供者
 *
 * 注意（语义差异，调用方须知）：本地后端的 getSignedUrl 返回带 sig/exp 的
 * 站内读取路由 `/api/storage/{bucket}/{key}`，用于提供给外部服务下载。
 * getSignedUploadUrl 仍返回普通 GET 路由，并非可直接 PUT 的上传 URL；S3
 * 后端返回真正的预签名 PUT/GET。因此依赖预签名直传的调用方在 local 后端下
 * 需要走专门的本地上传端点。
 */
export function createLocalStorageProvider(
  configuredBaseDir: string
): StorageProvider {
  return {
    async getSignedUrl(
      key: string,
      bucket: string,
      expiresIn: number
    ): Promise<string> {
      return buildSignedStorageImageUrl(key, bucket, expiresIn) ?? "";
    },

    async getSignedUploadUrl(
      key: string,
      bucket: string,
      _contentType: string
    ): Promise<string> {
      return `/api/storage/${bucket}/${key}`;
    },

    async deleteObject(key: string, bucket: string): Promise<void> {
      const filePath = await safePath(configuredBaseDir, bucket, key);
      const fs = await getFs();
      try {
        await fs.unlink(filePath);
      } catch (error) {
        // 仅将“不存在”视为幂等成功；权限和 I/O 故障必须向上游显式传播。
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      }
    },

    async getObject(
      key: string,
      bucket: string,
      options?: { signal?: AbortSignal }
    ): Promise<Buffer> {
      const filePath = await safePath(configuredBaseDir, bucket, key);
      const fs = await getFs();
      // 透传 signal：调用方取消时中止读取（fs/promises.readFile 支持 { signal }）。
      return fs.readFile(
        filePath,
        options?.signal ? { signal: options.signal } : {}
      ) as Promise<Buffer>;
    },

    async getObjectStream(
      key: string,
      bucket: string,
      options?: { signal?: AbortSignal }
    ): Promise<AsyncIterable<Uint8Array>> {
      const filePath = await safePath(configuredBaseDir, bucket, key);
      return readLocalObjectStream(filePath, options?.signal);
    },

    async putObject(
      key: string,
      bucket: string,
      data: Buffer,
      _contentType: string,
      options?: { signal?: AbortSignal }
    ): Promise<void> {
      const filePath = await safePath(configuredBaseDir, bucket, key);
      const fs = await getFs();
      const path = await getPath();
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        filePath,
        data,
        options?.signal ? { signal: options.signal } : {}
      );
    },

    async putObjectStream(
      key: string,
      bucket: string,
      data: AsyncIterable<Uint8Array>,
      _contentType: string,
      options?: { signal?: AbortSignal }
    ): Promise<void> {
      const filePath = await safePath(configuredBaseDir, bucket, key);
      const fs = await getFs();
      const path = await getPath();
      const { randomUUID } = await import("node:crypto");
      const dir = path.dirname(filePath);
      const tempPath = `${filePath}.${randomUUID()}.tmp`;
      await fs.mkdir(dir, { recursive: true });
      const handle = await fs.open(tempPath, "wx");
      let linked = false;
      try {
        for await (const chunk of data) {
          if (options?.signal?.aborted) throw createStorageAbortError();
          await handle.write(chunk);
        }
        if (options?.signal?.aborted) throw createStorageAbortError();
        await handle.sync();
        await handle.close();
        // WHY：link 在目标已存在时失败，避免重复 worker 覆盖不可变导出对象。
        await fs.link(tempPath, filePath);
        linked = true;
      } finally {
        await handle.close().catch(() => undefined);
        await fs.unlink(tempPath).catch(() => undefined);
        if (!linked && options?.signal?.aborted) {
          await fs.unlink(filePath).catch(() => undefined);
        }
      }
    },
  };
}

/**
 * 兼容直接导入 localProvider 的旧调用方。
 *
 * 每次操作读取最新 LOCAL_STORAGE_PATH 后创建轻量 provider，确保绕过统一入口的
 * 调用方同样不持有启动期路径快照。
 */
export const localProvider: StorageProvider = {
  async getSignedUrl(key, bucket, expiresIn) {
    const provider = await getDynamicLocalProvider();
    return provider.getSignedUrl(key, bucket, expiresIn);
  },
  async getSignedUploadUrl(key, bucket, contentType, expiresIn) {
    const provider = await getDynamicLocalProvider();
    return provider.getSignedUploadUrl(key, bucket, contentType, expiresIn);
  },
  async deleteObject(key, bucket) {
    const provider = await getDynamicLocalProvider();
    return provider.deleteObject(key, bucket);
  },
  async getObject(key, bucket, options) {
    const provider = await getDynamicLocalProvider();
    return provider.getObject(key, bucket, options);
  },
  async getObjectStream(key, bucket, options) {
    const provider = await getDynamicLocalProvider();
    if (!provider.getObjectStream) throw new Error("本地存储不支持流式读取");
    return provider.getObjectStream(key, bucket, options);
  },
  async putObject(key, bucket, data, contentType, options) {
    const provider = await getDynamicLocalProvider();
    return provider.putObject(key, bucket, data, contentType, options);
  },
  async putObjectStream(key, bucket, data, contentType, options) {
    const provider = await getDynamicLocalProvider();
    if (!provider.putObjectStream) throw new Error("本地存储不支持流式写入");
    return provider.putObjectStream(key, bucket, data, contentType, options);
  },
};

/**
 * 为兼容 provider 获取最新本地路径。
 *
 * @returns 绑定当前 LOCAL_STORAGE_PATH 的轻量 provider
 */
async function getDynamicLocalProvider(): Promise<StorageProvider> {
  const configuredBaseDir =
    (await getRuntimeSettingString("LOCAL_STORAGE_PATH")) || "./storage";
  return createLocalStorageProvider(configuredBaseDir);
}
