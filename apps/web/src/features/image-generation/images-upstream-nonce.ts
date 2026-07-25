/**
 * Images API 上游请求的不可见随机 nonce。
 *
 * 使用方：`service.ts` 在生图和改图请求即将发送时调用，避免错误按请求体缓存的
 * 上游重复返回旧图。nonce 只进入上游 prompt，不进入审核、持久化或用户展示。
 */
import { randomBytes } from "node:crypto";

// 每个零宽字符承载 2 bit；显式转义避免源码出现不可见字符。
const ZERO_WIDTH_CHARS = ["\u200b", "\u200c", "\u200d", "\u2060"];

/**
 * 生成每请求唯一的零宽 nonce。
 *
 * @returns 由零宽字符组成的随机字符串；不产生网络或持久化副作用。
 */
export function buildInvisibleNonce(): string {
  let nonce = "";
  for (const byte of randomBytes(8)) {
    nonce += ZERO_WIDTH_CHARS[byte & 0b11];
    nonce += ZERO_WIDTH_CHARS[(byte >> 2) & 0b11];
    nonce += ZERO_WIDTH_CHARS[(byte >> 4) & 0b11];
    nonce += ZERO_WIDTH_CHARS[(byte >> 6) & 0b11];
  }
  return nonce;
}

/**
 * 给发送到 Images API 的 prompt 追加不可见随机 nonce。
 *
 * @param prompt - 原始或已优化的提示词。
 * @returns 可见文本不变、字节内容每次不同的上游提示词。
 */
export function appendImagesUpstreamNonce(prompt: string): string {
  return `${prompt}${buildInvisibleNonce()}`;
}
