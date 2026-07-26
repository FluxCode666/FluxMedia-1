/**
 * 最近图片网格的轻量展示 URL 规则。
 *
 * 使用方是统一生图面板。该模块只改写展示地址，不改变点击后下载原图作为参考图的
 * 数据对象，避免缩略图被误用为模型输入。
 */

import { buildStorageThumbnailUrl } from "@repo/shared/storage/image-url";

const RECENT_IMAGE_THUMBNAIL_WIDTH = 320;

/**
 * 为最近图片网格生成轻量展示地址。
 *
 * @param imageUrl 服务端返回的站内签名原图或第三方图片地址。
 * @returns 站内图片的 320px 路径缩略图；第三方地址保持不变。
 * @sideEffects 无。
 * @failure 纯字符串改写不抛错，无法改写时安全回退原地址。
 */
export function getRecentImageDisplayUrl(imageUrl: string): string {
  return (
    buildStorageThumbnailUrl(imageUrl, RECENT_IMAGE_THUMBNAIL_WIDTH) ?? imageUrl
  );
}
