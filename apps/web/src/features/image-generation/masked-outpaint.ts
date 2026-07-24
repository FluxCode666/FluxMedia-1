/**
 * 掩码顺序外绘（masked sequential outpainting）——无缝分块修复。
 *
 * 职责：把图在目标分辨率上切成 1K 重叠块，按光栅顺序逐块用 gpt-image-2 的「带 mask 编辑」自主外绘：
 *   每块把「待补区」填黑、只留与已完成邻块的重叠边（mask 锁死重叠边=保留、黑区=重绘），
 *   逼模型「从边缘往黑区外绘」而非在原内容上 img2img（后者对 mask 遵守弱、易整块重调色留缝）。
 *   不喂原图/参考——改「自主拓展」：按块的行列位置给模型位置提示词（「根据四周已渲染内容补出
 *   [左上/右上/…某方位]，只画这个方位、别把整幅画塞进来」）。曾试过喂整幅原图→模型把整张塞进一块、
 *   喂同框裁剪→模型照抄模糊原图，故彻底不喂参考、只靠已提交边缘 + 位置提示词自主续画。
 *   首块无邻居，整块按原图内容重绘作种子（见 operations.ts buildOutpaintPrompt 按位置生成提示词）。
 *   拼接用「平移最小误差对齐」+ 硬拼（不再线性羽化）：在小窗口内滑动 edited，找与已提交重叠区
 *   差最小的偏移(=最佳叠加位置)，再把新区写为对齐后的 edited、重叠区保持 committed 不动、
 *   滑动露出的空位填黑。硬拼不叠加两版 → 不重影（线性羽化会把两版轻微错位内容糊成重影）。
 *
 * 为什么能无缝且尺寸稳：① 1K tile —— codex/api 后端尊重 1K 尺寸（2K/4K 才不尊重，见 #19175）；
 *   ② mask —— Web 与 Adobe 后端不发 mask，故每块都按 image_edit + requiresMask 重新选择
 *   Codex/Responses 或标准 API（它们把 mask 发给上游，标准 images/edits 支持局部重绘）。
 *
 * 设计（职责分离，便于单测）：切块几何与每块保留区是纯函数（planOutpaintTiles / tileKeepInset），
 *   单独单测；编排 maskedOutpaintImage 用 sharp 做缩放/切块/合成，用注入的 editWithMask 回调重绘
 *   （gpt-image-2 带 mask，计费在 operations.ts）。任一块失败则保留原像素、不阻断。
 */
import sharp from "sharp";

// 单块边长：web/codex 都稳的 1K。
export const OUTPAINT_TILE = 1024;
// 步进占块边比例：仅用于 axisCount 决定块数；2×2 时实际重叠由 OUTPAINT_MAX_WORKING 决定。
export const OUTPAINT_STEP_FRACTION = 0.75;
// 重叠占块边比例：越大 → 喂给模型的已提交上下文越多、对齐搜索余量越大，接缝越不可见
// （代价：工作分辨率略低、外层超分多担一点）。0.4 → 2×2 时相邻块重叠约 410px。
export const OUTPAINT_OVERLAP_FRACTION = 0.4;
// 平移对齐搜索半径(px)与采样步长：在 [-R,R]² 内滑动 edited,按重叠区 MSE 找最佳偏移。
// R 越大越能纠正模型的位移漂移,但更慢、露出的黑边更宽;stride 采样降算力。
export const OUTPAINT_ALIGN_RANGE = 24;
export const OUTPAINT_ALIGN_STRIDE = 3;

export type OutpaintTile = {
  x: number;
  y: number;
  w: number;
  h: number;
  col: number;
  row: number;
};

export type OutpaintPlan = {
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  tiles: ReadonlyArray<OutpaintTile>;
};

/** 纯函数：某方向上的块数（目标 ≤ 块边则 1；否则按步进覆盖目标所需块数）。 */
function axisCount(target: number, tile: number, step: number): number {
  if (target <= tile) return 1;
  return Math.ceil((target - tile) / step) + 1;
}

/** 纯函数：某方向上第 i 块的起点（均匀分布，首块 0、末块贴右/下边缘铺满）。 */
function axisPos(
  i: number,
  count: number,
  target: number,
  tile: number
): number {
  if (count <= 1) return 0;
  return Math.round((i * (target - tile)) / (count - 1));
}

/**
 * 纯函数：在目标 (targetW,targetH) 上规划 1K 重叠切块（光栅顺序：先行后列，行内从左到右）。
 * 块尺寸取 min(块边, 目标)（目标小于块边时不放大切块）。相邻块均匀分布、末块贴边铺满。
 */
