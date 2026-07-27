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

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";
import {
  AUTO_IMAGE_SIZE,
  DEFAULT_IMAGE_MODEL,
  getImageCreditCost,
} from "@/features/image-generation/resolution";

import {
  buildImageEditRequestBody,
  buildImageGenerateRequestBody,
  IMAGE_CREATE_REQUEST_HEADERS,
} from "./image-create-request";
import {
  collectImageUrls,
  getConsumedCredits,
  getResponseError,
  readGenerationResponse,
} from "./image-create-response";
import { SimpleImageCreatePanel } from "./simple-image-create-panel";

type ImageCreateMode = "generate" | "edit" | "mask";

type RecentImage = {
  id: string;
  imageUrl: string | null;
  prompt: string;
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
  maxUploadBytes: number;
  moderationEnabled: boolean;
  onCreditsConsumed: (credits: number) => void;
  recent: RecentImage[];
  selectedBackendGroupId: string | null;
  initialSelection?: {
    groupId: string;
    modelId: string;
  } | null;
};

/** 将字节数格式化为面向用户的 MB 限制。 */
function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.floor(bytes / (1024 * 1024)))} MB`;
}

/** 检查上传文件是否为允许的图片且未超过套餐单文件限制。 */
function validateImageFile(file: File, maxFileSizeBytes: number): void {
  if (file.size <= 0) throw new Error("图片文件不能为空");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("仅支持 PNG、JPEG 或 WebP 图片");
  }
  if (file.size > maxFileSizeBytes) {
    throw new Error(`单张图片不能超过 ${formatMegabytes(maxFileSizeBytes)}`);
  }
}

/** 校验来源图片与蒙版的合计大小，提前对齐服务端套餐上传上限。 */
function validateTotalUploadSize(
  files: readonly File[],
  mask: File | null,
  maxUploadBytes: number
): void {
  const totalBytes =
    files.reduce((total, file) => total + file.size, 0) + (mask?.size ?? 0);
  if (totalBytes > maxUploadBytes) {
    throw new Error(`全部图片合计不能超过 ${formatMegabytes(maxUploadBytes)}`);
  }
}

/** 根据可信 MIME 类型生成近期图片转 File 时使用的扩展名。 */
function getImageFileExtension(type: string): string {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  return "png";
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
  maxUploadBytes,
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
  const [size, setSize] = useState(AUTO_IMAGE_SIZE);
  const [quality, setQuality] = useState("auto");
  const [background, setBackground] = useState("auto");
  const [sourceImages, setSourceImages] = useState<File[]>([]);
  const [mask, setMask] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultUrls, setResultUrls] = useState<string[]>([]);
  const [referenceLoadingId, setReferenceLoadingId] = useState<string | null>(
    null
  );

  useEffect(() => {
    if (!availableModels.some((item) => item.id === model)) {
      setModel(availableModels[0]?.id ?? DEFAULT_IMAGE_MODEL);
    }
  }, [availableModels, model]);

  const normalizedModel = model === "default" ? DEFAULT_IMAGE_MODEL : model;
  const maskAvailable = catalog.groups.some((group) =>
    group.models.some((item) => item.capabilities.mask)
  );
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

  /** 为目标操作选择首个授权模型，并优先保留当前分组和当前模型。 */
  const selectModelForMode = (nextMode: ImageCreateMode): boolean => {
    const orderedGroups = [
      ...(selectedGroup ? [selectedGroup] : []),
      ...catalog.groups.filter((group) => group.id !== selectedGroup?.id),
    ];
    for (const group of orderedGroups) {
      const candidate =
        group.models.find(
          (item) => item.id === model && item.capabilities[nextMode]
        ) ?? group.models.find((item) => item.capabilities[nextMode]);
      if (!candidate) continue;
      setGroupId(group.id);
      setModel(candidate.id);
      return true;
    }
    return false;
  };

  /** 接收来源图片并在客户端校验，成功后原位切换到图生图。 */
  const changeSourceImages = (files: FileList | null) => {
    if (!files) return;
    try {
      const nextFiles = Array.from(files);
      for (const file of nextFiles) validateImageFile(file, maxFileSizeBytes);
      validateTotalUploadSize(nextFiles, null, maxUploadBytes);
      setSourceImages(nextFiles);
      setMask(null);
      setMode(nextFiles.length > 0 ? "edit" : "generate");
      selectModelForMode(nextFiles.length > 0 ? "edit" : "generate");
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
      const nextMode = sourceImages.length > 0 ? "edit" : "generate";
      setMode(nextMode);
      selectModelForMode(nextMode);
      return;
    }
    try {
      if (!maskAvailable) {
        throw new Error("当前套餐没有支持蒙版编辑的模型");
      }
      if (file.type !== "image/png") throw new Error("蒙版必须为 PNG 图片");
      validateImageFile(file, maxFileSizeBytes);
      validateTotalUploadSize(sourceImages, file, maxUploadBytes);
      setMask(file);
      setMode("mask");
      selectModelForMode("mask");
      setError(null);
    } catch (caught) {
      setMask(null);
      const nextMode = sourceImages.length > 0 ? "edit" : "generate";
      setMode(nextMode);
      selectModelForMode(nextMode);
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
    selectModelForMode("generate");
    setError(null);
  };

  /**
   * 读取站内近期成品并转成受本地上传边界约束的参考图。
   *
   * @param image 服务端签名后的当前用户近期图片。
   * @returns 成功加入统一表单返回 true；下载、类型或大小非法返回 false 并显示错误。
   */
  const selectRecentReference = async (image: RecentImage) => {
    if (busy || referenceLoadingId || !image.imageUrl) return false;
    setReferenceLoadingId(image.id);
    setError(null);
    try {
      const response = await fetch(image.imageUrl);
      if (!response.ok) throw new Error("近期图片读取失败，请刷新后重试");
      const blob = await response.blob();
      if (!["image/png", "image/jpeg", "image/webp"].includes(blob.type)) {
        throw new Error("近期图片不是可用的 PNG、JPEG 或 WebP 文件");
      }
      const safeId =
        image.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "image";
      const file = new File(
        [blob],
        `recent-${safeId}.${getImageFileExtension(blob.type)}`,
        { type: blob.type }
      );
      validateImageFile(file, maxFileSizeBytes);
      validateTotalUploadSize([file], null, maxUploadBytes);
      setSourceImages([file]);
      setMask(null);
      setMode("edit");
      selectModelForMode("edit");
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "近期图片添加失败");
      return false;
    } finally {
      setReferenceLoadingId(null);
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
      const requestFields = {
        generationId: crypto.randomUUID(),
        prompt: prompt.trim(),
        size,
        model,
        backendGroupId: selectedGroup.id,
        quality,
        background,
      };
      if (mode === "generate") {
        response = await fetch("/api/images/generate", {
          method: "POST",
          headers: {
            ...IMAGE_CREATE_REQUEST_HEADERS,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(buildImageGenerateRequestBody(requestFields)),
        });
      } else {
        const body = buildImageEditRequestBody({
          ...requestFields,
          images: sourceImages,
          mask,
        });
        response = await fetch("/api/images/edit", {
          method: "POST",
          headers: IMAGE_CREATE_REQUEST_HEADERS,
          body,
        });
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
      maskAvailable={maskAvailable}
      mode={mode}
      model={model}
      onBackgroundChange={setBackground}
      onMaskChange={changeMask}
      onModelSelectionChange={selectModelGroup}
      onPromptChange={setPrompt}
      onQualityChange={setQuality}
      onRecentReferenceSelect={selectRecentReference}
      onRemoveReference={removeReference}
      onSizeChange={setSize}
      onSourceImagesChange={changeSourceImages}
      onSubmit={submit}
      prompt={prompt}
      quality={quality}
      recent={recent}
      referenceLoadingId={referenceLoadingId}
      resultUrls={resultUrls}
      size={size}
      sourceImages={sourceImages}
    />
  );
}
