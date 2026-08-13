/** 带 /api 前缀的 OpenAI 风格视频创建等价路由。 */
import { corsPreflight, corsRoute } from "@/features/external-api/cors";
import { postExternalVideoGenerations } from "@/features/external-api/handlers/video-generations";

export const POST = corsRoute(postExternalVideoGenerations);
export const OPTIONS = corsPreflight;
