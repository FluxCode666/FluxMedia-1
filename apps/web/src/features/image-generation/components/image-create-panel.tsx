/**
 * 媒体创作页的图片生成与编辑面板。
 *
 * 职责：展示当前分组显式声明的图片模型，收集文生图、图生图和蒙版编辑输入，
 * 调用站内媒体 API，并展示本次产物。对话、Agent、waterfall 和可编辑文件能力不在
 * 本组件表达。使用方仅为 `CreatePageClient`。
 */

"use client";

import { formatCredits } from "@repo/shared/credits/format";
import type { ImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import { resolveImageCreditPricing } from "@repo/shared/image-backend/group-image-pricing";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { Textarea } from "@repo/ui/components/textarea";
import { ImageIcon, Loader2, Upload, WandSparkles } from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_SIZE,
  getImageCreditCost,
  IMAGE_RESOLUTION_PRESETS,
} from "@/features/image-generation/resolution";

type ImageCreateMode = "generate" | "edit" | "mask";

type RecentImage = {
  id: string;
  imageUrl: string | null;
  prompt: string;
  status: string;
};

type ImageCreatePanelProps = {
  balance: number;
  catalog: ImageGenerationModelCatalog;
  imageModelPricing: ImageCreditOverrides;
  imageModerationPricing: {
    imageModerationCredits: number;
    textModerationCredits: number;
  };
  maxFileSizeBytes: number;
  moderationEnabled: boolean;
  onCreditsConsumed: (credits: number) => void;
  recent: RecentImage[];
  selectedBackendGroupId: string | null;
  initialSelection?: {
    groupId: string;
    modelId: string;
  } | null;
};

const imageOutputSchema = z
  .object({
    imageUrl: z.string().url().optional(),
  })
  .passthrough();

const generationResultSchema = z
  .object({
    error: z.string().optional(),
    generationId: z.string().optional(),
    imageUrl: z.string().url().optional(),
    imageOutputs: z.array(imageOutputSchema).optional(),
    creditsConsumed: z.number().nonnegative().optional(),
  })
  .passthrough();

const generationResponseSchema = generationResultSchema.extend({
  results: z.array(generationResultSchema).optional(),
});

