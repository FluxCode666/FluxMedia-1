/**
 * 服务端抠图(背景移除)。
 *
 * 职责:用 ISNet 显著性分割模型把图片主体从背景分离,输出带 alpha 的 PNG(背景透明、主体保留)。
 * 使用方：透明背景生成兜底；当上游只返回不透明图时移除背景。
 *
 * 模型来源/许可:ISNet(IS-Net,Highly Accurate Dichotomous Image Segmentation),
 *   Xuebin Qin 等,https://github.com/xuebinqin/DIS,MIT 许可,可商用。
 * 推理引擎:onnxruntime-node(MIT)。预处理/后处理均按 ISNet 标准自写,未使用任何 AGPL 代码。
 *
 * 性能:CPU 单张约 0.7–1s。InferenceSession 进程内缓存,避免每次重载 ~44MB 模型。
 */
import path from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

/** ISNet 输入边长。 */
const MODEL_INPUT = 1024;

/** 模型文件路径:优先 env,否则相对运行目录的 models/isnet.onnx(standalone 与 dev 一致)。 */
function modelPath(): string {
  return (
    process.env.ISNET_MODEL_PATH?.trim() ||
    path.join(process.cwd(), "models", "isnet.onnx")
  );
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;
function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(modelPath());
  }
  return sessionPromise;
}

/**
 * 移除背景:输入任意图片字节,返回带透明背景的 PNG 字节(主体保留)。
 *
 * @throws 图片尺寸不可解析、或模型输出缺失时抛错。
 */
export async function removeBackground(image: Buffer): Promise<Buffer> {
  const session = await getSession();

  const meta = await sharp(image).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("removeBackground: 无法解析图片尺寸");
  }
  const width = meta.width;
  const height = meta.height;

  // 预处理:resize 到 1024×1024(fill)、取 raw RGB(HWC uint8)→ CHW float32,x = p/255 − 0.5。
  const { data: hwc } = await sharp(image)
    .removeAlpha()
    .resize(MODEL_INPUT, MODEL_INPUT, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const area = MODEL_INPUT * MODEL_INPUT;
  const chw = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    chw[i] = (hwc[i * 3] ?? 0) / 255 - 0.5;
    chw[area + i] = (hwc[i * 3 + 1] ?? 0) / 255 - 0.5;
    chw[2 * area + i] = (hwc[i * 3 + 2] ?? 0) / 255 - 0.5;
  }

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    throw new Error("removeBackground: 模型缺少输入/输出名");
  }
  const result = await session.run({
    [inputName]: new ort.Tensor("float32", chw, [
      1,
      3,
      MODEL_INPUT,
      MODEL_INPUT,
    ]),
  });
  const out = result[outputName];
  if (!out) {
    throw new Error("removeBackground: 模型输出缺失");
  }
  // 主输出 [1,1,1024,1024],graph 已内置 sigmoid,值域 [0,1]。
  const maskData = out.data as Float32Array;

  // min-max 归一化 → uint8 单通道 mask。
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < maskData.length; i++) {
    const v = maskData[i] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const maskU8 = Buffer.allocUnsafe(area);
  for (let i = 0; i < area; i++) {
    maskU8[i] = Math.round((((maskData[i] ?? 0) - min) / range) * 255);
  }

  // mask resize 回原尺寸。坑:必须 toColourspace("b-w"),否则 sharp 把单通道升成 3 通道。
  const alpha = await sharp(maskU8, {
    raw: { width: MODEL_INPUT, height: MODEL_INPUT, channels: 1 },
  })
    .resize(width, height, { fit: "fill" })
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  // 坑:必须先把原图 materialize 成 raw RGB 再 joinChannel(alpha);直接在 lazy 解码链上
  // joinChannel 会静默丢掉 alpha 通道。
  const rgb = await sharp(image).removeAlpha().raw().toBuffer();
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}