export function planOutpaintTiles(
  targetW: number,
  targetH: number,
  tile: number = OUTPAINT_TILE,
  stepFraction: number = OUTPAINT_STEP_FRACTION
): OutpaintPlan {
  const tileW = Math.min(tile, targetW);
  const tileH = Math.min(tile, targetH);
  const step = Math.max(1, Math.round(tile * stepFraction));
  const cols = axisCount(targetW, tileW, step);
  const rows = axisCount(targetH, tileH, step);
  const tiles: OutpaintTile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tiles.push({
        x: axisPos(col, cols, targetW, tileW),
        y: axisPos(row, rows, targetH, tileH),
        w: tileW,
        h: tileH,
        col,
        row,
      });
    }
  }
  return { cols, rows, tileW, tileH, tiles };
}

/**
 * 纯函数：某块与「已完成邻块」的重叠(保留)缩进——即该块左侧/上侧需锁死(keep)的像素宽/高。
 * 光栅顺序下，只有左邻(col-1)与上邻(row-1)已完成；重叠 = 邻块右/下缘越过本块起点的部分。
 *
 * @returns { left, top }：本块内 localX < left 或 localY < top 的区域为「保留区」(mask 不透明)。
 */
export function tileKeepInset(
  plan: OutpaintPlan,
  tile: OutpaintTile
): { left: number; top: number } {
  const { cols, tileW, tileH, tiles } = plan;
  let left = 0;
  let top = 0;
  if (tile.col > 0) {
    const leftNb = tiles[tile.row * cols + (tile.col - 1)]!;
    left = Math.max(0, leftNb.x + tileW - tile.x);
  }
  if (tile.row > 0) {
    const topNb = tiles[(tile.row - 1) * cols + tile.col]!;
    top = Math.max(0, topNb.y + tileH - tile.y);
  }
  // 防御：保留区不应吞掉整块(否则无新区域可画)。
  return { left: Math.min(left, tileW - 1), top: Math.min(top, tileH - 1) };
}

/** 构造某块的 mask（RGBA PNG）：保留区(localX<left||localY<top)不透明(255=保留)，其余透明(0=重绘)。 */
async function buildTileMask(
  w: number,
  h: number,
  left: number,
  top: number
): Promise<Buffer> {
  const rgba = Buffer.allocUnsafe(w * h * 4);
  for (let y = 0; y < h; y++) {
    const keepRow = y < top;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = keepRow || x < left ? 255 : 0;
    }
  }
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
}

// 工作分辨率较长边上限 = 2×块 − 1 个重叠(约 1638)。使 planOutpaintTiles 自然给 ≤2×2=4 块（控成本）；
// 更大目标由外层超分补足（照原设计「封顶 2×2 + 超分补足」，而非在全图上切成十几块）。
// 2×2 时相邻块重叠 = 2×块 − 上限 ≈ 410px（=OUTPAINT_OVERLAP_FRACTION×块边），给羽化足够过渡带。
export const OUTPAINT_MAX_WORKING =
  2 * OUTPAINT_TILE - Math.round(OUTPAINT_TILE * OUTPAINT_OVERLAP_FRACTION);

/**
 * 编排：掩码顺序外绘修复。
 *
 * @param image 输入图片字节
 * @param targetLongEdge 期望最终较长边
 * @param editTile 注入回调：输入(块画布 PNG, mask PNG, 块位置 pos, 宽, 高, 块序号)，返回带 mask 编辑后的块。
 *   不再喂原图/参考——改「自主拓展」：由 operations.ts 按 pos 生成位置提示词(「根据四周已渲染内容补出
 *   [某方位]」)，让模型只从已提交的边缘往黑区补该方位。images=[块]+mask、路由 codex/api、逐块计费。
 * @param superResolve 注入的 4 倍超分（Real-ESRGAN general）；把外绘后的工作图放大补足到目标。
 * @returns { buffer, tilesRepaired, tilesTotal }：拼接(+超分)后的图、成功块数、总块数（供计费/诊断）
 *
 * 流程：封顶工作分辨率(≤~1638 长边 → 2×2=4 块) → 逐块留黑 + 位置提示词自主外绘
 *   → 平移最小误差对齐硬拼 → 超分补足到目标较长边。
 * 关键：非首块待补区填黑逼外绘、位置提示词框定方位、拼接用平移对齐+硬拼(不羽化,消重影)、露出空位填黑。
 */
