"use client";

/**
 * Adobe Firefly 视频创作面板（自包含）。
 *
 * 选模型族(9族) + 时长 + 比例[+分辨率] → 组装 firefly-<family>-<dur>s-<ratio>[-<res>]
 * model id → POST /api/videos/generate 获取 taskId → 按 worker 周期退避查询状态 → 播放
 * 产物视频。可选上传一张输入图做图生视频首帧。与图像创作解耦，作为创作页独立 tab。
 */

import {
  formatAdobeModelIdForDisplay,
  getVideoCreditCost,
  resolveVideoCreditsPerSecond,
} from "@repo/shared/adobe";
import { FIREFLY_VIDEO_FAMILIES } from "@repo/shared/adobe/firefly-direct/video-catalog";
import { Button } from "@repo/ui/components/button";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Switch } from "@repo/ui/components/switch";
import { Textarea } from "@repo/ui/components/textarea";
import { Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { VideoPricingInfo } from "../video-operations";

/** 经静态视频目录验证后，可安全用于面板一次性初始化的模型选项。 */
export type VideoCreateInitialSelection = {
  familyId: string;
  duration: number;
  ratio: string;
  resolution: string;
};

type VideoStatus = "idle" | "running" | "done" | "error";

type VideoTaskResponse = {
  taskId: string;
  status:
    | "pending"
    | "submitting"
    | "processing"
    | "needs_attention"
    | "completed"
    | "failed";
  videoUrl?: string;
  error?: string;
};

const VIDEO_STATUS_INITIAL_POLL_MS = 60_000;
const VIDEO_STATUS_MAX_POLL_MS = 120_000;

/** 等待下一轮状态查询；间隔不低于后端视频 worker 的一分钟周期。 */
function waitForVideoPoll(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** 收窄站内状态响应；非法或漂移的服务端负载显式失败。 */
function parseVideoTaskResponse(value: unknown): VideoTaskResponse {
  if (!value || typeof value !== "object") {
    throw new Error("视频任务响应格式无效");
  }
  const record = value as Record<string, unknown>;
  const statuses: VideoTaskResponse["status"][] = [
    "pending",
    "submitting",
    "processing",
    "needs_attention",
    "completed",
    "failed",
  ];
  if (
    typeof record.taskId !== "string" ||
    !statuses.includes(record.status as VideoTaskResponse["status"])
  ) {
    throw new Error("视频任务响应格式无效");
  }
  return {
    taskId: record.taskId,
    status: record.status as VideoTaskResponse["status"],
    ...(typeof record.videoUrl === "string"
      ? { videoUrl: record.videoUrl }
      : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

function ratioSuffix(ratio: string): string {
  return ratio.replace(":", "x");
}

function composeVideoModelId(params: {
  family: string;
  duration: number;
  ratio: string;
  resolution: string;
  resolutionInId: boolean;
}): string {
  const base = `firefly-${params.family}-${params.duration}s-${ratioSuffix(
    params.ratio
  )}`;
  return params.resolutionInId ? `${base}-${params.resolution}` : base;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

// 把(本站)历史图 URL 取回并转成 base64 data URL,作为图生视频首帧。
async function urlToDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`读取历史图失败 HTTP ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取历史图失败"));
    reader.readAsDataURL(blob);
  });
}

type VideoHistoryItem = {
  id: string;
  imageUrl: string | null;
  status: string;
};

export function VideoCreatePanel({
  initialSelection = null,
  recent = [],
  pricing,
}: {
  initialSelection?: VideoCreateInitialSelection | null;
  recent?: VideoHistoryItem[];
  pricing: VideoPricingInfo;
}) {
  const families = FIREFLY_VIDEO_FAMILIES;
  const initialFamily =
    families.find((item) => item.family === initialSelection?.familyId) ??
    families[0];
  const [familyId, setFamilyId] = useState(initialFamily?.family ?? "sora2");
  const family = useMemo(
    () => families.find((item) => item.family === familyId) ?? families[0],
    [familyId]
  );
  const [duration, setDuration] = useState<number>(
    initialSelection?.duration ?? initialFamily?.durations[0] ?? 8
  );
  const [ratio, setRatio] = useState<string>(
    initialSelection?.ratio ?? initialFamily?.ratios[0] ?? "16:9"
  );
  const [resolution, setResolution] = useState<string>(
    initialSelection?.resolution ?? initialFamily?.resolutions[0] ?? "720p"
  );
  const [generateAudio, setGenerateAudio] = useState(
    initialFamily?.generateAudio ?? false
  );
  const [prompt, setPrompt] = useState("");
  const [inputImage, setInputImage] = useState<string | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(
    null
  );
  const [status, setStatus] = useState<VideoStatus>("idle");
  const historyImages = recent.filter(
    (item) => item.status === "completed" && item.imageUrl
  );
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 切换模型族时把时长/比例/分辨率收敛到该族支持的取值。
  const onFamilyChange = (value: string) => {
    setFamilyId(value);
    const next = families.find((item) => item.family === value);
    if (next) {
      setDuration(next.durations[0] ?? duration);
      setRatio(next.ratios[0] ?? ratio);
      setResolution(next.resolutions[0] ?? resolution);
      setGenerateAudio(next.generateAudio);
    }
  };

  // 预估积分：与扣费侧（video-operations）同口径——模型族每秒价格 × 时长。
  // 纯函数复用，确保展示价 = 实扣价。必须在任何 early return
  // 之前无条件调用（React hooks 规则），故对 family 用可选链兜底。
  const creditsPerSecond = resolveVideoCreditsPerSecond(
    family?.family,
    pricing.creditsPerSecond
  );
  const estimatedCredits = useMemo(() => {
    return getVideoCreditCost({
      durationSeconds: duration,
      creditsPerSecond,
    });
  }, [creditsPerSecond, duration]);

  // 各视频模型(族 × 时长)的积分消耗对照表:与上方预估、与扣费侧同口径
  // （模型族每秒价格 × 时长）,用户选模型前即可比价。
  // 必须在 early return 之前无条件调用(hooks 规则)。
  const pricingTable = useMemo(
    () =>
      families.map((item) => {
        const creditsPerSecond = resolveVideoCreditsPerSecond(
          item.family,
          pricing.creditsPerSecond
        );
        return {
          family: item.family,
          label: item.label,
          creditsPerSecond,
          rows: item.durations.map((seconds) => ({
            seconds,
            credits: getVideoCreditCost({
              durationSeconds: seconds,
              creditsPerSecond,
            }),
          })),
        };
      }),
    [pricing]
  );

  if (!family) return null;

  const model = composeVideoModelId({
    family: family.family,
    duration,
    ratio,
    resolution,
    resolutionInId: family.resolutionInId,
  });

  const generate = async () => {
    if (!prompt.trim() || status === "running") return;
    setStatus("running");
    setError(null);
    setVideoUrl(null);
    try {
      const response = await fetch("/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          prompt: prompt.trim(),
          model,
          ...(family.supportsAudio ? { generateAudio } : {}),
          ...(inputImage ? { inputImages: [inputImage] } : {}),
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `请求失败 HTTP ${response.status}`);
      }
      let task = parseVideoTaskResponse(await response.json());
      let pollDelayMs = VIDEO_STATUS_INITIAL_POLL_MS;
      for (;;) {
        if (task.status === "completed" && task.videoUrl) {
          setVideoUrl(task.videoUrl);
          setStatus("done");
          return;
        }
        if (task.status === "failed" || task.status === "needs_attention") {
          throw new Error(
            task.error ??
              (task.status === "needs_attention"
                ? "视频提交结果需要人工核对"
                : "视频生成失败")
          );
        }
        await waitForVideoPoll(pollDelayMs);
        const statusResponse = await fetch(
          `/api/videos/${encodeURIComponent(task.taskId)}`,
          { cache: "no-store" }
        );
        if (!statusResponse.ok) {
          const text = await statusResponse.text().catch(() => "");
          throw new Error(text || `状态查询失败 HTTP ${statusResponse.status}`);
        }
        task = parseVideoTaskResponse(await statusResponse.json());
        pollDelayMs = Math.min(
          Math.round(pollDelayMs * 1.5),
          VIDEO_STATUS_MAX_POLL_MS
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "视频生成失败");
      setStatus("error");
    }
  };

  const busy = status === "running";

  return (
    <div className="space-y-4 rounded-lg border border-border bg-background p-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">模型</Label>
          <Select
            value={familyId}
            onValueChange={onFamilyChange}
            disabled={busy}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {families.map((item) => (
                <SelectItem key={item.family} value={item.family}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">时长</Label>
          <Select
            value={String(duration)}
            onValueChange={(value) => setDuration(Number(value))}
            disabled={busy}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {family.durations.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {value}s
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">比例</Label>
          <Select value={ratio} onValueChange={setRatio} disabled={busy}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {family.ratios.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {family.resolutionInId && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">分辨率</Label>
            <Select
              value={resolution}
              onValueChange={setResolution}
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {family.resolutions.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {family.supportsAudio && (
        <div className="flex items-center gap-2">
          <Switch
            id="video-generate-audio"
            checked={generateAudio}
            onCheckedChange={setGenerateAudio}
            disabled={busy}
          />
          <Label htmlFor="video-generate-audio">生成声音</Label>
        </div>
      )}

      <Textarea
        placeholder="描述要生成的视频…"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        disabled={busy}
        rows={3}
      />

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          首帧图（可选，图生视频）
        </Label>
        {historyImages.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {historyImages.slice(0, 12).map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={busy}
                title="用此历史图作首帧"
                onClick={async () => {
                  if (!item.imageUrl) return;
                  try {
                    setInputImage(await urlToDataUrl(item.imageUrl));
                    setSelectedHistoryId(item.id);
                  } catch {
                    setSelectedHistoryId(null);
                  }
                }}
                className={`h-14 w-14 overflow-hidden rounded-md border transition-[border-color,box-shadow] duration-150 ${
                  selectedHistoryId === item.id
                    ? "border-primary ring-1 ring-primary"
                    : "border-border hover:border-foreground/40"
                }`}
              >
                {/* 历史缩略图使用本站已生成图。 */}
                {/* biome-ignore lint/performance/noImgElement: 简单缩略图选择器 */}
                <img
                  src={item.imageUrl ?? ""}
                  alt=""
                  className="h-full w-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            setInputImage(file ? await fileToDataUrl(file) : null);
            setSelectedHistoryId(null);
          }}
        />
        {inputImage && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            disabled={busy}
            onClick={() => {
              setInputImage(null);
              setSelectedHistoryId(null);
            }}
          >
            清除首帧图
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={generate} disabled={busy || !prompt.trim()}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          生成视频
        </Button>
        <span className="text-sm font-medium">
          预计消耗 {estimatedCredits} 积分
        </span>
        <span className="text-xs text-muted-foreground">
          {duration}s × {creditsPerSecond}/秒
        </span>
        <span className="text-xs text-muted-foreground">
          {formatAdobeModelIdForDisplay(model)}
        </span>
      </div>

      <details open className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none font-medium">
          各视频模型积分消耗
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border/60">
                <th className="py-1 pr-4 font-medium">模型</th>
                <th className="py-1 font-medium">各时长消耗（积分）</th>
              </tr>
            </thead>
            <tbody>
              {pricingTable.map((item) => (
                <tr key={item.family} className="border-b border-border/30">
                  <td className="whitespace-nowrap py-1 pr-4">
                    {item.label}
                    {`（${item.creditsPerSecond} 积分/秒）`}
                  </td>
                  <td className="py-1">
                    {item.rows
                      .map((row) => `${row.seconds}s = ${row.credits}`)
                      .join("　·　")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1">
            计费口径：模型族每秒积分 × 时长；未配置分组覆盖时继承全局模型价格，
            与实际扣费一致；比例 / 分辨率不影响积分。
          </p>
        </div>
      </details>

      {status === "running" && (
        <p className="animate-pulse text-sm text-muted-foreground motion-reduce:animate-none">
          视频生成中，可能需要数分钟，请保持页面打开…
        </p>
      )}
      {status === "error" && error && (
        <p className="animate-in fade-in text-sm text-destructive motion-reduce:animate-none">
          {error}
        </p>
      )}
      {status === "done" && videoUrl && (
        <video
          src={videoUrl}
          controls
          className="w-full max-w-2xl rounded-lg border border-border animate-in fade-in zoom-in-95 duration-400 motion-reduce:animate-none"
        >
          <track kind="captions" />
        </video>
      )}
    </div>
  );
}
