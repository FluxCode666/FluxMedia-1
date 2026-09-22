/**
 * 生成任务维护与失败退款编排。
 *
 * 使用方包括定时清扫、生成管线和管理入口；退款只接受调用方显式提供的
 * 原计费操作上下文，避免从 sourceRef 或退款发生时间猜测业务归属。
 */

import { requestGoBackendInternalJson } from "./http/go-backend";
import { grantCredits } from "./credits/core";
import type { CreditOperationContext } from "./credits/usage-read-model";

export const IMAGE_GENERATION_PENDING_TIMEOUT_MS = 20 * 60 * 1000;

// 超时文案抽到 DB-free 模块，避免纯分类器经本模块间接初始化数据库连接。

export { IMAGE_GENERATION_TIMEOUT_ERROR } from "./generation-timeout";
export const GENERATION_IMAGE_RETENTION_HOURS_SETTING_KEY =
  "GENERATION_IMAGE_RETENTION_HOURS";
export const GENERATION_IMAGE_RETENTION_MODE_SETTING_KEY =
  "GENERATION_IMAGE_RETENTION_MODE";
export const GENERATION_IMAGE_MAX_COUNT_SETTING_KEY =
  "GENERATION_IMAGE_MAX_COUNT";
export const GENERATION_IMAGE_MAX_COUNT_DEFAULT = 10000;

type ExpireStalePendingGenerationsOptions = {
  userId?: string;
  now?: Date;
  limit?: number;
  timeoutMs?: number;
};

type DestroyExpiredGenerationPhotosOptions = {
  now?: Date;
  limit?: number;
  retentionHours?: number;
};

type DestroyGenerationPhotosByMaxCountOptions = {
  now?: Date;
  limit?: number;
  maxCount?: number;
};

