"use client";

/**
 * 视频创作面板（自包含）。
 *
 * 直接维护真实模型 ID、时长、比例、分辨率、声音与具名输入，提交到统一 UOL 薄路由；
 * 获取 taskId 后按 worker 周期退避查询状态并播放产物。帧模式与参考图模式全局互斥。
 * 使用方：图像创作页的视频独立 tab。
 */

import {
  getVideoCreditCost,
  resolveVideoCreditsPerSecondByResolution,
} from "@repo/shared/adobe";
import { formatCredits } from "@repo/shared/credits/format";
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
import { Coins, ImageIcon, ImagePlus, Loader2, Video } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  createStaticVideoCreateModels,
  parseReachableVideoCreateModels,
  resolveDefaultVideoCreateInputMode,
  resolveVideoCreateInputLimits,
  type VideoCreateInputMode,
  type VideoCreateModel,
} from "../video-create-capabilities";
import type { VideoPricingInfo } from "../video-operations";

/** 经静态视频目录验证后，可安全用于面板一次性初始化的模型选项。 */
export type VideoCreateInitialSelection = {
  modelId: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
};

type VideoStatus = "idle" | "running" | "done" | "error";

type VideoTaskResponse = {
  taskId: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  videoUrl?: string;
  error?: string;
};

export const VIDEO_STATUS_INITIAL_POLL_MS = 3_000;
const VIDEO_STATUS_MAX_POLL_MS = 120_000;
const VIDEO_CREATE_MODELS = createStaticVideoCreateModels();
const VIDEO_CAPABILITIES_TIMEOUT_MS = 15_000;

