/**
 * 简易生图页的图片生成与编辑状态容器。
 *
 * 职责：展示当前分组显式声明的图片模型，收集文生图、图生图和蒙版编辑输入，
 * 调用站内媒体 API，并展示本次产物。对话、Agent、waterfall 和可编辑文件能力不在
 * 本组件表达。使用方仅为 `GeneratePageClient`。
 */

"use client";

import type { ImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import { resolveImageCreditPricing } from "@repo/shared/image-backend/group-image-pricing";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_SIZE,
  getImageCreditCost,
} from "@/features/image-generation/resolution";

import { SimpleImageCreatePanel } from "./simple-image-create-panel";

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
 * 渲染简易生图状态容器。
 *
 * @param props 分组模型目录、计价、上传限制和近期图片。
 * @returns 旧版统一视觉下的文生图、图生图与蒙版编辑表单及结果区域。
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

  /** 接收来源图片并在客户端校验，成功后原位切换到图生图。 */
  const changeSourceImages = (files: FileList | null) => {
    if (!files) return;
    try {
      const nextFiles = Array.from(files);
      for (const file of nextFiles) validateImageFile(file, maxFileSizeBytes);
      setSourceImages(nextFiles);
      setMask(null);
      setMode(nextFiles.length > 0 ? "edit" : "generate");
      setError(null);
    } catch (caught) {
      setSourceImages([]);
      setMask(null);
      setMode("generate");
      setError(caught instanceof Error ? caught.message : "图片校验失败");
    }
  };

  /** 接收单个 PNG 蒙版并校验基础边界，尺寸一致性由服务端复验。 */
  const changeMask = (file: File | null) => {
    if (!file) {
      setMask(null);
      setMode(sourceImages.length > 0 ? "edit" : "generate");
      return;
    }
    try {
      if (file.type !== "image/png") throw new Error("蒙版必须为 PNG 图片");
      validateImageFile(file, maxFileSizeBytes);
      setMask(file);
      setMode("mask");
      setError(null);
    } catch (caught) {
      setMask(null);
      setMode(sourceImages.length > 0 ? "edit" : "generate");
      setError(caught instanceof Error ? caught.message : "蒙版校验失败");
    }
  };

  /** 同时切换授权分组和模型，避免两个独立下拉产生短暂非法组合。 */
  const selectModelGroup = (nextGroupId: string, modelId: string) => {
    setGroupId(nextGroupId);
    setModel(modelId);
    setError(null);
  };

  /** 移除来源图及其蒙版，并把统一表单恢复为文生图。 */
  const removeReference = () => {
    setSourceImages([]);
    setMask(null);
    setMode("generate");
    setError(null);
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
    <SimpleImageCreatePanel
      balance={balance}
      background={background}
      busy={busy}
      catalog={catalog}
      error={error}
      estimatedCredits={estimatedCredits}
      groupId={groupId}
      hasAvailableModel={availableModels.length > 0}
      mask={mask}
      mode={mode}
      model={model}
      onBackgroundChange={setBackground}
      onMaskChange={changeMask}
      onModelSelectionChange={selectModelGroup}
      onPromptChange={setPrompt}
      onQualityChange={setQuality}
      onRemoveReference={removeReference}
      onSizeChange={setSize}
      onSourceImagesChange={changeSourceImages}
      onSubmit={submit}
      prompt={prompt}
      quality={quality}
      recent={recent}
      resultUrls={resultUrls}
      size={size}
      sourceImages={sourceImages}
    />
  );
}
