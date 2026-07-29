/**
 * 存储 URL 工具函数
 *
 * 处理存储键名和外部 URL 的转换
 */

import { PUBLIC_AVATAR_BUCKET_ALIAS } from "./image-url";

// ============================================
// 头像 URL 工具
// ============================================

/**
 * 判断是否为外部 URL
 *
 * 外部 URL 包括:
 * - OAuth 提供的头像 (GitHub, Google 等)
 * - 其他完整 URL
 *
 * @param value - URL 或存储键名
 * @returns 是否为外部 URL
 */
export function isExternalUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.startsWith("http://") || value.startsWith("https://");
}

/**
 * 获取头像显示 URL
 *
 * 根据传入的值返回正确的 URL:
 * - 如果是外部 URL (http/https 开头)，直接返回
 * - 如果是存储键名，转换为本地存储读取 URL
 * - 如果为空，返回 undefined
 *
 * @param image - 用户的 image 字段值 (可能是 URL 或存储键名)
 * @returns 头像显示 URL 或 undefined
 *
 * @example
 * ```ts
 * // 外部 URL (OAuth 头像)
 * getAvatarUrl("https://avatars.githubusercontent.com/u/12345")
 * // => "https://avatars.githubusercontent.com/u/12345"
 *
 * // 存储键名
 * getAvatarUrl("user-abc123-1234567890.jpg")
 * // => "/api/storage/_avatars/user-abc123-1234567890.jpg"
 *
 * // 空值
 * getAvatarUrl(null) // => undefined
 * ```
 */
export function getAvatarUrl(
  image: string | null | undefined
): string | undefined {
  if (!image) {
    return undefined;
  }

  // 如果是外部 URL，直接返回
  if (isExternalUrl(image)) {
    return image;
  }

  // 使用稳定逻辑别名，由读取 Route 在请求时映射到最新运行时 bucket。这样后台合并
  // 系统公开资产后无需依赖 Next.js 构建期内联的旧 NEXT_PUBLIC 值。
  return `/api/storage/${PUBLIC_AVATAR_BUCKET_ALIAS}/${image}`;
}

/**
 * 生成唯一的头像文件名
 *
 * 格式: avatars/{userId}-{timestamp}.{extension}
 *
 * @param userId - 用户 ID
 * @param file - 上传的文件
 * @returns 唯一的文件键名
 */
export function generateAvatarKey(userId: string, file: File): string {
  const timestamp = Date.now();
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
  return `avatars/${userId}-${timestamp}.${extension}`;
}

// ============================================
// 归属与存储桶校验工具
// ============================================

/**
 * 判断文件键名是否归属于指定用户
 *
 * 归属判定锚定在 userId 边界上，而非旧实现的 key.includes(userId) 子串匹配。
 * WHY：子串匹配过弱——当一个 userId 恰为另一 userId 的子串，或目标 userId
 * 出现在 key 的任意位置时，旧校验会被绕过，构成潜在越权（IDOR）。本仓的
 * 新存储键命名为 `avatars/${userId}-${timestamp}.ext`（见 generateAvatarKey），
 * 同时兼容历史无 `avatars/` 命名空间的键。剥离至多一个固定命名空间后，只接受以
 * `${userId}/`、`${userId}-` 开头或与 `${userId}` 完全相等的键，杜绝子串混淆。
 *
 * @param key - 文件键名
 * @param userId - 当前用户 ID
 * @returns 键名是否归属该用户
 */
export function keyBelongsToUser(key: string, userId: string): boolean {
  if (!userId) {
    return false;
  }
  if (key.includes("\\") || key.includes("\0")) {
    return false;
  }
  const segments = key.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return false;
  }
  const userOwnedKey = key.startsWith("avatars/")
    ? key.slice("avatars/".length)
    : key;
  return (
    userOwnedKey === userId ||
    userOwnedKey.startsWith(`${userId}/`) ||
    userOwnedKey.startsWith(`${userId}-`)
  );
}

/**
 * 解析头像 bucket 并确保它不会与用户生成内容共用安全域。
 *
 * @param avatarsValue - 运行时头像 bucket；必须显式提供非空值。
 * @param generationsValue - 运行时生成内容 bucket；缺少设置行时兼容历史默认值。
 * @returns 去除首尾空白后的头像 bucket。
 * @sideEffects 无。
 * @failure 任一值为空、使用保留逻辑别名，或两个安全域同名时抛出稳定错误。
 */
export function parseAvatarStorageBucketName(
  avatarsValue: string | undefined,
  generationsValue: string | undefined
): string {
  const avatars = avatarsValue?.trim();
  const generations =
    generationsValue === undefined ? "generations" : generationsValue.trim();
  if (
    !avatars ||
    !generations ||
    avatars === PUBLIC_AVATAR_BUCKET_ALIAS ||
    generations === PUBLIC_AVATAR_BUCKET_ALIAS
  ) {
    throw new Error("存储桶配置无效");
  }
  if (avatars === generations) {
    throw new Error("生成内容存储桶必须与头像存储桶隔离");
  }
  return avatars;
}

/**
 * 判断存储桶是否在白名单内
 *
 * 安全措施：只允许访问预定义的存储桶，避免跨桶越权。
 *
 * @param bucket - 待校验的存储桶名称
 * @param allowedBuckets - 允许的存储桶列表
 * @returns 是否允许访问该存储桶
 */
export function isBucketAllowed(
  bucket: string,
  allowedBuckets: readonly string[]
): boolean {
  return allowedBuckets.includes(bucket);
}