/** 等待下一轮状态查询；BullMQ 即时唤醒后首轮无需等待旧的一分钟扫描周期。 */
function waitForVideoPoll(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** 有界增加视频状态查询间隔，长期任务最终降到低频查询。 */
export function resolveNextVideoPollDelay(currentDelayMs: number): number {
  return Math.min(Math.round(currentDelayMs * 1.5), VIDEO_STATUS_MAX_POLL_MS);
}

/**
 * 收窄站内视频状态响应。
 *
 * @param value 创建或查询路由返回的不可信 JSON。
 * @returns 只含公开视频四态、任务 ID 和可选结果/错误的响应。
 * @sideEffects 无。
 * @throws Error 负载不是对象、缺少任务 ID 或包含旧状态/未知状态时显式失败。
 */
export function parseVideoTaskResponse(value: unknown): VideoTaskResponse {
  if (!value || typeof value !== "object") {
    throw new Error("视频任务响应格式无效");
  }
  const record = value as Record<string, unknown>;
  const statuses: VideoTaskResponse["status"][] = [
    "queued",
    "in_progress",
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
  const [models, setModels] =
    useState<readonly VideoCreateModel[]>(VIDEO_CREATE_MODELS);
  const initialModel =
    models.find((item) => item.model === initialSelection?.modelId) ??
    models[0];
  const [modelId, setModelId] = useState(initialModel?.model ?? "sora2");
  const selectedModel = useMemo(
    () => models.find((item) => item.model === modelId) ?? models[0],
    [modelId, models]
  );
  const [duration, setDuration] = useState<number>(
    initialSelection?.duration ?? initialModel?.durations[0] ?? 8
  );
  const [aspectRatio, setAspectRatio] = useState<string>(
    initialSelection?.aspectRatio ?? initialModel?.aspectRatios[0] ?? "16:9"
  );
  const [resolution, setResolution] = useState<string>(
    initialSelection?.resolution ?? initialModel?.resolutions[0] ?? "720p"
  );
  const [generateAudio, setGenerateAudio] = useState(
    initialModel?.defaultGenerateAudio ?? false
  );
  const [prompt, setPrompt] = useState("");
  const [inputImages, setInputImages] = useState<string[]>([]);
  const [inputMode, setInputMode] = useState<VideoCreateInputMode>(() =>
    resolveDefaultVideoCreateInputMode(initialModel)
  );
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([]);
  const [status, setStatus] = useState<VideoStatus>("idle");
  const historyImages = recent.filter(
    (item) => item.status === "completed" && item.imageUrl
  );
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(
    null
  );

  /**
   * 从 Principal 感知的 UOL 薄路由加载当前可达模型和动态上限。
   *
   * 静态目录只维持首屏选择器结构；请求完成前所有提交控件保持禁用，避免管理员
   * 已修改 Seedance 上限时仍按过期客户端常量选择或提交。
   */
  useEffect(() => {
    const controller = new AbortController();
    let unmounted = false;
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, VIDEO_CAPABILITIES_TIMEOUT_MS);

    const loadCapabilities = async () => {
      try {
        const response = await fetch("/api/videos/capabilities", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          const message = await response.text().catch(() => "");
          throw new Error(
            message || `视频模型能力查询失败 HTTP ${response.status}`
          );
        }
        const reachableModels = parseReachableVideoCreateModels(
          await response.json()
        );
        if (unmounted) return;

        setModels(reachableModels);
        const nextModel =
          reachableModels.find(
            (item) => item.model === initialSelection?.modelId
          ) ?? reachableModels[0];
        if (nextModel) {
          setModelId(nextModel.model);
          setDuration(
            initialSelection?.modelId === nextModel.model &&
              nextModel.durations.includes(initialSelection.duration)
              ? initialSelection.duration
              : (nextModel.durations[0] ?? 8)
          );
          setAspectRatio(
            initialSelection?.modelId === nextModel.model &&
              nextModel.aspectRatios.includes(initialSelection.aspectRatio)
              ? initialSelection.aspectRatio
              : (nextModel.aspectRatios[0] ?? "16:9")
          );
          setResolution(
            initialSelection?.modelId === nextModel.model &&
              nextModel.resolutions.includes(initialSelection.resolution)
              ? initialSelection.resolution
              : (nextModel.resolutions[0] ?? "720p")
          );
          setGenerateAudio(nextModel.defaultGenerateAudio);
        }
        setInputMode(resolveDefaultVideoCreateInputMode(nextModel));
        setInputImages([]);
        setSelectedHistoryIds([]);
        setCapabilitiesError(null);
        setCapabilitiesStatus("ready");
      } catch (caught) {
        if (unmounted) return;
        setCapabilitiesStatus("error");
        setCapabilitiesError(
          timedOut
            ? "视频模型能力查询超时，请刷新后重试"
            : caught instanceof Error
              ? caught.message
              : "视频模型能力查询失败"
        );
      } finally {
        window.clearTimeout(timeoutId);
      }
    };

    void loadCapabilities();
    return () => {
      unmounted = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [
    initialSelection?.aspectRatio,
    initialSelection?.duration,
    initialSelection?.modelId,
    initialSelection?.resolution,
  ]);

  /** 切换真实模型时把时长、比例和分辨率收敛到该模型支持的取值。 */
  const onModelChange = (value: string) => {
    const next = models.find((item) => item.model === value);
    if (next) {
      setModelId(next.model);
      setDuration(next.durations[0] ?? duration);
      setAspectRatio(next.aspectRatios[0] ?? aspectRatio);
      setResolution(next.resolutions[0] ?? resolution);
      setGenerateAudio(next.defaultGenerateAudio);
      setInputMode(resolveDefaultVideoCreateInputMode(next));
      setInputImages([]);
      setSelectedHistoryIds([]);
    }
  };

  // 预估积分：与扣费侧同口径——模型族分辨率每秒价格 × 时长。
  // 纯函数复用，确保展示价 = 实扣价。必须在任何 early return
  // 之前无条件调用（React hooks 规则），故对 selectedModel 用可选链兜底。
  const creditsPerSecond = resolveVideoCreditsPerSecondByResolution(
    selectedModel?.model,
    resolution,
    pricing.creditsPerSecond
  );
  const estimatedCredits = useMemo(() => {
    return getVideoCreditCost({
      durationSeconds: duration,
      creditsPerSecond,
    });
  }, [creditsPerSecond, duration]);

  // 各视频模型（族 × 分辨率 × 时长）的积分消耗对照表与上方预估、扣费侧同口径，
  // 用户选模型前即可比价。
  // 必须在 early return 之前无条件调用(hooks 规则)。
  const pricingTable = useMemo(
    () =>
      models.map((item) => {
        return {
          model: item.model,
          label: item.label,
          resolutionRows: item.resolutions.map((outputResolution) => {
            const creditsPerSecond = resolveVideoCreditsPerSecondByResolution(
              item.model,
              outputResolution,
              pricing.creditsPerSecond
            );
            return {
              outputResolution,
              creditsPerSecond,
              durations: item.durations.map((seconds) => ({
                seconds,
                credits: getVideoCreditCost({
                  durationSeconds: seconds,
                  creditsPerSecond,
                }),
              })),
            };
          }),
        };
      }),
    [models, pricing]
  );

  if (!selectedModel) {
    return (
      <div
        className="rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground"
        role="status"
      >
        {capabilitiesStatus === "loading"
          ? "正在加载可用视频模型…"
          : (capabilitiesError ?? "当前分组没有可用视频模型")}
      </div>
    );
  }

  const inputLimits = resolveVideoCreateInputLimits(selectedModel, inputMode);
  const maxInputImages = inputLimits.selectableMax;
  const maxMediaInputMegabytes =
    selectedModel.maxMediaInputBytes / (1024 * 1024);
  const busy = status === "running";
  const controlsDisabled = busy || capabilitiesStatus !== "ready";

  /** 切换一张近期图片作为视频输入，并保持输入数量与当前模型上限一致。 */
  const toggleHistoryImage = async (item: VideoHistoryItem) => {
    if (!item.imageUrl || busy || capabilitiesStatus !== "ready") return;
    if (selectedHistoryIds.includes(item.id)) {
      const index = selectedHistoryIds.indexOf(item.id);
      setSelectedHistoryIds((current) =>
        current.filter((id) => id !== item.id)
      );
      setInputImages((current) =>
        current.filter((_, imageIndex) => imageIndex !== index)
      );
      return;
    }
    if (inputImages.length >= maxInputImages) return;
    try {
      const dataUrl = await urlToDataUrl(item.imageUrl);
      setInputImages((current) => [...current, dataUrl]);
      setSelectedHistoryIds((current) => [...current, item.id]);
    } catch {
      setSelectedHistoryIds([]);
      setInputImages([]);
      setError("近期图片读取失败，请重新选择");
    }
  };

  const modeLabel =
    inputImages.length === 0
      ? "文生视频"
      : inputMode === "references"
        ? "参考图生视频"
        : "首尾帧生视频";

  const generate = async () => {
    if (
      !prompt.trim() ||
      status === "running" ||
      capabilitiesStatus !== "ready"
    )
      return;
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
          model: selectedModel.model,
          duration,
          aspectRatio,
          resolution,
          ...(selectedModel.supportsAudio ? { generateAudio } : {}),
          ...(maxInputImages > 0 && inputImages.length > 0
            ? inputMode === "references"
              ? { referenceImages: inputImages }
              : {
                  firstFrame: inputImages[0],
                  ...(inputImages[1] ? { lastFrame: inputImages[1] } : {}),
                }
            : {}),
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
        if (task.status === "failed") {
          throw new Error(task.error ?? "视频生成失败");
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
        pollDelayMs = resolveNextVideoPollDelay(pollDelayMs);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "视频生成失败");
      setStatus("error");
    }
  };

  return (
    <div className="flex flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-background p-4 shadow-sm sm:p-5">
      <div className="order-3 grid gap-3 border-t border-border bg-muted/20 pt-4 sm:grid-cols-2 lg:grid-cols-5 sm:pt-5">
        <div className="sm:col-span-2 lg:col-span-5">
          <h2 className="text-sm font-semibold text-foreground">生成设置</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            选择模型、视频时长、画面比例和输出分辨率。
          </p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            模型
          </Label>
          <Select
            value={modelId}
            onValueChange={onModelChange}
            disabled={controlsDisabled}
          >
            <SelectTrigger className="w-full bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((item) => (
                <SelectItem key={item.model} value={item.model}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            时长
          </Label>
          <Select
            value={String(duration)}
            onValueChange={(value) => setDuration(Number(value))}
            disabled={controlsDisabled}
          >
            <SelectTrigger className="w-full bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {selectedModel.durations.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {value}s
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            画面比例
          </Label>
          <Select
            value={aspectRatio}
            onValueChange={setAspectRatio}
            disabled={controlsDisabled}
          >
            <SelectTrigger className="w-full bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {selectedModel.aspectRatios.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            分辨率
          </Label>
          <Select
            value={resolution}
            onValueChange={setResolution}
            disabled={controlsDisabled}
          >
            <SelectTrigger className="w-full bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {selectedModel.resolutions.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {selectedModel.supportsAudio && (
        <div className="order-4 flex items-center gap-2 rounded-xl border border-border bg-muted/20 px-3 py-2">
          <Switch
            id="video-generate-audio"
            checked={generateAudio}
            onCheckedChange={setGenerateAudio}
            disabled={controlsDisabled}
          />
          <Label htmlFor="video-generate-audio">生成声音</Label>
        </div>
      )}

      <div className="order-1 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label
            htmlFor="video-create-prompt"
            className="text-sm font-semibold text-foreground"
          >
            文字描述
          </Label>
          <span className="rounded-full border border-border bg-muted/45 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            {modeLabel}
          </span>
        </div>
        <Textarea
          id="video-create-prompt"
          placeholder="描述你想生成的视频画面、动作、镜头和声音。"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={controlsDisabled}
          rows={5}
          maxLength={32_000}
          className="min-h-32 resize-y rounded-xl border-input bg-muted/15 px-3 py-3 text-base leading-relaxed shadow-none focus-visible:bg-background"
        />
        <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span>支持描述主体、动作、运镜、光线和声音氛围。</span>
          <span className="shrink-0">{prompt.length}/32000</span>
        </div>
      </div>

      {(selectedModel.maxFrameImages > 0 ||
        selectedModel.maxReferenceImages > 0) && (
        <div className="order-2 space-y-3 border-t border-border/70 pt-3">
          {selectedModel.maxFrameImages > 0 &&
            selectedModel.maxReferenceImages > 0 && (
              <div className="max-w-xs space-y-1.5">
                <Label className="text-xs font-medium text-muted-foreground">
                  输入图用途
                </Label>
                <Select
                  value={inputMode}
                  onValueChange={(value: VideoCreateInputMode) => {
                    setInputMode(value);
                    setInputImages([]);
                    setSelectedHistoryIds([]);
                  }}
                  disabled={controlsDisabled}
                >
                  <SelectTrigger className="w-full bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="frames">首尾帧</SelectItem>
                    <SelectItem value="references">参考图</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          <Label className="text-xs font-medium text-muted-foreground">
            {inputMode === "references"
              ? `参考图（可选，模型上限 ${inputLimits.modelMax} 张；单次最多 ${maxInputImages} 张）`
              : `首尾帧（可选，最多 ${maxInputImages} 张，按选择顺序）`}
          </Label>
          <p className="text-xs text-muted-foreground">
            基础设施限制：所有媒体输入合计最多
            {selectedModel.maxMediaInputCount} 张、{maxMediaInputMegabytes} MB。
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full border-dashed bg-muted/20 px-3.5 hover:bg-muted/50"
            onClick={() =>
              document.getElementById("video-input-files")?.click()
            }
            disabled={controlsDisabled}
          >
            <ImagePlus className="mr-1.5 size-4" />
            上传输入图
          </Button>
          <input
            id="video-input-files"
            type="file"
            multiple={maxInputImages > 1}
            accept="image/png,image/jpeg,image/webp"
            disabled={controlsDisabled}
            className="sr-only"
            onChange={async (event) => {
              const files = Array.from(event.target.files ?? []).slice(
                0,
                maxInputImages
              );
              setInputImages(await Promise.all(files.map(fileToDataUrl)));
              setSelectedHistoryIds([]);
              event.target.value = "";
            }}
          />
          {inputImages.length > 0 && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              disabled={controlsDisabled}
              onClick={() => {
                setInputImages([]);
                setSelectedHistoryIds([]);
              }}
            >
              清除已选图片（{inputImages.length} 张）
            </button>
          )}
        </div>
      )}

      <div className="order-5 flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Coins className="size-3.5" />
            预计消耗
            <span className="font-medium text-foreground">
              {formatCredits(estimatedCredits)} 积分
            </span>
          </span>
          <span>
            {duration}s × {creditsPerSecond}/秒 · {selectedModel.model}
          </span>
        </div>
        <Button
          type="button"
          onClick={generate}
          disabled={controlsDisabled || !prompt.trim()}
          className="min-w-30"
        >
          {busy ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Video className="mr-2 size-4" />
          )}
          {busy ? "生成中" : "生成视频"}
        </Button>
      </div>

      <details
        open
        className="order-6 border-t border-border/70 pt-3 text-xs text-muted-foreground"
      >
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
                <tr key={item.model} className="border-b border-border/30">
                  <td className="whitespace-nowrap py-1 pr-4">{item.label}</td>
                  <td className="py-1">
                    <div className="space-y-1">
                      {item.resolutionRows.map((row) => (
                        <p key={row.outputResolution}>
                          {`${row.outputResolution}（${row.creditsPerSecond} 积分/秒）：`}
                          {row.durations
                            .map(
                              (durationRow) =>
                                `${durationRow.seconds}s = ${durationRow.credits}`
                            )
                            .join("　·　")}
                        </p>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1">
            计费口径：模型族对应分辨率的每秒积分 ×
            时长；未配置分组覆盖时继承全局模型价格，
            与实际扣费一致；比例不影响积分。
          </p>
        </div>
      </details>

      {capabilitiesStatus === "loading" && (
        <p className="order-7 text-sm text-muted-foreground" role="status">
          正在同步当前分组的视频模型能力…
        </p>
      )}
      {capabilitiesStatus === "error" && capabilitiesError && (
        <p
          className="order-7 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {capabilitiesError}
        </p>
      )}

      {status === "running" && (
        <p className="order-7 animate-pulse text-sm text-muted-foreground motion-reduce:animate-none">
          视频生成中，可能需要数分钟，请保持页面打开…
        </p>
      )}
      {status === "error" && error && (
        <p className="order-7 animate-in fade-in rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive motion-reduce:animate-none">
          {error}
        </p>
      )}
      {status === "done" && videoUrl && (
        <video
          src={videoUrl}
          controls
          className="order-8 w-full max-w-3xl rounded-xl border border-border bg-black animate-in fade-in zoom-in-95 duration-400 motion-reduce:animate-none"
        >
          <track kind="captions" />
        </video>
      )}

      <section
        className="order-9 border-t border-border pt-4"
        aria-labelledby="video-recent-images-title"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2
            id="video-recent-images-title"
            className="text-sm font-semibold text-foreground"
          >
            最近图片
          </h2>
          <span className="text-xs text-muted-foreground">
            点击图片即可添加为视频输入
          </span>
        </div>
        {historyImages.length === 0 ? (
          <div className="flex min-h-36 flex-col items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            <ImageIcon className="mb-2 size-7" />
            暂无可用图片
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {historyImages.slice(0, 6).map((item) => {
              const selected = selectedHistoryIds.includes(item.id);
              const inputLimitReached = inputImages.length >= maxInputImages;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`group relative aspect-square overflow-hidden rounded-lg border bg-muted text-left outline-none transition hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
                    selected ? "border-primary ring-1 ring-primary" : ""
                  }`}
                  onClick={() => void toggleHistoryImage(item)}
                  disabled={
                    controlsDisabled ||
                    (inputLimitReached && !selected) ||
                    maxInputImages === 0
                  }
                  aria-label={
                    selected ? "取消视频输入图片" : "添加为视频输入图片"
                  }
                  title={
                    selected
                      ? "取消此视频输入图片"
                      : inputLimitReached
                        ? `最多添加 ${maxInputImages} 张输入图`
                        : "添加为视频输入图片"
                  }
                >
                  {/* 历史缩略图使用本站已生成图。 */}
                  {/* biome-ignore lint/performance/noImgElement: 简单缩略图选择器 */}
                  <img
                    src={item.imageUrl ?? ""}
                    alt="近期生成图片"
                    className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                  />
                  <span className="absolute inset-x-0 bottom-0 bg-background/90 px-2 py-1 text-center text-[11px] font-medium text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    {selected ? "取消输入图" : "作为视频输入"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
