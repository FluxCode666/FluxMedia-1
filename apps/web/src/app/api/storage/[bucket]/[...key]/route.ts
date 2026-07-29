/**
 * 存储对象读取 API 路由
 *
 * 提供本地/S3 存储桶中图像的 HTTP 读取。
 * - 头像、模型封面与网站资产可共用一个私有系统资产 bucket，由 key 命名空间分流。
 * - avatars 域：公开访问，无需鉴权。
 * - image/video 域：仅严格内容寻址 WebP 允许匿名读取，禁止缩略图转换。
 * - logo 域：仅严格内容寻址 PNG、SVG、ICO Logo 允许匿名读取，禁止缩略图转换。
 * - `_avatars` 是稳定逻辑别名，请求时映射到最新运行时头像 bucket。
 * - generations 桶：需要有效的短时签名 URL（sig + exp 查询参数）。
 *   签名验证使用 HMAC-SHA256 + 常量时间比较，防止时序攻击。
 *   v1 API 消费者通过签名 URL 参数获取授权（无 cookie）。
 * - 桶名与写入管线统一读取运行时系统设置，支持后台配置自定义 MinIO 桶。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@repo/database";
import { generation } from "@repo/database/schema";
import { getCurrentUser } from "@repo/shared/auth/server";
import { logError } from "@repo/shared/logger";
import { PUBLIC_AVATAR_BUCKET_ALIAS } from "@repo/shared/storage/image-url";
import { getStorageProvider } from "@repo/shared/storage/providers";
import { verifySignedImageUrl } from "@repo/shared/storage/signed-url";
import { getRuntimeSettingString } from "@repo/shared/system-settings";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import {
  assertModelMarketplaceCoverReference,
  parseModelMarketplaceAssetBucketName,
} from "@/features/model-marketplace/asset-reference";
import {
  assertSiteLogoAssetReference,
  parseSiteAssetsBucketName,
} from "@/features/site-branding/asset-reference";

type StorageBucketConfig = {
  avatars: string;
  generations: string;
  modelMarketplaceAssets: string;
  siteAssets: string;
};

type StorageObjectDomain =
  | "avatars"
  | "generations"
  | "modelMarketplaceAssets"
  | "siteAssets";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  // 视频产物(Adobe Firefly 视频 re-host 为 .mp4):缺这条会被当 octet-stream,
  // 浏览器 <video> 拒播(图库视频 tab、创作页视频面板都经 /api/storage 取)。
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

const GENERATION_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800, immutable";
const PUBLIC_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const NO_STORE_CACHE_CONTROL = "no-store";
const DEFAULT_AVATARS_BUCKET = "avatars";
const DEFAULT_GENERATIONS_BUCKET = "generations";

/** 四项运行时 bucket 缺失、为空或生成内容与公开资产重叠时的稳定错误。 */
class StorageBucketConfigurationError extends Error {
  /** 创建不包含原始设置值的配置错误。 */
  constructor() {
    super("Storage bucket configuration invalid");
    this.name = "StorageBucketConfigurationError";
  }
}

/**
 * 解析允许使用历史默认值的头像或生成内容 bucket。
 *
 * @param value - 运行时设置值；undefined 代表历史环境尚无对应设置行。
 * @param fallback - 仅设置缺失时使用的项目兼容默认值。
 * @returns 去除首尾空白后的非空 bucket。
 * @throws StorageBucketConfigurationError - 已存在设置为空白时 fail-closed。
 */
function parseProtectedBucketName(
  value: string | undefined,
  fallback: string
): string {
  const bucket = value === undefined ? fallback : value.trim();
  if (!bucket) throw new StorageBucketConfigurationError();
  return bucket;
}

