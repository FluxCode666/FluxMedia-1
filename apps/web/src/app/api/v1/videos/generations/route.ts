/**
 * 带 /api 前缀的旧视频创建地址迁移期兼容路由。
 *
 * @deprecated 调用方应迁移到 POST /api/v1/videos；具体下线版本发布前仍复用同一处理器，
 * 移除时必须同步删除无 /api 前缀的镜像路由和 API 文档兼容说明。
 */
import { corsPreflight, corsRoute } from "@/features/external-api/cors";
import { postExternalVideoGenerations } from "@/features/external-api/handlers/video-generations";

export const POST = corsRoute(postExternalVideoGenerations);
export const OPTIONS = corsPreflight;
