/**
 * 视频状态产物 URL 构造。
 *
 * 职责：把视频持久 storage key 签名并绑定可信公开站点基址，供 UOL 状态 binding
 * 输出满足绝对 URL 契约的结果。本模块 DB-free，调用方负责提供运行时设置。
 */
import { buildPublicImageUrl } from "@repo/shared/storage/signed-url";

/**
 * 构造视频状态查询使用的绝对签名 URL。
 *
 * @param input 已持久化 storage key、bucket 与服务端公开站点基址。
 * @returns 外部 API、MCP 和站内客户端均可访问的绝对 URL。
 * @throws storage key 或公开站点基址缺失、URL 无法构造时显式失败。
 */
export function buildPublicVideoStatusUrl(input: {
  storageKey: string;
  bucket: string;
  publicBaseUrl?: string | null;
}): string {
  const storageKey = input.storageKey.trim();
  if (!storageKey) throw new Error("视频状态 URL 缺少 storage key");
  const publicBaseUrl = input.publicBaseUrl?.trim();
  if (!publicBaseUrl) throw new Error("视频状态 URL 缺少公开站点基址");
  const bucket = input.bucket.trim() || "generations";
  const result = buildPublicImageUrl(
    `/api/storage/${bucket}/${storageKey}`,
    publicBaseUrl
  );
  if (!result) throw new Error("视频状态 URL 构造失败");
  return result;
}