/**
 * 读取当前允许访问的存储桶配置。
 *
 * WHY：图像写入管线通过运行时系统设置选择 Bucket。读取路由若只使用构建期
 * `NEXT_PUBLIC_*` 环境变量，预构建镜像会把默认桶固化进白名单，导致图片已写入
 * 自定义 MinIO 桶、读取时却在触达 MinIO 前返回 `Bucket not allowed`。
 *
 * @returns 四项非空 bucket；三个公开资产域允许同名，生成内容必须独立。
 * @throws 设置读取失败、任一 bucket 非法或生成内容与公开资产重叠时显式失败。
 */
async function getStorageBucketConfig(): Promise<StorageBucketConfig> {
  const [avatarsRaw, generationsRaw, modelMarketplaceAssetsRaw, siteAssetsRaw] =
    await Promise.all([
      getRuntimeSettingString("NEXT_PUBLIC_AVATARS_BUCKET_NAME"),
      getRuntimeSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME"),
      getRuntimeSettingString("MODEL_MARKETPLACE_ASSETS_BUCKET_NAME"),
      getRuntimeSettingString("SITE_ASSETS_BUCKET_NAME"),
    ]);
  const avatars = parseProtectedBucketName(avatarsRaw, DEFAULT_AVATARS_BUCKET);
  const generations = parseProtectedBucketName(
    generationsRaw,
    DEFAULT_GENERATIONS_BUCKET
  );
  let modelMarketplaceAssets: string;
  let siteAssets: string;
  try {
    modelMarketplaceAssets = parseModelMarketplaceAssetBucketName(
      modelMarketplaceAssetsRaw
    );
    siteAssets = parseSiteAssetsBucketName(siteAssetsRaw);
  } catch {
    throw new StorageBucketConfigurationError();
  }
  if (
    generations === avatars ||
    generations === modelMarketplaceAssets ||
    generations === siteAssets
  ) {
    throw new StorageBucketConfigurationError();
  }
  return { avatars, generations, modelMarketplaceAssets, siteAssets };
}

/**
 * 按 bucket 与 key 命名空间解析唯一对象安全域。
 *
 * WHY：头像、模型封面与网站 Logo 可以共用同一 bucket，不能再仅凭 bucket 依次执行
 * 多个校验器。优先识别严格的 image/video 与 logo 命名空间；共桶头像只接受
 * `avatars/` 或严格历史文件名，避免把同 bucket 的未知对象误当头像匿名公开。
 *
 * @param bucket - 请求路径中的 bucket。
 * @param keySegments - 已剥离缩略图宽度段的对象 key 分段。
 * @param config - 已验证生成内容隔离关系的运行时 bucket 配置。
 * @returns 唯一对象域；bucket 合法但公开 key 不属于已配置命名空间时返回 null。
 * @sideEffects 无。
 * @failure 不抛错；严格引用格式由对应域的后续校验器负责。
 */
function resolveStorageObjectDomain(
  bucket: string,
  keySegments: string[],
  config: StorageBucketConfig
): StorageObjectDomain | null {
  const namespace = keySegments[0];
  if (
    bucket === config.modelMarketplaceAssets &&
    (namespace === "image" || namespace === "video")
  ) {
    return "modelMarketplaceAssets";
  }
  if (bucket === config.siteAssets && namespace === "logo") {
    return "siteAssets";
  }
  if (bucket === config.avatars) {
    const sharesPublicAssetBucket =
      config.avatars === config.modelMarketplaceAssets ||
      config.avatars === config.siteAssets;
    const isNamespacedAvatar = namespace === "avatars";
    const isLegacyAvatar =
      keySegments.length === 1 &&
      /^[a-zA-Z0-9_-]+-\d+\.(?:jpe?g|png|gif|webp)$/.test(keySegments[0] ?? "");
    if (!sharesPublicAssetBucket || isNamespacedAvatar || isLegacyAvatar) {
      return "avatars";
    }
  }
  if (bucket === config.generations) return "generations";
  return null;
}

