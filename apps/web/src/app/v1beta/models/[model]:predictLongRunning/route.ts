/** Gemini predictLongRunning 兼容入口；只委托薄 handler。 */
import { corsPreflight, corsRoute } from "@/features/external-api/cors";
import { postGeminiVideoGeneration } from "@/features/external-api/handlers/gemini-video";

export const POST = corsRoute(postGeminiVideoGeneration);
export const OPTIONS = corsPreflight;
