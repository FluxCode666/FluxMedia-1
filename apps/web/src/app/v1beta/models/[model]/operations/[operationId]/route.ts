/** Gemini Operation 查询入口；复用统一任务真相。 */
import { corsPreflight, corsRoute } from "@/features/external-api/cors";
import { getGeminiVideoOperation } from "@/features/external-api/handlers/gemini-video";

export const GET = corsRoute(getGeminiVideoOperation);
export const OPTIONS = corsPreflight;
