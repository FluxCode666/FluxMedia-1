/**
 * 运营导出对象存储适配与流式统计。
 *
 * 使用方：导出 worker 与受控下载路由。该模块只封装 StorageProvider 的流能力、
 * 文件命名和 SHA-256/行字节统计；缺少流能力时显式失败，不退化为全量 Buffer。
 */
import { createHash } from "node:crypto";

import type {
  StorageMultipartUploadPage,
  StorageObjectPage,
  StorageProvider,
} from "@repo/shared/storage";

/** 导出对象固定使用通用存储桶下的独立前缀。 */
export const OPERATIONS_EXPORT_OBJECT_PREFIX = "operations-exports";
/** 下载许可只需覆盖一次页面跳转，不延长七天保留边界。 */
export const OPERATIONS_EXPORT_DOWNLOAD_TTL_SECONDS = 60;

/** worker 需要的最小可替换存储端口。 */
export type OperationsExportStorage = {
  bucket: string;
  remote: boolean;
  putObjectStream(
    key: string,
    bucket: string,
    data: AsyncIterable<Uint8Array>,
    contentType: string,
    options?: { signal?: AbortSignal }
  ): Promise<void>;
  getObjectStream(
    key: string,
    bucket: string,
    options?: { signal?: AbortSignal }
  ): Promise<AsyncIterable<Uint8Array>>;
  deleteObject(key: string, bucket: string): Promise<void>;
  listObjects(
    prefix: string,
    bucket: string,
    options: { cursor?: string | null; limit: number }
  ): Promise<StorageObjectPage>;
  listMultipartUploads?(
    prefix: string,
    bucket: string,
    options: { cursor?: string | null; limit: number }
  ): Promise<StorageMultipartUploadPage>;
  abortMultipartUpload?(
    key: string,
    bucket: string,
    cleanupToken: string
  ): Promise<void>;
  getSignedUrl(key: string, bucket: string, expiresIn: number): Promise<string>;
};

/** 流式上传完成后的可审计完整性元数据。 */
export type OperationsExportStreamResult = {
  checksumSha256: string;
  rowCount: number;
  byteCount: number;
};

/**
 * 跨 chunk 识别 RFC 4180 记录终止符，忽略引号字段内部的换行。
 *
 * 编码器总是使用双引号包裹含换行字段，并把内部双引号写成两个连续引号；状态机
 * 因此只需保留“当前位于引号内”和“上一字节可能是结束引号”两个跨块状态。
 */
function createCsvRecordCounter(): {
  push(chunk: Uint8Array): void;
  count(): number;
} {
  let inQuotes = false;
  let pendingQuote = false;
  let records = 0;
  return {
    push(chunk) {
      for (const byte of chunk) {
        if (inQuotes) {
          if (pendingQuote) {
            if (byte === 0x22) {
              pendingQuote = false;
              continue;
            }
            inQuotes = false;
            pendingQuote = false;
          } else if (byte === 0x22) {
            pendingQuote = true;
            continue;
          } else {
            continue;
          }
        }
        if (byte === 0x22) inQuotes = true;
        else if (byte === 0x0a) records += 1;
      }
    },
    count: () => records,
  };
}

/**
 * 包装字节流并增量统计，不读取或缓存后续 chunk。
 *
 * @param source CSV 编码器产生的异步字节流。
 * @param options 不计入业务行数的 BOM/表头行数；BOM 不含换行因而无需单列。
 * @returns 可传给 provider 的单次消费流和消费完成后的统计 Promise。
 * @failure 上游读取失败时流和统计结果都失败，调用方不得发布部分对象。
 */
export function createMeasuredExportStream(
  source: AsyncIterable<Uint8Array>,
  options: { headerRows: number }
): {
  stream: AsyncIterable<Uint8Array>;
  result: Promise<OperationsExportStreamResult>;
} {
  let resolveResult: (value: OperationsExportStreamResult) => void = () => {};
  let rejectResult: (reason: unknown) => void = () => {};
  const result = new Promise<OperationsExportStreamResult>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    }
  );
  // provider 可能先拒绝上传而不继续消费流；挂载内部 handler 防止统计 Promise 在
  // 调用方进入 catch 前被 Node 识别为未处理拒绝，原 Promise 仍保持 rejected。
  void result.catch(() => undefined);
  const stream = (async function* () {
    const hash = createHash("sha256");
    let byteCount = 0;
    const recordCounter = createCsvRecordCounter();
    try {
      for await (const chunk of source) {
        hash.update(chunk);
        byteCount += chunk.byteLength;
        recordCounter.push(chunk);
        yield chunk;
      }
      resolveResult({
        checksumSha256: hash.digest("hex"),
        rowCount: Math.max(0, recordCounter.count() - options.headerRows),
        byteCount,
      });
    } catch (error) {
      rejectResult(error);
      throw error;
    }
  })();
  return { stream, result };
}

/** 构造包含 task 和 fencing token 的不可覆盖对象键。 */
export function buildOperationsExportObjectKey(input: {
  taskId: string;
  leaseToken: string;
}): string {
  return `${OPERATIONS_EXPORT_OBJECT_PREFIX}/${input.taskId}/${input.leaseToken}.csv`;
}

/** 从专用对象键恢复 task 与 lease，供 multipart 清理排除活跃 worker。 */
export function parseOperationsExportObjectKey(
  key: string
): { taskId: string; leaseToken: string } | null {
  const prefix = `${OPERATIONS_EXPORT_OBJECT_PREFIX}/`;
  if (!key.startsWith(prefix)) return null;
  const parts = key.slice(prefix.length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const csvMarker = parts[1].indexOf(".csv");
  if (csvMarker <= 0) return null;
  const suffix = parts[1].slice(csvMarker + 4);
  if (suffix && !/^\.[a-zA-Z0-9-]+\.tmp$/.test(suffix)) return null;
  return { taskId: parts[0], leaseToken: parts[1].slice(0, csvMarker) };
}

/** 把运行时存储快照收窄为导出所需的强制流能力。 */
function requireExportStorage(
  provider: StorageProvider,
  bucket: string,
  remote: boolean
): OperationsExportStorage {
  if (
    !provider.putObjectStream ||
    !provider.getObjectStream ||
    !provider.listObjects
  ) {
    throw new Error("当前存储提供者不支持运营导出所需的流式读写");
  }
  return {
    bucket,
    remote,
    putObjectStream: provider.putObjectStream.bind(provider),
    getObjectStream: provider.getObjectStream.bind(provider),
    deleteObject: provider.deleteObject.bind(provider),
    listObjects: provider.listObjects.bind(provider),
    ...(provider.listMultipartUploads && provider.abortMultipartUpload
      ? {
          listMultipartUploads: provider.listMultipartUploads.bind(provider),
          abortMultipartUpload: provider.abortMultipartUpload.bind(provider),
        }
      : {}),
    getSignedUrl: provider.getSignedUrl.bind(provider),
  };
}

/** 读取单一运行时快照，保证 provider、bucket 与 remote 模式不跨配置版本。 */
export async function getOperationsExportStorage(): Promise<OperationsExportStorage> {
  const { getStorageRuntimeSnapshot } = await import(
    "@repo/shared/storage/providers"
  );
  const snapshot = await getStorageRuntimeSnapshot();
  return requireExportStorage(
    snapshot.provider,
    snapshot.bucketName,
    snapshot.endpoint !== null
  );
}
