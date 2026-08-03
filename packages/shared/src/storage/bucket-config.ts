/**
 * 存储桶与生成产物对象键的统一纯配置契约。
 *
 * 使用方：运行时系统设置读取层、公开存储 Route、图片与视频生成管线。
 * 本模块不读取环境变量、数据库或对象存储，确保 DB-free 单测可覆盖安全不变量。
 */

import { PUBLIC_AVATAR_BUCKET_ALIAS } from "./image-url";

export const SYSTEM_ASSETS_BUCKET_SETTING_KEY =
  "SYSTEM_ASSETS_BUCKET_NAME" as const;
export const GENERATIONS_BUCKET_SETTING_KEY =
  "GENERATIONS_BUCKET_NAME" as const;
export const DEFAULT_SYSTEM_ASSETS_BUCKET_NAME = "system";
export const DEFAULT_GENERATIONS_BUCKET_NAME = "generations";

const STORAGE_BUCKET_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;

/** 系统公共资产桶与用户生成内容桶的运行时配置。 */
export type RuntimeStorageBucketConfig = {
  systemAssets: string;
  generations: string;
};

/** 存储桶设置缺失、非法或破坏公开/私有域隔离。 */
export class StorageBucketConfigError extends Error {
  /** 创建不包含原始配置值的稳定错误。 */
  constructor() {
    super("Storage bucket configuration invalid");
    this.name = "StorageBucketConfigError";
  }
}

/**
 * 解析一个可安全用作对象存储桶和 URL 路径段的名称。
 *
 * @param value - 运行时设置值；undefined 时使用明确默认值。
 * @param fallback - 仅设置缺失时采用的默认桶名。
 * @returns 去除首尾空白后的合法桶名。
 * @sideEffects 无。
 * @failure 空白、路径字符、点目录或保留逻辑别名会抛出稳定配置错误。
 */
function parseBucketName(value: string | undefined, fallback: string): string {
  const bucket = value === undefined ? fallback : value.trim();
  if (
    !STORAGE_BUCKET_PATTERN.test(bucket) ||
    bucket === "." ||
    bucket === ".." ||
    bucket === PUBLIC_AVATAR_BUCKET_ALIAS
  ) {
    throw new StorageBucketConfigError();
  }
  return bucket;
}

/**
 * 解析统一系统资产桶与统一生成内容桶，并强制公开/私有安全域隔离。
 *
 * @param systemAssetsValue - 系统公共资产桶设置。
 * @param generationsValue - 图片与视频共用的生成内容桶设置。
 * @returns 两个已验证且互不相同的桶名。
 * @sideEffects 无。
 * @failure 任一桶非法或两个安全域同名时抛出 StorageBucketConfigError。
 */
export function parseRuntimeStorageBucketConfig(
  systemAssetsValue: string | undefined,
  generationsValue: string | undefined
): RuntimeStorageBucketConfig {
  const systemAssets = parseBucketName(
    systemAssetsValue,
    DEFAULT_SYSTEM_ASSETS_BUCKET_NAME
  );
  const generations = parseBucketName(
    generationsValue,
    DEFAULT_GENERATIONS_BUCKET_NAME
  );
  if (systemAssets === generations) {
    throw new StorageBucketConfigError();
  }
  return { systemAssets, generations };
}

/**
 * 构造新图片产物的稳定用户命名空间键。
 *
 * @param userId - 已由鉴权边界提供的用户 ID。
 * @param fileName - 生成管线创建的随机文件名与扩展名。
 * @returns `<userId>/images/<fileName>`。
 * @sideEffects 无。
 * @failure 不抛错；调用方负责提供已验证的内部标识符。
 */
export function buildGeneratedImageStorageKey(
  userId: string,
  fileName: string
): string {
  return `${userId}/images/${fileName}`;
}

/**
 * 构造新视频产物的稳定用户命名空间键。
 *
 * @param userId - 已由鉴权边界提供的用户 ID。
 * @param videoId - 已持久化的视频任务 ID。
 * @returns `<userId>/videos/<videoId>.mp4`。
 * @sideEffects 无。
 * @failure 不抛错；调用方负责提供已验证的内部标识符。
 */
export function buildGeneratedVideoStorageKey(
  userId: string,
  videoId: string
): string {
  return `${userId}/videos/${videoId}.mp4`;
}
