/**
 * U7 视频历史输入资产收编内核。
 *
 * 职责：验证旧 storage/remote 引用，将非任务自有对象复制到确定性的任务前缀，并在
 * 全部对象就绪后一次性持久化旧输入列。模块只依赖注入的 I/O，可由迁移脚本和 DB-free
 * 测试复用；不会删除源对象，也不会在返回值或错误中暴露 bucket、key 或 URL。
 */

import { createHash } from "node:crypto";

const MAX_MEDIA_INPUT_COUNT = 256;
const MAX_MEDIA_INPUT_BYTES = 200 * 1024 * 1024;
const MAX_STORAGE_KEY_LENGTH = 1_024;
const MAX_BUCKET_LENGTH = 128;
const MAX_REMOTE_URL_LENGTH = 4_096;
const MIGRATION_ATTEMPT_ID = "migration-v1";

const MEDIA_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
type MediaMimeType = (typeof MEDIA_MIME_TYPES)[number];

/** U7 前视频任务允许存在的单个历史输入引用。 */
export type LegacyVideoInputReference =
  | {
      source: "storage";
      mimeType: MediaMimeType;
      storageKey: string;
      storageBucket?: string;
      byteLength: number;
    }
  | {
      source: "remote";
      mimeType: MediaMimeType;
      url: string;
      byteLength: number;
    };

/** 0074 可安全转换成具名清单的任务自有 storage 引用。 */
export type MigratedVideoInputReference = {
  source: "storage";
  mimeType: MediaMimeType;
  storageKey: string;
  storageBucket: string;
  byteLength: number;
};

/** 脚本从数据库读取的最小任务快照。 */
export interface VideoInputMigrationTask {
  id: string;
  userId: string;
  inputImageRefs: unknown;
}

/** 迁移内核的全部可替换 I/O。 */
export interface VideoInputMigrationDependencies {
  currentBucket: string;
  readStorage(input: {
    storageKey: string;
    storageBucket: string;
    maxBytes: number;
  }): Promise<Buffer>;
  readStorageIfExists(input: {
    storageKey: string;
    storageBucket: string;
    maxBytes: number;
  }): Promise<Buffer | null>;
  readRemote(input: {
    url: string;
    mimeType: MediaMimeType;
    maxBytes: number;
  }): Promise<Buffer>;
  putStorage(input: {
    storageKey: string;
    storageBucket: string;
    mimeType: MediaMimeType;
    data: Buffer;
  }): Promise<void>;
  persistTaskInputReferences(input: {
    taskId: string;
    expectedInputImageRefs: unknown;
    migratedInputImageRefs: MigratedVideoInputReference[];
  }): Promise<void>;
}

/** 可安全写入迁移日志的单任务结果。 */
export interface VideoInputMigrationResult {
  taskId: string;
  status: "verified" | "migrated";
  inputCount: number;
  copiedCount: number;
  verifiedCount: number;
}

/** 将未知值收窄为普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验数据库身份可安全进入对象前缀和非敏感错误消息。 */
function assertSafeIdentity(
  value: unknown,
  field: "任务" | "用户"
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new Error(`视频${field}标识无效`);
  }
}

/** 校验对象仅包含历史契约允许的字段，避免静默丢弃不可解释数据。 */
function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("输入引用包含未知字段");
  }
}

/** 收窄历史输入 MIME。 */
function parseMimeType(value: unknown): MediaMimeType {
  if (
    typeof value === "string" &&
    MEDIA_MIME_TYPES.some((mimeType) => mimeType === value)
  ) {
    return value as MediaMimeType;
  }
  throw new Error("输入引用 MIME 无效");
}

/** 收窄历史输入声明字节数。 */
function parseByteLength(value: unknown): number {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_MEDIA_INPUT_BYTES
  ) {
    return value;
  }
  throw new Error("输入引用字节数无效");
}

/** 校验相对对象 key，阻断绝对路径、空段和目录穿越。 */
function parseStorageKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("输入对象 key 无效");
  const storageKey = value.trim();
  if (
    storageKey.length === 0 ||
    storageKey.length > MAX_STORAGE_KEY_LENGTH ||
    storageKey.startsWith("/") ||
    storageKey.split("/").some((segment) => !segment || segment === "..")
  ) {
    throw new Error("输入对象 key 无效");
  }
  return storageKey;
}

/** 校验显式或运行时 bucket 文本。 */
function parseStorageBucket(value: unknown): string {
  if (typeof value !== "string") throw new Error("输入对象 bucket 无效");
  const bucket = value.trim();
  if (
    bucket.length === 0 ||
    bucket.length > MAX_BUCKET_LENGTH ||
    bucket.includes("/") ||
    bucket.includes("\\") ||
    bucket.includes("..")
  ) {
    throw new Error("输入对象 bucket 无效");
  }
  return bucket;
}

