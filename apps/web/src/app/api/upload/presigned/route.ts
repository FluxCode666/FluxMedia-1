/**
 * 登录用户的通用文件预签名上传路由。
 *
 * 鉴权与响应字段保持原契约；存储 provider、bucket 和 endpoint 来自同一份运行时
 * 设置快照，因此后台切换 local/S3、轮换密钥或修改 bucket 后无需重启服务。
 */

import { proxyExternalApi } from "@/features/external-api/go-proxy";

/**
 * 获取预签名上传 URL
 *
 * POST /api/upload/presigned
 * Body: { filename: string, contentType: string, fileSize: number }
 */
export const POST = proxyExternalApi;
