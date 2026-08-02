/**
 * U7 视频历史输入资产收编内核。
 *
 * 职责：验证旧 storage/remote 引用，将非任务自有对象复制到确定性的任务前缀，并在
 * 全部对象就绪后一次性持久化旧输入列。模块只依赖注入的 I/O，可由迁移脚本和 DB-free
 * 测试复用；不会删除源对象，也不会在返回值或错误中暴露 bucket、key 或 URL。
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

const MAX_MEDIA_INPUT_COUNT = 256;
const MAX_MEDIA_INPUT_BYTES = 200 * 1024 * 1024;
const MAX_STORAGE_KEY_LENGTH = 1_024;
const MAX_BUCKET_LENGTH = 128;
const MAX_REMOTE_URL_LENGTH = 4_096;
const MIGRATION_ATTEMPT_ID = "migration-v1";
const ROLLBACK_SCHEMA_VERSION = 1;
const MAX_ROLLBACK_MANIFEST_PATH_LENGTH = 4_096;

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

/** append-only NDJSON 中允许持久化的唯一回滚记录。 */
export type VideoInputRollbackRecord = {
  schemaVersion: 1;
  bucket: string;
  key: string;
};

/** 迁移脚本严格支持的两种显式模式。 */
export type VideoInputMigrationCliOptions =
  | { mode: "migrate"; rollbackManifestPath: string }
  | { mode: "rollback"; rollbackManifestPath: string };

/** 迁移模式持有的 append-only 回滚清单句柄。 */
export interface VideoInputRollbackJournal {
  readonly existingRecordCount: number;
  readonly appendedRecordCount: number;
  record(record: VideoInputRollbackRecord): Promise<void>;
  close(): Promise<void>;
}

/** 回滚删除适配器只接受已验证的 bucket/key，不接触数据库或远程来源。 */
export interface VideoInputRollbackDependencies {
  deleteStorage(record: VideoInputRollbackRecord): Promise<void>;
}

/** 显式回滚模式仅返回非敏感计数。 */
export interface VideoInputRollbackResult {
  status: "rolled_back";
  manifestRecordCount: number;
  uniqueObjectCount: number;
  deleteAttemptCount: number;
}