/** 校验旧 remote 引用的基础 URL 边界；DNS pin 由脚本 I/O 层执行。 */
function parseRemoteUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_REMOTE_URL_LENGTH) {
    throw new Error("远程输入 URL 无效");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("远程输入 URL 无效");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("远程输入 URL 无效");
  }
  return url.toString();
}

/** 严格解析单个历史 storage/remote 引用。 */
function parseLegacyReference(value: unknown): LegacyVideoInputReference {
  if (!isRecord(value)) throw new Error("输入引用格式无效");
  const source = value.source;
  if (source === "storage") {
    assertExactKeys(value, [
      "source",
      "mimeType",
      "storageKey",
      "storageBucket",
      "byteLength",
    ]);
    return {
      source,
      mimeType: parseMimeType(value.mimeType),
      storageKey: parseStorageKey(value.storageKey),
      ...(value.storageBucket === undefined
        ? {}
        : { storageBucket: parseStorageBucket(value.storageBucket) }),
      byteLength: parseByteLength(value.byteLength),
    };
  }
  if (source === "remote") {
    assertExactKeys(value, ["source", "mimeType", "url", "byteLength"]);
    return {
      source,
      mimeType: parseMimeType(value.mimeType),
      url: parseRemoteUrl(value.url),
      byteLength: parseByteLength(value.byteLength),
    };
  }
  throw new Error("输入引用来源无效");
}

/** 严格解析整行旧输入数组并执行基础设施总量限制。 */
function parseLegacyReferences(value: unknown): LegacyVideoInputReference[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MEDIA_INPUT_COUNT
  ) {
    throw new Error("视频任务旧输入数组无效");
  }
  const references = value.map(parseLegacyReference);
  const totalBytes = references.reduce(
    (total, reference) => total + reference.byteLength,
    0
  );
  if (totalBytes > MAX_MEDIA_INPUT_BYTES) {
    throw new Error("视频任务旧输入总字节数超限");
  }
  return references;
}

/** 根据图片魔数识别实际 MIME。 */
function detectMediaMimeType(bytes: Buffer): MediaMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** 验证读取或已存在目标对象与数据库声明完全一致。 */
function assertLoadedBytes(
  bytes: Buffer,
  reference: Pick<LegacyVideoInputReference, "byteLength" | "mimeType">
): void {
  if (bytes.byteLength !== reference.byteLength) {
    throw new Error("输入对象实际字节数与声明不一致");
  }
  if (detectMediaMimeType(bytes) !== reference.mimeType) {
    throw new Error("输入对象实际 MIME 与声明不一致");
  }
}

/** 返回 MIME 对应的稳定安全扩展名。 */
function getMediaExtension(mimeType: MediaMimeType): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

/** 判断对象是否已属于当前任务并满足 lifecycle 解析所需的两段结构。 */
function isTaskOwnedStorageKey(input: {
  storageKey: string;
  taskPrefix: string;
}): boolean {
  if (!input.storageKey.startsWith(input.taskPrefix)) return false;
  const parts = input.storageKey.slice(input.taskPrefix.length).split("/");
  return parts.length === 2 && parts.every(Boolean);
}

/** 比较旧引用是否已经是无需数据库改写的完整归一引用。 */
function isSamePersistedReference(
  source: LegacyVideoInputReference,
  migrated: MigratedVideoInputReference
): boolean {
  return (
    source.source === "storage" &&
    source.mimeType === migrated.mimeType &&
    source.storageKey === migrated.storageKey &&
    source.storageBucket === migrated.storageBucket &&
    source.byteLength === migrated.byteLength
  );
}

/** 用不含存储身份的上下文包装单项 I/O 错误。 */
function createSafeInputError(
  taskId: string,
  inputIndex: number,
  operation: string,
  cause: unknown
): Error {
  return new Error(
    `视频任务 ${taskId} 的第 ${inputIndex + 1} 个输入${operation}失败`,
    { cause }
  );
}

/**
 * 收编单个视频任务的历史输入资产。
 *
 * @param task - 数据库旧列快照；输入引用视为不可信 JSON。
 * @param dependencies - 当前 bucket、存储/远程读取、确定性写入和 CAS 持久化依赖。
 * @returns 仅包含任务 ID、状态和计数的安全结果。
 * @sideEffects 可能读取源/目标、写入任务前缀，并在全部对象就绪后一次持久化引用。
 * @throws 任一校验、读取、写入或 CAS 失败时抛出不含 bucket/key/URL 的错误；从不删源。
 */
