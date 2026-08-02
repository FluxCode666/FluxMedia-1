/** 兼容 `/api/v1` 前缀的视频能力发现路由。 */
import { corsPreflight, corsRoute } from "@/features/external-api/cors";
import { getExternalVideoCapabilities } from "@/features/external-api/handlers/video-capabilities";

export const GET = corsRoute(getExternalVideoCapabilities);
export const OPTIONS = corsPreflight;
