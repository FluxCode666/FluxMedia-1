import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restoreImage } from "./image-restoration.mjs";
import { calibrateImageResolution } from "./resolution-calibration.mjs";
import { generativeRepairImage } from "./generative-repair.mjs";
import { maskedOutpaintImage } from "./masked-outpaint.mjs";
import { superResolve } from "./super-resolution.mjs";
import { removeBackground } from "./matte.mjs";
import { parseImageSize } from "./resolution.mjs";

const modelDirectory = process.env.MEDIA_PROCESSING_MODELS_PATH || fileURLToPath(new URL("../../apps/web/models", import.meta.url));
for (const [key, name] of Object.entries({ SCUNET_MODEL_PATH: "scunet-color-real-gan.onnx", REALESR_MODEL_PATH: "realesr-general-x4v3.onnx", ISNET_MODEL_PATH: "isnet.onnx" })) {
  process.env[key] ||= resolve(modelDirectory, name);
}
const defaultRepairPrompt = "Redraw this entire image to restore and sharpen it: fix blurry or garbled text and fine details, keep the exact same composition, layout, colors and content unchanged. Do not add, remove, move or reinterpret anything.";
function outpaintPrompt(pos) {
  const horizontal = pos.cols <= 1 ? "" : pos.col === 0 ? "left" : pos.col === pos.cols - 1 ? "right" : "center";
  const vertical = pos.rows <= 1 ? "" : pos.row === 0 ? "top" : pos.row === pos.rows - 1 ? "bottom" : "middle";
  const region = [vertical, horizontal].filter(Boolean).join("-") || "whole";
  if (pos.col === 0 && pos.row === 0) return `This picture is the ${region} region of a larger complete image. Restore and sharpen only this ${region} region — fix blurry or garbled text and fine details, keep the same content. Render only what belongs in this ${region} region at its true scale; do NOT zoom out or squeeze the whole scene into this frame.`;
  const edges = pos.col > 0 && pos.row > 0 ? "left and top" : pos.col > 0 ? "left" : "top";
  return `This tile is the ${region} region of a larger image. The non-black pixels along the ${edges} edge(s) are the already-rendered neighbouring region. Using those surroundings as context, extend the scene into the black area — fill in only the ${region} direction so it continues seamlessly from the ${edges} edge(s), matching style, lighting, colours and perspective. Render only this ${region} region at its true scale; do NOT zoom out or draw the whole scene, and change nothing outside the black area.`;
}
const defaultOperations = { restoreImage, calibrateImageResolution, generativeRepairImage, maskedOutpaintImage, superResolve, removeBackground };

// The caller is Go and supplies already-authorized switches and image bytes.
// This process performs no database access, provider requests, or billing.
export async function processImage(input, edit, operations = defaultOperations) {
  let image = Buffer.from(input.imageBase64, "base64");
  if (!image.length) throw new Error("Image bytes are required");
  if (input.final === false) return input.transparentMatte === true ? operations.removeBackground(image) : image;
  if (input.restore === true) image = (await operations.restoreImage(image)).buffer;
  const target = parseImageSize(input.requestedSize || "1024x1024");
  let repaired = false;
  if (target && ["whole", "mask"].includes(input.repair)) {
    const previous = image;
    try {
      if (input.repair === "mask") {
        const result = await operations.maskedOutpaintImage(image, Math.max(target.width, target.height), async (tile, mask, pos, width, height, index) => edit({ imageBase64: tile.toString("base64"), maskBase64: mask.toString("base64"), prompt: outpaintPrompt(pos), width, height, index }), operations.superResolve);
        image = result.buffer;
        repaired = result.tilesRepaired > 0;
      } else {
        const result = await operations.generativeRepairImage(image, Math.max(target.width, target.height), async (whole, width, height) => edit({ imageBase64: whole.toString("base64"), prompt: input.repairPrompt?.trim() || defaultRepairPrompt, width, height, index: 0 }), operations.superResolve);
        image = result.buffer;
        repaired = result.repaired;
      }
    } catch { image = previous; }
  }
  if (!repaired && input.superResolution === true) image = (await operations.calibrateImageResolution(image, input.requestedSize || "1024x1024")).buffer;
  // Matting is last so RGB restoration and paid redraws cannot erase the requested transparency.
  if (input.transparentMatte === true) image = await operations.removeBackground(image);
  return image;
}