export async function maskedOutpaintImage(
  image: Buffer,
  targetLongEdge: number,
  editTile: (
    tileCanvas: Buffer,
    mask: Buffer,
    pos: { col: number; row: number; cols: number; rows: number },
    w: number,
    h: number,
    index: number
  ) => Promise<Buffer>,
  superResolve: (img: Buffer) => Promise<Buffer>
): Promise<{ buffer: Buffer; tilesRepaired: number; tilesTotal: number }> {
  const meta = await sharp(image).metadata();
  const sW = meta.width ?? 0;
  const sH = meta.height ?? 0;
  if (!sW || !sH) return { buffer: image, tilesRepaired: 0, tilesTotal: 0 };

  // 工作分辨率：较长边封顶 OUTPAINT_MAX_WORKING(→2×2=4 块)，保持源比例。
  const workLong = Math.min(targetLongEdge, OUTPAINT_MAX_WORKING);
  const k = workLong / Math.max(sW, sH);
  const workW = Math.max(1, Math.round(sW * k));
  const workH = Math.max(1, Math.round(sH * k));
  const plan = planOutpaintTiles(workW, workH);
  // 画布：工作分辨率的整幅 raw RGB，初始为缩放后的原图。
  const canvas = await sharp(image)
    .resize(workW, workH, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();

  let tilesRepaired = 0;
  for (let i = 0; i < plan.tiles.length; i++) {
    const t = plan.tiles[i]!;
    const { left, top } = tileKeepInset(plan, t);
    // 从画布抠出本块当前状态（保留区=已提交邻块像素，其余=原图像素）。
    const tileRaw = extractTile(canvas, workW, t);
    // 留黑真外绘：非首块把「待补区」(x>=left && y>=top)填黑，只留与已提交邻块的重叠边，
    // 逼模型从边缘往黑区补（内容靠位置提示词「从四周补该方位」自主生成，不再喂参考）。
    // 首块(left=top=0，无邻居)不填黑，整块基于原图内容重绘作种子。
    if (left > 0 || top > 0) {
      blackenNewRegion(tileRaw, t, left, top);
    }
    const tilePng = await sharp(tileRaw, {
      raw: { width: t.w, height: t.h, channels: 3 },
    })
      .png()
      .toBuffer();
    try {
      const mask = await buildTileMask(t.w, t.h, left, top);
      const edited = await editTile(
        tilePng,
        mask,
        { col: t.col, row: t.row, cols: plan.cols, rows: plan.rows },
        t.w,
        t.h,
        i
      );
      const editedRaw = await sharp(edited)
        .resize(t.w, t.h, { fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer();
      // 平移最小误差对齐后硬拼:重叠区保持 committed、新区写对齐后的 edited、露出空位填黑 → 不重影。
      slideAlignEditedTile(canvas, workW, t, editedRaw, left, top);
      tilesRepaired++;
    } catch {
      // 该块失败：画布保留原像素，继续下一块。
    }
  }

  let buffer = await sharp(canvas, {
    raw: { width: workW, height: workH, channels: 3 },
  })
    .png()
    .toBuffer();

  // 超分补足到目标较长边（保持比例）。工作分辨率 < 目标时才放大。
  if (targetLongEdge > workLong) {
    const scale = targetLongEdge / workLong;
    buffer = await upscaleTo(
      buffer,
      Math.round(workW * scale),
      Math.round(workH * scale),
      superResolve
    );
  }
  return { buffer, tilesRepaired, tilesTotal: plan.tiles.length };
}

/**
 * 把图放大/缩放到精确 (w,h)。放大倍率 ≥1.5 用 Real-ESRGAN 4 倍超分再缩到目标；否则 Lanczos。
 */
async function upscaleTo(
  image: Buffer,
  w: number,
  h: number,
  superResolve: (img: Buffer) => Promise<Buffer>
): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const srcLong = Math.max(meta.width ?? 1, meta.height ?? 1);
  const base =
    Math.max(w, h) / srcLong >= 1.5 ? await superResolve(image) : image;
  return sharp(base).resize(w, h, { fit: "fill" }).png().toBuffer();
}

/** 从整幅 raw RGB 抠出一块（HWC uint8）。 */
function extractTile(canvas: Buffer, canvasW: number, t: OutpaintTile): Buffer {
  const out = Buffer.allocUnsafe(t.w * t.h * 3);
  for (let y = 0; y < t.h; y++) {
    const src = ((t.y + y) * canvasW + t.x) * 3;
    canvas.copy(out, y * t.w * 3, src, src + t.w * 3);
  }
  return out;
}

/**
 * 原地把块的「待补区」(x>=left && y>=top) 填黑（RGB=0），只保留与已提交邻块的重叠边
 * (x<left || y<top)。配合 mask（黑区=重绘）→ 真外绘：模型只能从非黑的边缘往黑区补，
 * 而不是在原内容上做 img2img（后者对 mask 遵守弱、易整块重调色、留缝）。
 */
export function blackenNewRegion(
  tileRaw: Buffer,
  t: OutpaintTile,
  left: number,
  top: number
): void {
  for (let y = top; y < t.h; y++) {
    const base = (y * t.w + left) * 3;
    tileRaw.fill(0, base, base + (t.w - left) * 3);
  }
}

/** RGB 平方差(a[ai..]与 b[bi..]三通道)。 */
function diff3(a: Buffer, ai: number, b: Buffer, bi: number): number {
  const dr = (a[ai] ?? 0) - (b[bi] ?? 0);
  const dg = (a[ai + 1] ?? 0) - (b[bi + 1] ?? 0);
  const db = (a[ai + 2] ?? 0) - (b[bi + 2] ?? 0);
  return dr * dr + db * db + dg * dg;
}

/**
 * 在 [-R,R]² 平移窗口内滑动 edited，求与已提交重叠区(committed)差最小的偏移(dx,dy)。
 * 只在重叠区(x<left || y<top，committed 有值处)按采样后的 MSE 评分；无重叠(首块)返回 (0,0)。
 * dx,dy 语义：新区某点 (x,y) 取 edited(x-dx, y-dy)——即把 edited 整体平移 (dx,dy) 去贴合 committed。
 *
 * 注：export 供单测。
 */
export function findBestOffset(
  canvas: Buffer,
  canvasW: number,
  t: OutpaintTile,
  edited: Buffer,
  left: number,
  top: number,
  range: number = OUTPAINT_ALIGN_RANGE,
  stride: number = OUTPAINT_ALIGN_STRIDE
): { dx: number; dy: number } {
  const { w, h } = t;
  let bestDx = 0;
  let bestDy = 0;
  let bestErr = Number.POSITIVE_INFINITY;
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      let sum = 0;
      let n = 0;
      for (let y = 0; y < h; y += stride) {
        for (let x = 0; x < w; x += stride) {
          if (x >= left && y >= top) continue; // 只比重叠区
          const sx = x - dx;
          const sy = y - dy;
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          const c = ((t.y + y) * canvasW + (t.x + x)) * 3;
          const e = (sy * w + sx) * 3;
          sum += diff3(canvas, c, edited, e);
          n++;
        }
      }
      if (n > 0) {
        const mse = sum / n;
        if (mse < bestErr) {
          bestErr = mse;
          bestDx = dx;
          bestDy = dy;
        }
      }
    }
  }
  return { dx: bestDx, dy: bestDy };
}

