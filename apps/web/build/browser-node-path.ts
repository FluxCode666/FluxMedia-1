/**
 * 浏览器构建中的 node:path 替身。
 *
 * 使用方：vite.config.ts 的 alias。fumadocs-mdx 的内容集合运行时只用 path.join
 * 拼接内容文件的相对路径；浏览器没有 node:path，外置后的空模块会让调用直接抛错。
 */

/** POSIX 风格拼接路径段，并折叠 `.`、`..` 与重复分隔符。 */
export function join(...segments: string[]): string {
  const absolute = segments[0]?.startsWith("/") ?? false;
  const parts: string[] = [];
  for (const part of segments.join("/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else if (part !== ".." || !absolute) parts.push(part);
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

export default { join };
