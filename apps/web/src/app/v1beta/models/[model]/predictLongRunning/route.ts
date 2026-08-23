/** Gemini predictLongRunning 的内部可识别路由；公开地址由 proxy 保持冒号格式。 */
import { corsPreflight, corsRoute } from "@/features/external-api/cors";
import { postGeminiVideoGeneration } from "@/features/external-api/handlers/gemini-video";

export const POST = corsRoute(postGeminiVideoGeneration);
export const OPTIONS = corsPreflight;