/**
 * 平移最小误差对齐 + 硬拼(替代线性羽化,消重影)：
 *   先 findBestOffset 求最佳偏移(dx,dy)，再把「新区」(x>=left && y>=top)写为对齐后的 edited
 *   (读 edited(x-dx, y-dy))；重叠区(committed)原样不动；滑动后取不到 edited 的位置填黑(RGB=0)。
 *   硬拼不混合两版 → 不重影；对齐使新区内容在边界处贴合 committed。首块(无重叠)偏移(0,0)、整块写回。
 *
 * 注：export 供单测；生产仅 maskedOutpaintImage 内部调用（原地改写 canvas）。
 */
export function slideAlignEditedTile(
  canvas: Buffer,
  canvasW: number,
  t: OutpaintTile,
  edited: Buffer,
  left: number,
  top: number
): void {
  const { w, h } = t;
  const { dx, dy } = findBestOffset(canvas, canvasW, t, edited, left, top);
  for (let y = top; y < h; y++) {
    for (let x = left; x < w; x++) {
      const d = ((t.y + y) * canvasW + (t.x + x)) * 3;
      const sx = x - dx;
      const sy = y - dy;
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) {
        canvas[d] = 0; // 滑动露出的空位→黑
        canvas[d + 1] = 0;
        canvas[d + 2] = 0;
      } else {
        const e = (sy * w + sx) * 3;
        canvas[d] = edited[e] ?? 0;
        canvas[d + 1] = edited[e + 1] ?? 0;
        canvas[d + 2] = edited[e + 2] ?? 0;
      }
    }
  }
}