export async function migrateVideoInputTask(
  task: VideoInputMigrationTask,
  dependencies: VideoInputMigrationDependencies
): Promise<VideoInputMigrationResult> {
  assertSafeIdentity(task.id, "任务");
  assertSafeIdentity(task.userId, "用户");
  const currentBucket = parseStorageBucket(dependencies.currentBucket);
  let references: LegacyVideoInputReference[];
  try {
    references = parseLegacyReferences(task.inputImageRefs);
  } catch (error) {
    throw new Error(`视频任务 ${task.id} 的旧输入格式校验失败`, {
      cause: error,
    });
  }
  const taskPrefix = `${task.userId}/video-inputs/${task.id}/`;
  const migratedReferences: MigratedVideoInputReference[] = [];
  let copiedCount = 0;
  let verifiedCount = 0;

  for (const [inputIndex, reference] of references.entries()) {
    if (reference.source === "storage") {
      const sourceBucket = reference.storageBucket ?? currentBucket;
      if (
        sourceBucket !== currentBucket ||
        !reference.storageKey.startsWith(`${task.userId}/`)
      ) {
        throw createSafeInputError(
          task.id,
          inputIndex,
          "归属校验",
          new Error("source ownership mismatch")
        );
      }
      if (
        isTaskOwnedStorageKey({
          storageKey: reference.storageKey,
          taskPrefix,
        })
      ) {
        try {
          const bytes = await dependencies.readStorage({
            storageKey: reference.storageKey,
            storageBucket: currentBucket,
            maxBytes: reference.byteLength,
          });
          assertLoadedBytes(bytes, reference);
        } catch (error) {
          throw createSafeInputError(task.id, inputIndex, "验证", error);
        }
        migratedReferences.push({
          source: "storage",
          mimeType: reference.mimeType,
          storageKey: reference.storageKey,
          storageBucket: currentBucket,
          byteLength: reference.byteLength,
        });
        verifiedCount += 1;
        continue;
      }
    }

    let sourceBytes: Buffer;
    try {
      sourceBytes =
        reference.source === "storage"
          ? await dependencies.readStorage({
              storageKey: reference.storageKey,
              storageBucket: reference.storageBucket ?? currentBucket,
              maxBytes: reference.byteLength,
            })
          : await dependencies.readRemote({
              url: reference.url,
              mimeType: reference.mimeType,
              maxBytes: reference.byteLength,
            });
      assertLoadedBytes(sourceBytes, reference);
    } catch (error) {
      throw createSafeInputError(task.id, inputIndex, "读取", error);
    }

    const digest = createHash("sha256").update(sourceBytes).digest("hex");
    const storageKey = `${taskPrefix}${MIGRATION_ATTEMPT_ID}/input-${inputIndex}-${digest.slice(0, 32)}.${getMediaExtension(reference.mimeType)}`;
    try {
      const existing = await dependencies.readStorageIfExists({
        storageKey,
        storageBucket: currentBucket,
        maxBytes: reference.byteLength,
      });
      if (existing) {
        assertLoadedBytes(existing, reference);
        if (createHash("sha256").update(existing).digest("hex") !== digest) {
          throw new Error("deterministic target digest mismatch");
        }
        verifiedCount += 1;
      } else {
        await dependencies.putStorage({
          storageKey,
          storageBucket: currentBucket,
          mimeType: reference.mimeType,
          data: sourceBytes,
        });
        copiedCount += 1;
      }
    } catch (error) {
      throw createSafeInputError(task.id, inputIndex, "写入", error);
    }
    migratedReferences.push({
      source: "storage",
      mimeType: reference.mimeType,
      storageKey,
      storageBucket: currentBucket,
      byteLength: reference.byteLength,
    });
  }

  const referencesChanged = references.some(
    (reference, index) =>
      !isSamePersistedReference(
        reference,
        migratedReferences[index] as MigratedVideoInputReference
      )
  );
  if (referencesChanged) {
    try {
      await dependencies.persistTaskInputReferences({
        taskId: task.id,
        expectedInputImageRefs: task.inputImageRefs,
        migratedInputImageRefs: migratedReferences,
      });
    } catch (error) {
      throw new Error(`视频任务 ${task.id} 的输入引用持久化失败`, {
        cause: error,
      });
    }
  }

  return {
    taskId: task.id,
    status: referencesChanged ? "migrated" : "verified",
    inputCount: references.length,
    copiedCount,
    verifiedCount,
  };
}
