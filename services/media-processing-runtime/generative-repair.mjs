/**
 * 生成式修复（whole-image generative repair）。
 *
 * 职责：把整张图缩到 web 甜点分辨率（~1280 长边），一次性用 gpt-image-2 img2img 重绘修复
 *   （重点修文字/细节、保持构图与内容不变），再用 Real-ESRGAN 超分补足到目标尺寸。
 *
 * 为什么整图而非分块：早期用「2×2 切块 + 各块独立重绘 + 羽化融合」，但 gpt-image-2 是重绘、
 *   非像素级修补，相邻块在重叠区各画各的（尤其文字/编号），羽化一叠就变重影/双重文字。整图
 *   一次重绘从根上消除接缝；代价是修复细节封顶在 web 分辨率（~1280），再超分放大到目标。
 *
 * 设计（职责分离，便于单测）：尺寸计算是纯函数（repairDimensions/finalDimensions），单独单测；
 *   编排 generativeRepairImage 用 sharp 缩放，用注入的 repair 回调（gpt-image-2，计费在
 *   operations.ts）与注入的 superResolve（Real-ESRGAN）。任一步失败回退原图、不阻断出图。
 */
import sharp from "sharp";
// web 修复分辨率的较长边（web img2img 甜点，指定比例基本返回固定尺寸）。
export const REPAIR_LONG_EDGE = 1280;
// 尺寸取整步长（对齐 web/上游对 16 整除的偏好，避免细碎尺寸）。
const DIM_STEP = 16;
function roundToStep(v) {
    return Math.max(DIM_STEP, Math.round(v / DIM_STEP) * DIM_STEP);
}
/**
 * 纯函数：把源宽高缩/放到 web 修复分辨率（较长边 = REPAIR_LONG_EDGE，保持比例，取整到 16）。
 * 源比甜点小则放大到甜点、大则缩小到甜点；保持原始宽高比。
 */
export function repairDimensions(width, height) {
    if (width <= 0 || height <= 0) {
        return { rw: REPAIR_LONG_EDGE, rh: REPAIR_LONG_EDGE };
    }
    const scale = REPAIR_LONG_EDGE / Math.max(width, height);
    return { rw: roundToStep(width * scale), rh: roundToStep(height * scale) };
}
/**
 * 纯函数：把修复分辨率 (rw,rh) 等比放大到目标较长边，保持修复图比例。
 */
export function finalDimensions(rw, rh, targetLongEdge) {
    const scale = targetLongEdge / Math.max(rw, rh);
    return { fw: Math.round(rw * scale), fh: Math.round(rh * scale) };
}
/**
 * 编排：整图生成式修复。
 *
 * @param image 输入图片字节（上游原图）
 * @param targetLongEdge 期望最终较长边
 * @param repair 注入的整图重绘回调：输入缩好的整图 PNG + 宽高，返回重绘后的图片字节
 *   （实际由 operations.ts 用 gpt-image-2 img2img 实现，并负责计费一次）
 * @param superResolve 注入的 4 倍超分（Real-ESRGAN）；upscaleTo 据倍率决定用它或 Lanczos。
 * @returns { buffer, repaired }：修复+超分后的最终图；repaired=false 表示回退了原图
 *
 * 边界：无法解析尺寸或重绘失败时回退原图、repaired=false，由调用方据此决定是否走普通超分。
 */
export async function generativeRepairImage(image, targetLongEdge, repair, superResolve) {
    const meta = await sharp(image).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h)
        return { buffer: image, repaired: false };
    const { rw, rh } = repairDimensions(w, h);
    // 缩到 web 修复分辨率（保持比例，源本就近似该比例，fit:fill 形变极小）。
    const repairInput = await sharp(image)
        .resize(rw, rh, { fit: "fill" })
        .png()
        .toBuffer();
    let repaired;
    try {
        const out = await repair(repairInput, rw, rh);
        // web 返回尺寸可能不精确，缩回精确修复尺寸。
        repaired = await sharp(out).resize(rw, rh, { fit: "fill" }).png().toBuffer();
    }
    catch {
        return { buffer: image, repaired: false };
    }
    // 超分补足到目标（保持修复图比例）。
    const { fw, fh } = finalDimensions(rw, rh, targetLongEdge);
    const final = await upscaleTo(repaired, fw, fh, superResolve);
    return { buffer: final, repaired: true };
}
/**
 * 把图放大/缩放到精确 (w,h)。放大倍率 ≥1.5 用 Real-ESRGAN 4 倍超分（更干净）再缩到目标；
 * 否则直接 Lanczos 缩放（小倍率超分收益小、且省算力）。
 */
async function upscaleTo(image, w, h, superResolve) {
    const meta = await sharp(image).metadata();
    const srcLong = Math.max(meta.width ?? 1, meta.height ?? 1);
    const factor = Math.max(w, h) / srcLong;
    const base = factor >= 1.5 ? await superResolve(image) : image;
    return sharp(base).resize(w, h, { fit: "fill" }).png().toBuffer();
}