// ============================================
// 缩略图按需缩放（?w=<width>）
// ============================================
// 列表/网格里把全分辨率大图（平均 2.4MB、最大 14MB）当缩略图加载，会压满浏览器
// 内存与主线程解码，导致“点历史/图库后整体发卡”。这里在读取路由内用 sharp 按请求宽度
// 缩成小 webp，并按 (bucket,key,width) 进程内 LRU 缓存（与会变化的签名 sig/exp 无关），
// 首次缩放后命中即取缓存。仅缩小、不放大；缩放失败回退原图，不影响可用性。

// 仅对这些栅格图做缩放（gif 动图、svg 不处理，避免丢帧/安全问题）。
const THUMB_RESIZABLE_TYPES = new Set([".png", ".jpg", ".jpeg", ".webp"]);
// 限制宽度取值范围，约束缓存碎片与处理开销。
const THUMB_MIN_WIDTH = 16;
const THUMB_MAX_WIDTH = 1280;
// 进程内 LRU：按条数上限（每条数十~一两百 KB，整体内存有界）。
const THUMB_CACHE_MAX_ENTRIES = 1000;
const thumbCache = new Map<string, Buffer>();

function parseThumbWidth(raw: string | null): number | null {
  if (!raw) return null;
  const w = Number(raw);
  if (!Number.isInteger(w) || w < THUMB_MIN_WIDTH || w > THUMB_MAX_WIDTH) {
    return null;
  }
  return w;
}

function getCachedThumb(key: string): Buffer | undefined {
  const cached = thumbCache.get(key);
  if (cached) {
    // LRU：命中后移到末尾，最久未用的留在最前。
    thumbCache.delete(key);
    thumbCache.set(key, cached);
  }
  return cached;
}

function setCachedThumb(key: string, buf: Buffer): void {
  thumbCache.set(key, buf);
  if (thumbCache.size > THUMB_CACHE_MAX_ENTRIES) {
    const oldest = thumbCache.keys().next().value;
    if (oldest !== undefined) {
      thumbCache.delete(oldest);
    }
  }
}

// 限制 sharp 每次操作占用的 libvips 线程数,避免并发缩放时线程超额抢 CPU。
sharp.concurrency(2);

// 持久磁盘缩略图缓存:每张图每个宽度只缩一次,之后任意进程/任意签名都从磁盘秒回——
// 跳过"拉原图 + sharp 缩放",且不受进程重启影响(进程内 LRU 会随重启清空,磁盘不会)。
// 这是修复"图片加载 11–15s、点不了 Tab"的关键:绝大多数请求不再触发昂贵的缩放。
const THUMB_DISK_DIR =
  process.env.THUMB_CACHE_DIR || "/home/user1/gpt2image-thumb-cache";

function thumbDiskPath(bucket: string, fileKey: string, width: number): string {
  const h = createHash("sha256").update(`${bucket}/${fileKey}`).digest("hex");
  // 按前两位分桶,避免单目录文件过多。
  return path.join(THUMB_DISK_DIR, h.slice(0, 2), `${h}@w${width}.webp`);
}

// 并发信号量:限制同时进行的 sharp 缩放数。单张原图可达 14MB(解码后位图数百 MB),
// 一屏 20+ 张并发缩放会把内存/CPU 压爆,导致请求堆到 11–15s 甚至挂起,并拖垮整个服务
// (连导航请求都挤不进去 → 点不动)。超额请求在此排队,服务端始终保有响应余力。
const THUMB_MAX_CONCURRENCY = 4;
let thumbInflight = 0;
const thumbWaiters: Array<() => void> = [];
function acquireThumbSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (thumbInflight < THUMB_MAX_CONCURRENCY) {
      thumbInflight += 1;
      resolve();
    } else {
      thumbWaiters.push(resolve);
    }
  });
}
function releaseThumbSlot(): void {
  const next = thumbWaiters.shift();
  if (next) {
    next(); // 把名额直接交给排队者(thumbInflight 不变)
  } else {
    thumbInflight -= 1;
  }
}