/** 脚本从数据库读取的最小任务快照。 */
export interface VideoInputMigrationTask {
  id: string;
  userId: string;
  inputImageRefs: unknown;
  stagedInputObjects?: unknown;
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
  recordRollbackTarget(record: VideoInputRollbackRecord): Promise<void>;
  persistTaskInputReferences(input: {
    taskId: string;
    expectedInputImageRefs: unknown;
    expectedStagedInputObjects: unknown;
    migratedInputImageRefs: MigratedVideoInputReference[];
    clearStagedInputObjects: boolean;
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

/** 校验持久回滚清单使用绝对、规范且不含 NUL 的文件路径。 */
function parseRollbackManifestPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ROLLBACK_MANIFEST_PATH_LENGTH ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    normalize(value) !== value
  ) {
    throw new Error("回滚清单路径无效");
  }
  return value;
}

/**
 * 解析资产迁移 CLI 参数。
 *
 * @param argumentsList - `process.argv.slice(2)`；允许 pnpm 插入一个独立 `--`。
 * @returns 严格的迁移或回滚模式及绝对清单路径。
 * @sideEffects 无。
 * @throws 缺确认、相对路径、重复或额外参数时拒绝。
 */
export function parseVideoInputMigrationCliArguments(
  argumentsList: readonly string[]
): VideoInputMigrationCliOptions {
  const normalizedArguments = argumentsList.filter(
    (argument) => argument !== "--"
  );
  const [mode, confirmation, manifestFlag, manifestPath] = normalizedArguments;
  if (
    normalizedArguments.length !== 4 ||
    manifestFlag !== "--rollback-manifest" ||
    (mode !== "migrate" && mode !== "rollback") ||
    (mode === "migrate" && confirmation !== "--confirm-no-legacy-writers") ||
    (mode === "rollback" && confirmation !== "--confirm-database-restored")
  ) {
    throw new Error("视频输入资产迁移参数无效");
  }
  return {
    mode,
    rollbackManifestPath: parseRollbackManifestPath(manifestPath),
  };
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

/** 严格校验回滚对象只位于 user/video-inputs/task/migration-v1 前缀。 */
function parseRollbackObjectKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("回滚对象 key 无效");
  const storageKey = parseStorageKey(value);
  if (storageKey !== value) throw new Error("回滚对象 key 无效");
  const [userId, videoInputs, taskId, attemptId, fileName, ...extra] =
    storageKey.split("/");
  assertSafeIdentity(userId, "用户");
  assertSafeIdentity(taskId, "任务");
  if (
    videoInputs !== "video-inputs" ||
    attemptId !== MIGRATION_ATTEMPT_ID ||
    !fileName ||
    extra.length > 0 ||
    !/^input-\d+-[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(fileName)
  ) {
    throw new Error("回滚对象不属于视频输入迁移前缀");
  }
  return storageKey;
}

/** 严格解析单行回滚记录，拒绝未知字段和非 migration-v1 对象。 */
function parseRollbackRecord(value: unknown): VideoInputRollbackRecord {
  if (!isRecord(value)) throw new Error("回滚清单记录格式无效");
  assertExactKeys(value, ["schemaVersion", "bucket", "key"]);
  if (value.schemaVersion !== ROLLBACK_SCHEMA_VERSION) {
    throw new Error("回滚清单版本无效");
  }
  const bucket = parseStorageBucket(value.bucket);
  if (bucket !== value.bucket) throw new Error("回滚对象 bucket 无效");
  return {
    schemaVersion: ROLLBACK_SCHEMA_VERSION,
    bucket,
    key: parseRollbackObjectKey(value.key),
  };
}

/**
 * 解析完整 append-only NDJSON 回滚清单。
 *
 * @param content - 从 mode 0600 普通文件读取的完整 UTF-8 文本。
 * @returns 保留记录顺序的严格对象数组；空文件表示尚未创建目标。
 * @sideEffects 无。
 * @throws 空行、非法 JSON、未知字段、非法 bucket/key 或非 migration-v1 对象时拒绝。
 */
export function parseVideoInputRollbackManifest(
  content: string
): VideoInputRollbackRecord[] {
  if (content.length === 0) return [];
  const lines = content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.split("\n");
  return lines.map((line) => {
    if (!line) throw new Error("回滚清单包含空行");
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error("回滚清单包含非法 JSON");
    }
    return parseRollbackRecord(value);
  });
}

/** fsync 清单文件及父目录，确保持久文件和新建目录项先于对象写入落盘。 */
async function syncRollbackManifestPath(
  fileHandle: FileHandle,
  manifestPath: string
): Promise<void> {
  await fileHandle.sync();
  const directoryHandle = await open(dirname(manifestPath), constants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

/** 校验打开的清单是权限严格为 0600 的普通文件。 */
async function assertRollbackManifestFile(
  fileHandle: FileHandle
): Promise<void> {
  const metadata = await fileHandle.stat();
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("回滚清单文件类型或权限无效");
  }
}

/**
 * 打开或继续使用 append-only NDJSON 回滚清单。
 *
 * @param manifestPath - CLI 已提供的绝对规范路径；函数会再次验证并禁止符号链接。
 * @param currentBucket - 本轮迁移唯一允许的运行时 bucket。
 * @returns mode 0600 句柄；每次 record 都完成 append 和 fsync 后才返回。
 * @sideEffects 创建或追加清单文件，并 fsync 文件与父目录；不写对象存储。
 * @throws 路径、权限、已有清单内容或 fsync 失败时拒绝。
 */
export async function openVideoInputRollbackJournal(
  manifestPath: string,
  currentBucket: string
): Promise<VideoInputRollbackJournal> {
  const safePath = parseRollbackManifestPath(manifestPath);
  const safeBucket = parseStorageBucket(currentBucket);
  let fileHandle: FileHandle | undefined;
  try {
    fileHandle = await open(
      safePath,
      constants.O_CREAT |
        constants.O_APPEND |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600
    );
    await assertRollbackManifestFile(fileHandle);
    await syncRollbackManifestPath(fileHandle, safePath);
    const existingRecords = parseVideoInputRollbackManifest(
      await fileHandle.readFile({ encoding: "utf8" })
    );
    if (existingRecords.some((record) => record.bucket !== safeBucket)) {
      throw new Error("回滚清单包含非当前存储 bucket 对象");
    }
    let appendedRecordCount = 0;
    const journalHandle = fileHandle;
    return {
      existingRecordCount: existingRecords.length,
      get appendedRecordCount() {
        return appendedRecordCount;
      },
      async record(record) {
        const [validated] = parseVideoInputRollbackManifest(
          `${JSON.stringify(record)}\n`
        );
        if (!validated || validated.bucket !== safeBucket) {
          throw new Error("回滚记录不属于当前存储 bucket");
        }
        await journalHandle.appendFile(
          `${JSON.stringify(validated)}\n`,
          "utf8"
        );
        await journalHandle.sync();
        appendedRecordCount += 1;
      },
      async close() {
        await journalHandle.close();
      },
    };
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    throw new Error("回滚清单初始化失败", { cause: error });
  }
}

/**
 * 以只读、禁止符号链接方式加载回滚清单。
 *
 * @param manifestPath - 回滚模式显式提供的绝对规范路径。
 * @param currentBucket - 恢复后当前运行时 bucket。
 * @returns 完整验证且保留追加顺序的回滚记录。
 * @sideEffects 只读取 mode 0600 普通文件，不修改清单或对象。
 * @throws 文件缺失、权限放宽、格式漂移或 bucket 不一致时拒绝。
 */
export async function readVideoInputRollbackJournal(
  manifestPath: string,
  currentBucket: string
): Promise<VideoInputRollbackRecord[]> {
  const safePath = parseRollbackManifestPath(manifestPath);
  const safeBucket = parseStorageBucket(currentBucket);
  let fileHandle: FileHandle | undefined;
  try {
    fileHandle = await open(
      safePath,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    await assertRollbackManifestFile(fileHandle);
    const records = parseVideoInputRollbackManifest(
      await fileHandle.readFile({ encoding: "utf8" })
    );
    if (records.some((record) => record.bucket !== safeBucket)) {
      throw new Error("回滚清单包含非当前存储 bucket 对象");
    }
    return records;
  } catch (error) {
    throw new Error("回滚清单读取失败", { cause: error });
  } finally {
    await fileHandle?.close().catch(() => undefined);
  }
}

/**
 * 逐个幂等删除清单声明的本轮迁移目标。
 *
 * @param records - 已从严格清单解析的对象；函数仍会逐项复验并按身份去重。
 * @param dependencies - 本地或 S3 provider 提供的幂等删除适配器。
 * @returns 不包含 bucket/key 的稳定计数。
 * @sideEffects 顺序调用 deleteStorage；不删除源对象、不修改数据库或清单。
 * @throws 任一记录非法或删除失败时停止，清单保留供再次重跑。
 */
export async function rollbackVideoInputAssets(
  records: readonly VideoInputRollbackRecord[],
  dependencies: VideoInputRollbackDependencies
): Promise<VideoInputRollbackResult> {
  const validatedRecords = records.map((record) => parseRollbackRecord(record));
  const uniqueRecords = [
    ...new Map(
      validatedRecords.map((record) => [
        `${record.bucket}\0${record.key}`,
        record,
      ])
    ).values(),
  ];
  let deleteAttemptCount = 0;
  for (const record of uniqueRecords) {
    await dependencies.deleteStorage(record);
    deleteAttemptCount += 1;
  }
  return {
    status: "rolled_back",
    manifestRecordCount: records.length,
    uniqueObjectCount: uniqueRecords.length,
    deleteAttemptCount,
  };
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

/**
 * 验证旧 staged 对象全部已被迁移清单采用，再允许数据库原子清空旧清理集合。
 */
function shouldClearStagedInputObjects(input: {
  task: VideoInputMigrationTask;
  currentBucket: string;
  migratedReferences: MigratedVideoInputReference[];
}): boolean {
  const staged = input.task.stagedInputObjects;
  if (staged === undefined || staged === null) return false;
  if (!Array.isArray(staged) || staged.length > MAX_MEDIA_INPUT_COUNT) {
    throw new Error("视频任务旧 staged 输入集合无效");
  }
  if (staged.length === 0) return false;
  const referencedObjects = new Set(
    input.migratedReferences.map(
      (reference) => `${reference.storageBucket}\0${reference.storageKey}`
    )
  );
  const allowedKeys = new Set([
    "reason",
    "userId",
    "videoId",
    "attemptId",
    "storageKey",
    "storageBucket",
  ]);
  for (const rawObject of staged) {
    if (
      !isRecord(rawObject) ||
      Object.keys(rawObject).some((key) => !allowedKeys.has(key)) ||
      (rawObject.reason !== undefined && rawObject.reason !== "orphan") ||
      rawObject.userId !== input.task.userId ||
      rawObject.videoId !== input.task.id ||
      typeof rawObject.attemptId !== "string" ||
      rawObject.attemptId.length === 0 ||
      rawObject.attemptId.length > 128 ||
      rawObject.attemptId.includes("/") ||
      rawObject.attemptId.includes("..") ||
      typeof rawObject.storageKey !== "string" ||
      typeof rawObject.storageBucket !== "string"
    ) {
      throw new Error("视频任务旧 staged 输入归属无效");
    }
    const prefix = `${input.task.userId}/video-inputs/${input.task.id}/${rawObject.attemptId}/`;
    const objectName = rawObject.storageKey.slice(prefix.length);
    if (
      rawObject.storageBucket !== input.currentBucket ||
      !rawObject.storageKey.startsWith(prefix) ||
      objectName.length === 0 ||
      objectName.includes("/") ||
      !referencedObjects.has(
        `${rawObject.storageBucket}\0${rawObject.storageKey}`
      )
    ) {
      throw new Error("视频任务旧 staged 输入未被任务清单采用");
    }
  }
  return true;
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
        await dependencies.recordRollbackTarget({
          schemaVersion: ROLLBACK_SCHEMA_VERSION,
          bucket: currentBucket,
          key: storageKey,
        });
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
  const clearStagedInputObjects = shouldClearStagedInputObjects({
    task,
    currentBucket,
    migratedReferences,
  });
  if (referencesChanged || clearStagedInputObjects) {
    try {
      await dependencies.persistTaskInputReferences({
        taskId: task.id,
        expectedInputImageRefs: task.inputImageRefs,
        expectedStagedInputObjects: task.stagedInputObjects ?? null,
        migratedInputImageRefs: migratedReferences,
        clearStagedInputObjects,
      });
    } catch (error) {
      throw new Error(`视频任务 ${task.id} 的输入引用持久化失败`, {
        cause: error,
      });
    }
  }

  return {
    taskId: task.id,
    status:
      referencesChanged || clearStagedInputObjects ? "migrated" : "verified",
    inputCount: references.length,
    copiedCount,
    verifiedCount,
  };
}