export type GenerationImageStorageReference = {
  bucket: string;
  key: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getGenerationBucket(bucket?: string | null) {
  return bucket?.trim() || "generations";
}

/**
 * 计算超时退款金额（纯函数，DB-free）。
 *
 * 退款 = max(0, 已扣 - 目标保留)。Math.max(0) 防止 target>charged 时退成负数（多退）。
 * sourceRef 由调用方按 `${genId}:timeout-refund` 拼接做幂等键，避免重复退款。
 */
export function computeTimeoutRefund(params: {
  chargedCredits: number;
  targetCredits: number;
}) {
  const chargedCredits = Math.max(0, params.chargedCredits);
  const targetCredits = Math.max(0, params.targetCredits);
  return Math.max(0, chargedCredits - targetCredits);
}

/**
 * 为超时图片行构造原始计费操作身份。
 *
 * 创建时间必须取权威 generation 行，而不是清扫或退款时间；否则跨日退款会错误计入
 * 当日消费。参数来自已持久化行，失败模式由后续投影校验负责处理。
 */
export function createTimedOutImageCreditOperation(params: {
  generationId: string;
  generationCreatedAt: Date;
}): CreditOperationContext {
  return {
    operationType: "image_generation",
    operationId: params.generationId,
    operationCreatedAt: new Date(params.generationCreatedAt),
  };
}

/**
 * 解析照片保留窗口（纯函数，DB-free）。
 *
 * retentionHours<=0（默认 0=永久保留）短路返回 {enabled:false, cutoff:null}，
 * 是阻止全站已完成图片被批量删除的唯一防线；否则 cutoff=now-retentionHours 小时。
 */
export function resolvePhotoRetentionWindow(
  retentionHours: number,
  now: Date
): { enabled: boolean; cutoff: Date | null } {
  if (retentionHours <= 0) {
    return { enabled: false, cutoff: null };
  }
  return {
    enabled: true,
    cutoff: new Date(now.getTime() - retentionHours * 60 * 60 * 1000),
  };
}

/**
 * 解析按张数保留是否启用（纯函数，DB-free）。
 *
 * maxCount<=0 或非有限数短路返回 {enabled:false}，是阻止"保留 0 张=删光全站"的
 * 运行层护栏（写入层 min:1 之外的二次设防），与 resolvePhotoRetentionWindow 的
 * <=0 短路设计对齐。启用时回传归一化后的整数阈值（向下取整，避免小数 OFFSET）。
 */
export function resolveMaxCountRetention(maxCount: number): {
  enabled: boolean;
  maxCount: number;
} {
  if (!Number.isFinite(maxCount) || maxCount <= 0) {
    return { enabled: false, maxCount: 0 };
  }
  return { enabled: true, maxCount: Math.floor(maxCount) };
}

/**
 * 判断一次系统设置写入后是否应立即触发"按最大张数"清理（纯函数，DB-free）。
 *
 * 单点判定，供所有写设置入口（server action 与 UOL operation）共用，保证"启用即执行"
 * 行为在不同传输路径上一致。条件：本次提交确实变更了清理模式键，且其新值为 "count"。
 * changedKeys 来自 setSystemSettings 返回（本次实际写/删的键）；newModeValue 是该键的
 * 新值，清空（回退默认）时调用方应传 undefined，使其不被误判为启用。
 */
export function shouldRunMaxCountCleanupOnSettingsChange(
  changedKeys: readonly string[],
  newModeValue: unknown
): boolean {
  return (
    changedKeys.includes(GENERATION_IMAGE_RETENTION_MODE_SETTING_KEY) &&
    newModeValue === "count"
  );
}

export function collectGenerationImageStorageReferences(params: {
  storageKey?: string | null;
  storageBucket?: string | null;
  metadata?: Record<string, unknown> | null;
}): GenerationImageStorageReference[] {
  const defaultBucket = getGenerationBucket(params.storageBucket);
  const refs = new Map<string, GenerationImageStorageReference>();
  const addReference = (key: unknown, bucketValue?: unknown) => {
    const storageKey = stringValue(key);
    if (!storageKey) return;
    const bucket = stringValue(bucketValue) || defaultBucket;
    refs.set(`${bucket}:${storageKey}`, { bucket, key: storageKey });
  };

  addReference(params.storageKey);

  const outputImage = isRecord(params.metadata?.outputImage)
    ? params.metadata.outputImage
    : null;
  const outputs = Array.isArray(outputImage?.imageOutputs)
    ? outputImage.imageOutputs
    : [];
  for (const output of outputs) {
    if (!isRecord(output)) continue;
    addReference(output.storageKey, output.storageBucket);
  }

  const inputImages = isRecord(params.metadata?.inputImages)
    ? params.metadata.inputImages
    : null;
  const images = Array.isArray(inputImages?.images) ? inputImages.images : [];
  for (const image of images) {
    if (!isRecord(image)) continue;
    addReference(image.storageKey, image.storageBucket);
  }

  return Array.from(refs.values());
}

export function stripDestroyedGenerationImageReferences(
  metadata: Record<string, unknown> | null | undefined,
  params: {
    destroyedAt: string;
    retentionHours: number;
    storageObjectsDeleted: number;
    reason?: "retention" | "user_deleted";
  }
) {
  const nextMetadata = isRecord(metadata) ? { ...metadata } : {};
  const outputImage = isRecord(nextMetadata.outputImage)
    ? { ...nextMetadata.outputImage }
    : {};

  if (Array.isArray(outputImage.imageOutputs)) {
    outputImage.imageOutputs = outputImage.imageOutputs.map((output) => {
      if (!isRecord(output)) return output;
      const nextOutput = { ...output };
      delete nextOutput.storageKey;
      delete nextOutput.imageUrl;
      delete nextOutput.imageFileId;
      return nextOutput;
    });
  }

  outputImage.photoRetention = {
    destroyedAt: params.destroyedAt,
    retentionHours: params.retentionHours,
    storageObjectsDeleted: params.storageObjectsDeleted,
    ...(params.reason ? { reason: params.reason } : {}),
  };
  nextMetadata.outputImage = outputImage;

  const inputImages = isRecord(nextMetadata.inputImages)
    ? { ...nextMetadata.inputImages }
    : null;
  if (inputImages) {
    if (Array.isArray(inputImages.images)) {
      inputImages.images =
        params.reason === "user_deleted"
          ? []
          : inputImages.images.map((image) => {
              if (!isRecord(image)) return image;
              const nextImage = { ...image };
              delete nextImage.storageKey;
              delete nextImage.storageBucket;
              delete nextImage.imageUrl;
              return nextImage;
            });
    }
    inputImages.photoRetention = {
      destroyedAt: params.destroyedAt,
      retentionHours: params.retentionHours,
      storageObjectsDeleted: params.storageObjectsDeleted,
      ...(params.reason ? { reason: params.reason } : {}),
    };
    nextMetadata.inputImages = inputImages;
  }

  return nextMetadata;
}

/**
 * 按原计费操作退还生成积分。
 *
 * 幂等判断统一交给 grantCredits 的事务内唯一约束与 stored context 校验，避免事务外
 * 预查产生竞态或绕过 operation 一致性检查。
 */
export async function refundGenerationCredits(params: {
  generationId: string;
  userId: string;
  amount: number;
  sourceRef: string;
  description: string;
  operation: CreditOperationContext;
  metadata?: Record<string, unknown>;
}) {
  if (params.amount <= 0) {
    return { refunded: false, amount: 0 };
  }

  const result = await grantCredits({
    userId: params.userId,
    amount: params.amount,
    sourceType: "refund",
    debitAccount: "SYSTEM:generation_refund",
    transactionType: "refund",
    operation: params.operation,
    sourceRef: params.sourceRef,
    description: params.description,
    metadata: {
      generationId: params.generationId,
      ...params.metadata,
    },
  });

  return { refunded: !result.alreadyGranted, amount: params.amount };
}

export async function expireStalePendingGenerations(options: ExpireStalePendingGenerationsOptions = {}) {
  const result = await requestGoBackendInternalJson<{ details: Array<{generationId:string;userId:string;creditsRefunded:number;refundGranted:boolean}> }>("/api/jobs/images/expire-pending", {method:"POST",body:JSON.stringify(options)});
  return result.details;
}

type RetentionDetail = { generationId: string; userId: string; storageObjectsDeleted: number };
type RetentionResult = { enabled: boolean; destroyed: number; failed: number; storageObjectsDeleted: number; details: RetentionDetail[] };
export async function destroyExpiredGenerationPhotos(options: DestroyExpiredGenerationPhotosOptions = {}) {
  return requestGoBackendInternalJson<RetentionResult & {retentionHours:number;cutoff:string|null}>("/api/jobs/images/retention", {method:"POST",body:JSON.stringify({...options,mode:"time"})});
}
export async function destroyGenerationPhotosByMaxCount(options: DestroyGenerationPhotosByMaxCountOptions = {}) {
  return requestGoBackendInternalJson<RetentionResult & {maxCount:number}>("/api/jobs/images/retention", {method:"POST",body:JSON.stringify({...options,mode:"count"})});
}
