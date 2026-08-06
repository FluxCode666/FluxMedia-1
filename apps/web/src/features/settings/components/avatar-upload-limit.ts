/**
 * 头像上传大小限制解析与边界判断。
 * 设置资料页使用该模块消费系统统一文件上限；纯函数设计便于在 DB-free 的 Web
 * 测试中验证边界。
 */

/**
 * 解析头像单文件上限。
 *
 * @param maxFileSizeBytes - 系统配置解析后的单文件字节上限。
 * @returns 有效的系统字节上限；非法值返回保守上限。
 * @sideEffects 无。
 */
export function resolveAvatarMaxFileSizeBytes(
  maxFileSizeBytes: number
): number {
  if (!Number.isFinite(maxFileSizeBytes) || maxFileSizeBytes <= 0) {
    return 5 * 1024 * 1024;
  }

  return Math.floor(maxFileSizeBytes);
}

/**
 * 判断头像文件大小是否位于系统允许范围内。
 *
 * @param fileSizeBytes - 浏览器 `File.size` 提供的文件字节数。
 * @param maxFileSizeBytes - 系统允许的单文件最大字节数。
 * @returns 文件大小合法且未超过上限时返回 `true`；恰好等于上限也允许。
 * @sideEffects 无。
 */
export function isAvatarFileSizeAllowed(
  fileSizeBytes: number,
  maxFileSizeBytes: number
): boolean {
  return (
    Number.isFinite(fileSizeBytes) &&
    fileSizeBytes >= 0 &&
    fileSizeBytes <= maxFileSizeBytes
  );
}
