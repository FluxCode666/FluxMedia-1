/**
 * FluxMedia 视频创建的规范路由。
 *
 * /v1/videos 已下线；本地址保留现有请求与响应契约。
 */
import { corsPreflight, corsRoute } from "@/features/external-api/cors";
import { postExternalVideoGenerations } from "@/features/external-api/handlers/video-generations";

export const POST = corsRoute(postExternalVideoGenerations);
export const OPTIONS = corsPreflight;
