/**
 * 透明背景回退:后端不支持 background=transparent 时,改为不透明生成 + 服务端 ISNet 抠图。
 *
 * 背景:实测 gpt-image-2 对 background=transparent 返回 400
 * "Transparent background is not supported for this model"。为让"透明背景"在不支持的后端
 * 也能用,管线在该错误时不透明重试,再用 matte.ts 把背景抠掉,得到透明结果。
 *
 * 使用方:image-generation/operations.ts 的 runGenerationAttempt。纯逻辑(抠图本身无 DB),
 * isTransparentUnsupportedError 可单测。
 */
import type { GenerateImageResult } from "./types";

/** 判断错误是否为"后端不支持透明背景"(用于触发回退)。 */
export function isTransparentUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /transparent background is not supported/i.test(message);
}

/** 去掉可能的 data URI 前缀,返回纯 base64。 */
function stripDataUri(base64: string): string {
  return base64.includes(",") ? (base64.split(",").pop() ?? base64) : base64;
}

/**
 * 对一段(可能带 data URI 前缀的)base64 图片抠图,返回抠图后 PNG 的纯 base64。
 * 懒加载 matte(onnxruntime 原生):只在透明回退真触发时才载入,避免拖垮核心管线启动。
 */
async function matteBase64(base64: string): Promise<string> {
  const { removeBackground } = await import("./matte");
  const input = Buffer.from(stripDataUri(base64), "base64");
  const out = await removeBackground(input);
  return out.toString("base64");
}

/**
 * 对生成结果里的各路图片做抠图,返回透明背景版本。
 * 仅处理带 base64 的产物(透明回退场景下后端返回的就是 base64);imageUrl-only 产物原样保留。
 */
export async function applyTransparentMatte(
  result: GenerateImageResult
): Promise<GenerateImageResult> {
  const next: GenerateImageResult = { ...result };
  if (next.imageBase64) {
    next.imageBase64 = await matteBase64(next.imageBase64);
  }
  if (next.imageOutputs) {
    next.imageOutputs = await Promise.all(
      next.imageOutputs.map(async (output) =>
        output.imageBase64
          ? { ...output, imageBase64: await matteBase64(output.imageBase64) }
          : output
      )
    );
  }
  return next;
}
