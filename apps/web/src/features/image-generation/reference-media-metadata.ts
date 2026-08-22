/**
 * 参考视频与音频的真实媒体元数据校验。
 *
 * 使用方：视频输入转存层。媒体内容通过 stdin 交给 ffprobe，不落临时文件；探测器
 * 输出先解析成有限字段，再按公开接口的时长、尺寸和帧率契约校验。
 */

import { spawn } from "node:child_process";

const FFMPEG_PROBE_TIMEOUT_MS = 20_000;
const MIN_REFERENCE_VIDEO_DURATION_SECONDS = 4;
const MAX_REFERENCE_VIDEO_DURATION_SECONDS = 10;
const MAX_REFERENCE_VIDEO_TOTAL_DURATION_SECONDS = 15;
const MIN_REFERENCE_VIDEO_DIMENSION = 720;
const MAX_REFERENCE_VIDEO_DIMENSION = 2160;
const MIN_REFERENCE_VIDEO_FPS = 24;
const MAX_REFERENCE_VIDEO_FPS = 60;
const MAX_REFERENCE_AUDIO_DURATION_SECONDS = 15;

type ProbeKind = "video" | "audio";

interface ProbeStream {
  width?: unknown;
  height?: unknown;
  duration?: unknown;
  avg_frame_rate?: unknown;
  r_frame_rate?: unknown;
}

interface ProbeOutput {
  streams?: unknown;
  format?: {
    duration?: unknown;
  };
}

export interface ReferenceVideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  framesPerSecond: number;
}

export interface ReferenceAudioMetadata {
  durationSeconds: number;
}

/** 将 ffprobe 的整数、浮点或字符串字段收窄为有限正数。 */
function parsePositiveNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 解析 ffprobe 的 `numerator/denominator` 帧率文本。 */
function parseFrameRate(value: unknown): number | undefined {
  if (typeof value !== "string") return parsePositiveNumber(value);
  const parts = value.split("/", 2).map(Number);
  const numerator = parts[0];
  const denominator = parts[1];
  if (numerator === undefined || denominator === undefined) return undefined;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return undefined;
  }
  if (denominator === 0) return undefined;
  const frameRate = numerator / denominator;
  return Number.isFinite(frameRate) && frameRate > 0 ? frameRate : undefined;
}

/** 从 ffprobe JSON 提取第一个目标流及 format duration。 */
function parseProbeOutput(rawOutput: string): {
  stream: ProbeStream;
  formatDurationSeconds?: number;
} {
  let parsed: ProbeOutput;
  try {
    parsed = JSON.parse(rawOutput) as ProbeOutput;
  } catch (error) {
    throw new Error("参考媒体元数据响应无效", { cause: error });
  }
  const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : undefined;
  if (!stream || typeof stream !== "object") {
    throw new Error("参考媒体缺少可识别的媒体流");
  }
  const formatDurationSeconds = parsePositiveNumber(parsed.format?.duration);
  return {
    stream: stream as ProbeStream,
    ...(formatDurationSeconds !== undefined ? { formatDurationSeconds } : {}),
  };
}

/** 使用 ffprobe 从 stdin 读取媒体元数据，避免写入用户可控临时路径。 */
async function probeMedia(
  data: Buffer,
  kind: ProbeKind
): Promise<{ stream: ProbeStream; formatDurationSeconds?: number }> {
  const executable = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  const args = [
    "-v",
    "error",
    "-select_streams",
    kind === "video" ? "v:0" : "a:0",
    "-show_entries",
    kind === "video"
      ? "stream=width,height,duration,avg_frame_rate,r_frame_rate:format=duration"
      : "stream=duration:format=duration",
    "-of",
    "json",
    "-i",
    "pipe:0",
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error("参考媒体元数据探测超时"));
      }
    }, FFMPEG_PROBE_TIMEOUT_MS);

    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    child.on("error", (error) => {
      settleReject(new Error("参考媒体元数据探测不可用", { cause: error }));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        const detail = stderr.trim();
        reject(
          new Error(
            detail
              ? `参考媒体无法解析：${detail.slice(0, 240)}`
              : "参考媒体无法解析"
          )
        );
        return;
      }
      try {
        resolve(parseProbeOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", settleReject);
    child.stdin.end(data);
  });
}

/** 探测并校验一个参考视频的真实时长、尺寸与帧率。 */
export async function validateReferenceVideoMetadata(
  data: Buffer
): Promise<ReferenceVideoMetadata> {
  const { stream, formatDurationSeconds } = await probeMedia(data, "video");
  const durationSeconds =
    parsePositiveNumber(stream.duration) ?? formatDurationSeconds;
  const width = parsePositiveNumber(stream.width);
  const height = parsePositiveNumber(stream.height);
  const framesPerSecond =
    parseFrameRate(stream.avg_frame_rate) ??
    parseFrameRate(stream.r_frame_rate);
  if (
    durationSeconds === undefined ||
    durationSeconds < MIN_REFERENCE_VIDEO_DURATION_SECONDS ||
    durationSeconds > MAX_REFERENCE_VIDEO_DURATION_SECONDS
  ) {
    throw new Error("参考视频单条时长必须在 4 至 10 秒之间");
  }
  if (
    width === undefined ||
    height === undefined ||
    width < MIN_REFERENCE_VIDEO_DIMENSION ||
    height < MIN_REFERENCE_VIDEO_DIMENSION ||
    width > MAX_REFERENCE_VIDEO_DIMENSION ||
    height > MAX_REFERENCE_VIDEO_DIMENSION
  ) {
    throw new Error("参考视频宽高必须在 720 至 2160 像素之间");
  }
  if (
    framesPerSecond === undefined ||
    framesPerSecond < MIN_REFERENCE_VIDEO_FPS ||
    framesPerSecond > MAX_REFERENCE_VIDEO_FPS
  ) {
    throw new Error("参考视频帧率必须在 24 至 60 FPS 之间");
  }
  return { durationSeconds, width, height, framesPerSecond };
}

/** 探测并校验一个参考音频的真实时长。 */
export async function validateReferenceAudioMetadata(
  data: Buffer
): Promise<ReferenceAudioMetadata> {
  const { stream, formatDurationSeconds } = await probeMedia(data, "audio");
  const durationSeconds =
    parsePositiveNumber(stream.duration) ?? formatDurationSeconds;
  if (
    durationSeconds === undefined ||
    durationSeconds > MAX_REFERENCE_AUDIO_DURATION_SECONDS
  ) {
    throw new Error("参考音频时长不能超过 15 秒");
  }
  return { durationSeconds };
}

/** 校验多个参考视频的合计时长。 */
export function assertReferenceVideoTotalDuration(
  metadata: readonly ReferenceVideoMetadata[]
): void {
  const totalDurationSeconds = metadata.reduce(
    (total, item) => total + item.durationSeconds,
    0
  );
  if (totalDurationSeconds > MAX_REFERENCE_VIDEO_TOTAL_DURATION_SECONDS) {
    throw new Error("参考视频合计时长不能超过 15 秒");
  }
}