/** 将字节数格式化为面向用户的 MB 限制。 */
function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.floor(bytes / (1024 * 1024)))} MB`;
}

/** 从单次或批量响应中提取所有成功图片 URL。 */
function collectImageUrls(
  response: z.infer<typeof generationResponseSchema>
): string[] {
  const results = response.results ?? [response];
  const urls = results.flatMap((result) => [
    ...(result.imageUrl ? [result.imageUrl] : []),
    ...(result.imageOutputs ?? []).flatMap((output) =>
      output.imageUrl ? [output.imageUrl] : []
    ),
  ]);
  return Array.from(new Set(urls));
}

/** 从响应中返回首个稳定错误消息。 */
function getResponseError(
  response: z.infer<typeof generationResponseSchema>
): string | null {
  const results = response.results ?? [response];
  return results.find((result) => result.error)?.error ?? null;
}

/** 合计本次响应实际消耗的积分。 */
function getConsumedCredits(
  response: z.infer<typeof generationResponseSchema>
): number {
  const results = response.results ?? [response];
  return results.reduce(
    (total, result) => total + (result.creditsConsumed ?? 0),
    0
  );
}

/** 读取并校验站内媒体 API 的 JSON 响应。 */
async function readGenerationResponse(
  response: Response
): Promise<z.infer<typeof generationResponseSchema>> {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = generationResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      response.ok
        ? "图片服务返回了无效响应"
        : `请求失败 HTTP ${response.status}`
    );
  }
  if (!response.ok) {
    throw new Error(
      getResponseError(parsed.data) ?? `请求失败 HTTP ${response.status}`
    );
  }
  return parsed.data;
}

/** 检查上传文件是否为允许的图片且未超过套餐单文件限制。 */
function validateImageFile(file: File, maxFileSizeBytes: number): void {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("仅支持 PNG、JPEG 或 WebP 图片");
  }
  if (file.size > maxFileSizeBytes) {
    throw new Error(`单张图片不能超过 ${formatMegabytes(maxFileSizeBytes)}`);
  }
}

/**
 * 渲染媒体专用图片面板。
 *
 * @param props 分组模型目录、计价、上传限制和近期图片。
 * @returns 文生图、图生图与蒙版编辑表单及结果区域。
 */
export function ImageCreatePanel({
  balance,
  catalog,
  imageModelPricing,
  imageModerationPricing,
  maxFileSizeBytes,
  moderationEnabled,
  onCreditsConsumed,
  recent,
  selectedBackendGroupId,
  initialSelection = null,
}: ImageCreatePanelProps) {
  const initialGroup =
    catalog.groups.find((group) => group.id === initialSelection?.groupId) ??
    catalog.groups.find((group) => group.id === selectedBackendGroupId) ??
    catalog.groups.find((group) => group.isDefault) ??
    catalog.groups[0] ??
    null;
  const [mode, setMode] = useState<ImageCreateMode>("generate");
  const [groupId, setGroupId] = useState(initialGroup?.id ?? "");
  const selectedGroup =
    catalog.groups.find((group) => group.id === groupId) ?? initialGroup;
  const availableModels = useMemo(
    () =>
      (selectedGroup?.models ?? []).filter((model) =>
        Boolean(model.capabilities[mode])
      ),
    [mode, selectedGroup]
  );
  const [model, setModel] = useState(
    initialSelection?.modelId ?? availableModels[0]?.id ?? DEFAULT_IMAGE_MODEL
  );
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState(DEFAULT_IMAGE_SIZE);
  const [quality, setQuality] = useState("auto");
  const [background, setBackground] = useState("auto");
  const [sourceImages, setSourceImages] = useState<File[]>([]);
  const [mask, setMask] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultUrls, setResultUrls] = useState<string[]>([]);

  useEffect(() => {
    if (!availableModels.some((item) => item.id === model)) {
      setModel(availableModels[0]?.id ?? DEFAULT_IMAGE_MODEL);
    }
  }, [availableModels, model]);

  const normalizedModel = model === "default" ? DEFAULT_IMAGE_MODEL : model;
  const estimatedCredits = getImageCreditCost(size, {
    basePricing: resolveImageCreditPricing({
      model: normalizedModel,
      global: imageModelPricing,
      group: selectedGroup?.imageCreditOverrides,
    }),
    moderationPricing: imageModerationPricing,
    textModerationCount: moderationEnabled ? 1 : 0,
    imageModerationCount:
      moderationEnabled && mode !== "generate" ? sourceImages.length : 0,
  });

  /** 切换媒体动作并清除不再适用的蒙版输入。 */
  const changeMode = (value: string) => {
    const nextMode = z.enum(["generate", "edit", "mask"]).safeParse(value);
    if (!nextMode.success) return;
    setMode(nextMode.data);
    if (nextMode.data !== "mask") setMask(null);
    setError(null);
  };

  /** 接收来源图片并在客户端执行基础类型和大小校验。 */
  const changeSourceImages = (files: FileList | null) => {
    if (!files) return;
    try {
      const nextFiles = Array.from(files);
      for (const file of nextFiles) validateImageFile(file, maxFileSizeBytes);
      setSourceImages(nextFiles);
      setError(null);
    } catch (caught) {
      setSourceImages([]);
      setError(caught instanceof Error ? caught.message : "图片校验失败");
    }
  };

  /** 接收单个 PNG 蒙版并校验基础边界，尺寸一致性由服务端复验。 */
  const changeMask = (file: File | null) => {
    if (!file) {
      setMask(null);
      return;
    }
    try {
      if (file.type !== "image/png") throw new Error("蒙版必须为 PNG 图片");
      validateImageFile(file, maxFileSizeBytes);
      setMask(file);
      setError(null);
    } catch (caught) {
      setMask(null);
      setError(caught instanceof Error ? caught.message : "蒙版校验失败");
    }
  };

  /** 提交文生图或编辑请求；成功后只保留站内返回的媒体 URL。 */
  const submit = async () => {
    if (busy) return;
    if (!prompt.trim()) {
      setError("请输入图片描述");
      return;
    }
    if (mode !== "generate" && sourceImages.length === 0) {
      setError("图生图或蒙版编辑至少需要一张来源图片");
      return;
    }
    if (mode === "mask" && !mask) {
      setError("蒙版编辑需要上传 PNG 蒙版");
      return;
    }
    if (!selectedGroup || availableModels.length === 0) {
      setError("当前分组没有支持此图片操作的后端模型");
      return;
    }

    setBusy(true);
    setError(null);
    setResultUrls([]);
    try {
      let response: Response;
      if (mode === "generate") {
        response = await fetch("/api/images/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            generationId: crypto.randomUUID(),
            prompt: prompt.trim(),
            size,
            model,
            backendGroupId: selectedGroup.id,
            quality,
            background,
          }),
        });
      } else {
        const body = new FormData();
        body.set("generationId", crypto.randomUUID());
        body.set("prompt", prompt.trim());
        body.set("size", size);
        body.set("model", model);
        body.set("backendGroupId", selectedGroup.id);
        body.set("quality", quality);
        body.set("background", background);
        for (const image of sourceImages) body.append("image[]", image);
        if (mask) body.set("mask", mask);
        response = await fetch("/api/images/edit", { method: "POST", body });
      }

      const payload = await readGenerationResponse(response);
      const payloadError = getResponseError(payload);
      if (payloadError) throw new Error(payloadError);
      const urls = collectImageUrls(payload);
      if (urls.length === 0) throw new Error("图片任务未返回可展示产物");
      setResultUrls(urls);
      onCreditsConsumed(getConsumedCredits(payload));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片生成失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card>
        <CardHeader>
          <CardTitle>图片创作</CardTitle>
          <CardDescription>
            使用同一媒体号池完成文生图、图生图和蒙版编辑。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Tabs value={mode} onValueChange={changeMode}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="generate">文生图</TabsTrigger>
              <TabsTrigger value="edit">图生图</TabsTrigger>
              <TabsTrigger value="mask">蒙版编辑</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>后端分组</Label>
              <Select
                value={groupId}
                onValueChange={setGroupId}
                disabled={busy}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择分组" />
                </SelectTrigger>
                <SelectContent>
                  {catalog.groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>模型</Label>
              <Select value={model} onValueChange={setModel} disabled={busy}>
                <SelectTrigger>
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.id === "default" ? DEFAULT_IMAGE_MODEL : item.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="image-prompt">图片描述</Label>
            <Textarea
              id="image-prompt"
              rows={6}
              maxLength={32_000}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="描述画面、构图、光线和风格"
              disabled={busy}
            />
            <p className="text-right text-xs text-muted-foreground">
              {prompt.length}/32000
            </p>
          </div>

          {mode !== "generate" && (
            <div className="space-y-3 rounded-lg border border-dashed p-4">
              <Label
                htmlFor="source-images"
                className="flex items-center gap-2"
              >
                <Upload className="size-4" /> 来源图片
              </Label>
              <Input
                id="source-images"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                disabled={busy}
                onChange={(event) => changeSourceImages(event.target.files)}
              />
              {sourceImages.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  已选择 {sourceImages.length} 张：
                  {sourceImages.map((file) => file.name).join("、")}
                </p>
              )}
              {mode === "mask" && (
                <div className="space-y-2 pt-2">
                  <Label htmlFor="mask-image">PNG 蒙版</Label>
                  <Input
                    id="mask-image"
                    type="file"
                    accept="image/png"
                    disabled={busy}
                    onChange={(event) =>
                      changeMask(event.target.files?.[0] ?? null)
                    }
                  />
                </div>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>尺寸</Label>
              <Select value={size} onValueChange={setSize} disabled={busy}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IMAGE_RESOLUTION_PRESETS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label} · {item.detail}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>质量</Label>
              <Select
                value={quality}
                onValueChange={setQuality}
                disabled={busy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["auto", "low", "medium", "high"].map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>背景</Label>
              <Select
                value={background}
                onValueChange={setBackground}
                disabled={busy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">自动</SelectItem>
                  <SelectItem value="opaque">不透明</SelectItem>
                  <SelectItem value="transparent">透明</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="text-sm text-muted-foreground">
              预计 {formatCredits(estimatedCredits)} 积分 · 余额{" "}
              {formatCredits(balance)}
            </div>
            <Button
              onClick={submit}
              disabled={busy || availableModels.length === 0}
            >
              {busy ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <WandSparkles className="mr-2 size-4" />
              )}
              {busy ? "生成中" : "开始创作"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">本次结果</CardTitle>
          </CardHeader>
          <CardContent>
            {resultUrls.length === 0 ? (
              <div className="flex min-h-52 flex-col items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                <ImageIcon className="mb-2 size-8" />
                生成结果会显示在这里
              </div>
            ) : (
              <div className="grid gap-3">
                {resultUrls.map((url) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer">
                    <Image
                      src={url}
                      alt="生成图片"
                      width={640}
                      height={640}
                      unoptimized
                      className="h-auto w-full rounded-lg border object-cover"
                    />
                  </a>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">最近图片</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无图片记录</p>
            ) : (
              recent.slice(0, 6).map((item) => (
                <div key={item.id} className="flex items-center gap-3">
                  {item.imageUrl ? (
                    <Image
                      src={item.imageUrl}
                      alt={item.prompt}
                      width={56}
                      height={56}
                      unoptimized
                      className="size-14 rounded-md border object-cover"
                    />
                  ) : (
                    <div className="flex size-14 items-center justify-center rounded-md border bg-muted">
                      <ImageIcon className="size-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{item.prompt}</p>
                    <Badge variant="secondary" className="mt-1">
                      {item.status}
                    </Badge>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
