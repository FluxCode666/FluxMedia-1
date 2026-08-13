/**
 * 图库详情返回的 sessionStorage 恢复快照。
 *
 * 使用方：图库客户端在进入详情前保存短期浏览元数据，并在浏览器返回时校验后
 * 有界重放 cursor。快照不保存卡片 DTO、存储坐标或签名资源地址。
 */

import { z } from "zod";

export const GALLERY_RECOVERY_VERSION = 1;
export const GALLERY_RECOVERY_TTL_MS = 30 * 60 * 1_000;
export const GALLERY_RECOVERY_MAX_REPLAY_BATCHES = 10;

const galleryRecoveryTabSchema = z.enum(["final", "uploads", "videos"]);
const galleryRecoveryCursorSchema = z.string().min(1).max(4096);

/** 可恢复的滚动锚点；anchor 缺失时调用方可退回 scrollY。 */
export const galleryRecoveryScrollSchema = z
  .object({
    anchorItemId: z.string().min(1).max(512).nullable(),
    anchorOffset: z.number().finite(),
    scrollY: z.number().finite().nonnegative(),
  })
  .strict();

/** 只包含有界元数据的版本化图库快照。 */
export const galleryRecoverySnapshotSchema = z
  .object({
    cursorChain: z
      .array(galleryRecoveryCursorSchema)
      .max(GALLERY_RECOVERY_MAX_REPLAY_BATCHES),
    filterFingerprint: z.string().min(1).max(512),
    nextCursor: galleryRecoveryCursorSchema.nullable(),
    principalFingerprint: z.string().min(1).max(512),
    savedAt: z.number().int().nonnegative(),
    scroll: galleryRecoveryScrollSchema,
    tab: galleryRecoveryTabSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();

export type GalleryRecoverySnapshot = z.infer<
  typeof galleryRecoverySnapshotSchema
>;
export type GalleryRecoverySnapshotInput = Omit<
  GalleryRecoverySnapshot,
  "version"
>;

/** 当前浏览作用域与时间，用于拒绝过期或跨主体快照。 */
export interface GalleryRecoveryContext {
  filterFingerprint: string;
  maxAgeMs?: number;
  now: number;
  principalFingerprint: string;
  tab: z.infer<typeof galleryRecoveryTabSchema>;
}

/** sessionStorage 所需的最小接口，便于 DB-free 单元测试和降级处理。 */
export interface GalleryRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type GalleryRecoveryInvalidReason =
  | "expired"
  | "filter-mismatch"
  | "malformed"
  | "missing"
  | "principal-mismatch"
  | "tab-mismatch"
  | "unavailable"
  | "version-mismatch";

/** 快照解析结果显式区分有效恢复和安全回退原因。 */
export type GalleryRecoveryResult =
  | { snapshot: GalleryRecoverySnapshot; status: "valid" }
  | { reason: GalleryRecoveryInvalidReason; status: "invalid" };

/** 创建固定当前版本的快照，超长 cursor 链或非法滚动值会立即失败。 */
export function createGalleryRecoverySnapshot(
  input: GalleryRecoverySnapshotInput
): GalleryRecoverySnapshot {
  return galleryRecoverySnapshotSchema.parse({
    ...input,
    version: GALLERY_RECOVERY_VERSION,
  });
}

/**
 * 解析并校验序列化快照。
 *
 * 失败不会抛出，调用方应按 invalid 回到首批并保留当前安全筛选。
 */
export function parseGalleryRecoverySnapshot(
  raw: string | null,
  context: GalleryRecoveryContext
): GalleryRecoveryResult {
  if (raw === null) {
    return { reason: "missing", status: "invalid" };
  }

  let serializedValue: unknown;
  try {
    serializedValue = JSON.parse(raw) as unknown;
  } catch {
    return { reason: "malformed", status: "invalid" };
  }
  const parsed = galleryRecoverySnapshotSchema.safeParse(serializedValue);
  if (!parsed.success) {
    return { reason: "malformed", status: "invalid" };
  }
  const snapshot = parsed.data;
  if (snapshot.version !== GALLERY_RECOVERY_VERSION) {
    return { reason: "version-mismatch", status: "invalid" };
  }
  const maxAgeMs = context.maxAgeMs ?? GALLERY_RECOVERY_TTL_MS;
  if (
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs < 0 ||
    snapshot.savedAt > context.now ||
    context.now - snapshot.savedAt > maxAgeMs
  ) {
    return { reason: "expired", status: "invalid" };
  }
  if (snapshot.principalFingerprint !== context.principalFingerprint) {
    return { reason: "principal-mismatch", status: "invalid" };
  }
  if (snapshot.filterFingerprint !== context.filterFingerprint) {
    return { reason: "filter-mismatch", status: "invalid" };
  }
  if (snapshot.tab !== context.tab) {
    return { reason: "tab-mismatch", status: "invalid" };
  }
  return { snapshot, status: "valid" };
}

/** 将已校验快照写入 sessionStorage；浏览器拒绝存储时返回 false。 */
export function saveGalleryRecoverySnapshot(
  storage: GalleryRecoveryStorage,
  key: string,
  snapshot: GalleryRecoverySnapshot
): boolean {
  try {
    const validatedSnapshot = galleryRecoverySnapshotSchema.parse(snapshot);
    storage.setItem(key, JSON.stringify(validatedSnapshot));
    return true;
  } catch {
    return false;
  }
}

/** 从 sessionStorage 读取并校验快照；存储访问异常降级为 unavailable。 */
export function readGalleryRecoverySnapshot(
  storage: GalleryRecoveryStorage,
  key: string,
  context: GalleryRecoveryContext
): GalleryRecoveryResult {
  try {
    return parseGalleryRecoverySnapshot(storage.getItem(key), context);
  } catch {
    return { reason: "unavailable", status: "invalid" };
  }
}
