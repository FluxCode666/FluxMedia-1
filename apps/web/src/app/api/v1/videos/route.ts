/** 带 /api 前缀的已下线视频创建地址；不得回退到 generations。 */
import { corsPreflight, corsRoute } from "@/features/external-api/cors";
import { postDeprecatedVideoGenerations } from "@/features/external-api/handlers/video-deprecated";

export const POST = corsRoute(postDeprecatedVideoGenerations);
export const OPTIONS = corsPreflight;