async function readThumbFromDisk(
  diskPath: string
): Promise<Buffer | undefined> {
  try {
    return await readFile(diskPath);
  } catch {
    return undefined;
  }
}

async function writeThumbToDisk(diskPath: string, buf: Buffer): Promise<void> {
  try {
    await mkdir(path.dirname(diskPath), { recursive: true });
    // 原子写:先写临时文件再 rename,避免并发/中断写出半文件被读到。
    const tmp = `${diskPath}.${process.pid}-${buf.length}.tmp`;
    await writeFile(tmp, buf);
    await rename(tmp, diskPath);
  } catch {
    // 落盘失败不致命:本次仍返回内存里的缩略图,下次再尝试。
  }
}

/**
 * 判断错误是否由"调用方主动取消"引发（客户端切换页面/关闭标签页,导致
 * request.signal 触发,透传给 S3/fs 下载后中止)。这类不是故障,无需记日志,
 * 也不该回退去拉原图（同一个被取消的 signal 会让原图请求同样失败）。
 * - Node fs/promises 取消:name="AbortError"、code="ABORT_ERR"。
 * - AWS SDK v3 经 abortSignal 取消:name="AbortError"。
 */
function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return true;
  }
  return (error as { code?: unknown }).code === "ABORT_ERR";
}

/**
 * 判断存储对象是否"不存在"。
 *
 * 用于区分真正的 404（对象缺失/键非法）与底层基础设施故障（凭证缺失、
 * S3 不可达、配置缺失等），避免把所有异常一律吞成 404 掩盖真实故障。
 * - local provider：fs.readFile 缺文件抛 ENOENT。
 * - s3 provider：缺键抛 NoSuchKey / NotFound，或 HTTP 404，或 Body 为空时
 *   抛 "File not found"。
 */
function isObjectNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // Node 文件系统错误带 code 字段（如 ENOENT）。
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return true;
  }
  // AWS SDK 错误以 name 标识，缺键场景为 NoSuchKey / NotFound。
  if (error.name === "NoSuchKey" || error.name === "NotFound") {
    return true;
  }
  // AWS SDK 错误携带 HTTP 元数据，404 同样视为对象不存在。
  const statusCode = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata?.httpStatusCode;
  if (statusCode === 404) {
    return true;
  }
  // s3 provider 在 Body 为空时抛出的显式 "File not found" 文案。
  return error.message.startsWith("File not found");
}

/**
 * 验证 generations 桶的签名 URL。
 * 三个公开资产域跳过验证；generations 域需要有效的 sig + exp。
 *
 * @returns null 表示验证通过，否则返回错误 Response
 */
/**
 * 第一方登录态回退鉴权(非公开桶):签名 URL 校验未通过时,若请求带有效会话且
 * 当前用户拥有该图(按 storage_key 归属),允许访问。
 *
 * WHY:签名 URL 本是给「无 cookie 的 v1 API 消费方」设计的短时凭证(默认 1 小时)。
 * 浏览器同源请求本就自动带 session cookie,不该因签名过期而看不到自己的图——典型是
 * 创作页把带签名的图片 URL 存进 localStorage,旧会话重新打开时签名已过期。让浏览器走
 * 会话鉴权即可彻底解决,且不削弱签名有效期这一安全策略。
 * 仅在「签名校验未通过」时才走此回退(带一次会话校验+一次归属查库),正常签名流量
 * 校验通过即返回、不触达 DB,热路径不受影响。归属校验(storage_key 属于当前用户)
 * 杜绝越权(IDOR):他人即便拿到 key 也无法越权读取。
 */
async function isOwnerViaSession(fileKey: string): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) {
    return false;
  }
  const rows = await db
    .select({ userId: generation.userId })
    .from(generation)
    .where(eq(generation.storageKey, fileKey))
    .limit(1);
  return rows.length > 0 && rows[0]?.userId === user.id;
}

async function verifyBucketAccess(
  request: NextRequest,
  bucket: string,
  fileKey: string,
  domain: StorageObjectDomain
): Promise<NextResponse | null> {
  // 已完成严格 key 分流的公开域无需签名。
  if (domain !== "generations") {
    return null;
  }

  const sig = request.nextUrl.searchParams.get("sig");
  const expParam = request.nextUrl.searchParams.get("exp");

  // 先按签名 URL 校验,失败时记下对应的拒绝响应(denial)再回退会话鉴权,
  // 而非立刻返回——让带 cookie 的第一方浏览器即便签名过期也能读自己的图。
  let denial: NextResponse | null = null;

  if (!sig || !expParam) {
    denial = NextResponse.json(
      { error: "Missing signature" },
      { status: 403, headers: { "Cache-Control": NO_STORE_CACHE_CONTROL } }
    );
  } else {
    const exp = Number(expParam);
    if (!Number.isFinite(exp) || exp <= 0) {
      denial = NextResponse.json(
        { error: "Invalid expiry" },
        { status: 403, headers: { "Cache-Control": NO_STORE_CACHE_CONTROL } }
      );
    } else {
      const result = verifySignedImageUrl(bucket, fileKey, sig, exp);
      if (result === "expired") {
        denial = NextResponse.json(
          { error: "Signature expired" },
          { status: 403, headers: { "Cache-Control": NO_STORE_CACHE_CONTROL } }
        );
      } else if (result === "invalid") {
        denial = NextResponse.json(
          { error: "Invalid signature" },
          { status: 403, headers: { "Cache-Control": NO_STORE_CACHE_CONTROL } }
        );
      }
    }
  }

  // 签名校验通过
  if (!denial) {
    return null;
  }

  // 签名缺失/过期/无效:回退第一方会话归属鉴权(仅此路径触达 DB)。
  if (await isOwnerViaSession(fileKey)) {
    return null;
  }

  return denial;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bucket: string; key: string[] }> }
) {
  const { bucket, key } = await params;
  let bucketConfig: StorageBucketConfig;
  try {
    bucketConfig = await getStorageBucketConfig();
  } catch (error) {
    logError(error, { source: "storage-bucket-config" });
    return NextResponse.json(
      { error: "Storage bucket configuration invalid" },
      {
        status: 503,
        headers: { "Cache-Control": NO_STORE_CACHE_CONTROL },
      }
    );
  }
  // `_avatars` 不是合法 S3 bucket 名，因此可安全作为逻辑别名，避免 Next.js 构建期
  // 内联的历史 NEXT_PUBLIC bucket 让运行时共桶配置失效。
  const storageBucket =
    bucket === PUBLIC_AVATAR_BUCKET_ALIAS ? bucketConfig.avatars : bucket;
  // 缩略图宽度可经"路径段"传入:/api/storage/<bucket>/w<width>/<key>。这是为绕过
  // 线上 Cloudflare 忽略 query 的边缘缓存键(见 signed-url.buildStorageThumbnailUrl
  // 的 WHY):用查询参数 ?w= 会命中被缓存的整张原图。宽度段不参与签名,这里在验签前
  // 剥离,fileKey 仍是真实存储键;同时兼容旧的 ?w= 查询参数(老客户端缓存)。
  let keySegments = key;
  let pathWidth: string | null = null;
  const firstSegment = keySegments[0];
  if (firstSegment && /^w\d+$/.test(firstSegment) && keySegments.length > 1) {
    pathWidth = firstSegment.slice(1);
    keySegments = keySegments.slice(1);
  }
  const fileKey = keySegments.join("/");

  if (
    storageBucket !== bucketConfig.avatars &&
    storageBucket !== bucketConfig.generations &&
    storageBucket !== bucketConfig.modelMarketplaceAssets &&
    storageBucket !== bucketConfig.siteAssets
  ) {
    return NextResponse.json({ error: "Bucket not allowed" }, { status: 403 });
  }

  if (
    !fileKey ||
    fileKey.includes("..") ||
    fileKey.startsWith("/") ||
    fileKey.includes("\\")
  ) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const domain = resolveStorageObjectDomain(
    storageBucket,
    keySegments,
    bucketConfig
  );
  if (!domain) {
    return NextResponse.json(
      { error: "Invalid public asset key" },
      { status: 400, headers: { "Cache-Control": NO_STORE_CACHE_CONTROL } }
    );
  }
  const isModelMarketplaceAsset = domain === "modelMarketplaceAssets";
  const isSiteAsset = domain === "siteAssets";
  if (
    (isModelMarketplaceAsset || isSiteAsset) &&
    (request.nextUrl.searchParams.has("w") || pathWidth !== null)
  ) {
    return NextResponse.json(
      {
        error: isSiteAsset
          ? "Site logo thumbnails are not allowed"
          : "Model marketplace thumbnails are not allowed",
      },
      { status: 400, headers: { "Cache-Control": NO_STORE_CACHE_CONTROL } }
    );
  }

  if (isModelMarketplaceAsset) {
    const category = keySegments[0];
    if (category !== "image" && category !== "video") {
      return NextResponse.json(
        { error: "Invalid model marketplace asset key" },
        { status: 400, headers: { "Cache-Control": NO_STORE_CACHE_CONTROL } }
      );
    }
    try {
      assertModelMarketplaceCoverReference(
        category,
        { bucket: storageBucket, key: fileKey },
        bucketConfig.modelMarketplaceAssets
      );
    } catch {
      return NextResponse.json(
        { error: "Invalid model marketplace asset key" },
        { status: 400, headers: { "Cache-Control": NO_STORE_CACHE_CONTROL } }
      );
    }
  }

  if (isSiteAsset) {
    try {
      assertSiteLogoAssetReference(
        { bucket: storageBucket, key: fileKey },
        bucketConfig.siteAssets
      );
    } catch {
      return NextResponse.json(
        { error: "Invalid site logo asset key" },
        { status: 400, headers: { "Cache-Control": NO_STORE_CACHE_CONTROL } }
      );
    }
  }

  // 签名验证：generations 域需要有效签名（或第一方会话归属），三个公开资产域
  // 在完成唯一域解析及其严格 key 校验后匿名访问。
  const accessError = await verifyBucketAccess(
    request,
    storageBucket,
    fileKey,
    domain
  );
  if (accessError) {
    return accessError;
  }

  const ext = path.extname(fileKey).toLowerCase();
  const mappedContentType = CONTENT_TYPES[ext];
  const siteAssetContentType =
    ext === ".png"
      ? "image/png"
      : ext === ".svg"
        ? "image/svg+xml"
        : ext === ".ico"
          ? "image/x-icon"
          : null;
  const contentType = isModelMarketplaceAsset
    ? "image/webp"
    : isSiteAsset
      ? (siteAssetContentType ?? "application/octet-stream")
      : mappedContentType || "application/octet-stream";
  const cacheControl =
    domain === "generations"
      ? GENERATION_CACHE_CONTROL
      : PUBLIC_ASSET_CACHE_CONTROL;

  const thumbWidth = THUMB_RESIZABLE_TYPES.has(ext)
    ? parseThumbWidth(pathWidth ?? request.nextUrl.searchParams.get("w"))
    : null;

  // 缩略图请求:先查 进程内 → 磁盘 缓存(命中则连原图都不拉、不缩放,直接秒回);
  // 都未命中才 限并发 拉原图 + sharp 缩放 + 落盘。缩放失败回退到返回原图。
  if (thumbWidth) {
    const cacheKey = `${storageBucket}/${fileKey}@w${thumbWidth}`;
    const diskPath = thumbDiskPath(storageBucket, fileKey, thumbWidth);
    let thumb = getCachedThumb(cacheKey);
    if (!thumb) {
      thumb = await readThumbFromDisk(diskPath);
      if (thumb) {
        setCachedThumb(cacheKey, thumb);
      }
    }
    if (!thumb) {
      await acquireThumbSlot();
      try {
        // 拿到名额后,若调用方已切走(请求被取消),立即放弃:不做无用的拉取+缩放,
        // 把名额尽快让给仍在排队、用户真正想看的请求——这正是"切换页面打断加载"的
        // 服务端落点(finally 会释放名额)。
        if (request.signal.aborted) {
          return new NextResponse(null, { status: 499 });
        }
        // 排队期间可能已被别的请求缩好并落盘,先再查一次磁盘,避免重复缩放。
        thumb = await readThumbFromDisk(diskPath);
        if (!thumb) {
          const storage = await getStorageProvider();
          // 透传 signal:缩放前若客户端断开,拉原图会被中止,不再空跑。
          const original = await storage.getObject(fileKey, storageBucket, {
            signal: request.signal,
          });
          thumb = await sharp(original)
            .rotate()
            .resize({ width: thumbWidth, withoutEnlargement: true })
            .webp({ quality: 78 })
            .toBuffer();
          await writeThumbToDisk(diskPath, thumb);
        }
        setCachedThumb(cacheKey, thumb);
      } catch (error) {
        // 调用方取消(切换页面打断):非故障,直接结束,不记日志、不回退拉原图。
        if (isAbortError(error)) {
          return new NextResponse(null, { status: 499 });
        }
        if (isObjectNotFoundError(error)) {
          return NextResponse.json(
            { error: "File not found" },
            { status: 404 }
          );
        }
        // 缩放/读取失败不致命:记日志并回退到下方返回原图。
        logError(error, {
          source: "storage-thumb",
          bucket: storageBucket,
          key: fileKey,
          width: thumbWidth,
        });
        thumb = undefined;
      } finally {
        releaseThumbSlot();
      }
    }
    if (thumb) {
      return new NextResponse(new Uint8Array(thumb), {
        headers: {
          "Content-Type": "image/webp",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": cacheControl,
          "CDN-Cache-Control": cacheControl,
          "Cloudflare-CDN-Cache-Control": cacheControl,
          "Content-Length": String(thumb.length),
        },
      });
    }
  }

  // 非缩略图请求,或缩略图失败回退:拉原图返回。
  let data: Buffer;
  try {
    const storage = await getStorageProvider();
    data = await storage.getObject(fileKey, storageBucket, {
      signal: request.signal,
    });
  } catch (error) {
    // 调用方取消(切换页面打断):非故障,直接结束,不记日志。
    if (isAbortError(error)) {
      return new NextResponse(null, { status: 499 });
    }
    if (isObjectNotFoundError(error)) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    // 凭证/网络/配置等基础设施故障不可静默吞成 404：记日志并返回 502。
    logError(error, {
      source: "storage-read",
      bucket: storageBucket,
      key: fileKey,
    });
    return NextResponse.json(
      { error: "Storage backend error" },
      { status: 502 }
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    // 阻止浏览器对响应体做内容嗅探，避免把用户上传内容当作可执行类型解析。
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cacheControl,
    "CDN-Cache-Control": cacheControl,
    "Cloudflare-CDN-Cache-Control": cacheControl,
    "Content-Length": String(data.length),
  };
  // 非图片白名单扩展强制以附件下载，避免在同源下被当作 HTML/SVG 渲染（存储型 XSS）。
  if (!mappedContentType && !isSiteAsset) {
    headers["Content-Disposition"] = "attachment";
  }
  if (isSiteAsset && siteAssetContentType === "image/svg+xml") {
    headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
  }

  return new NextResponse(new Uint8Array(data), { headers });
}
