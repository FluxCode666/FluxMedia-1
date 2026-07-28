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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";
import type { ReferenceHandoffIntent } from "@/features/image-generation/reference-handoff";
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

const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
const REFERENCE_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;
type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

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
  maxEditImages: number;
  moderationEnabled: boolean;
  onCreditsConsumed: (credits: number) => void;
  recent: RecentImage[];
  selectedBackendGroupId: string | null;
  initialSelection?: {
    groupId: string;
    modelId: string;
  } | null;
  initialReference?: ReferenceHandoffIntent | null;
  onInitialReferenceConsumed?: () => void;
};

type ReferenceImageSource = {
  imageUrl: string;
  retryHint: string;
  sourceName: string;
};

type InitialReferenceLoad = {
  controller: AbortController;
  id: string;
  promise: Promise<File>;
  settled: boolean;
};

/** 将字节数格式化为面向用户的 MB 限制。 */
function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.floor(bytes / (1024 * 1024)))} MB`;
}

/** 构造浏览器会话内稳定的文件指纹，用于避免误重复添加同一参考图。 */
function getReferenceFileFingerprint(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.type}\u0000${file.lastModified}`;
}

/** 将浏览器或文件元数据中的 MIME 字符串收窄为支持的图片类型。 */
function isSupportedImageType(value: string): value is SupportedImageType {
  return SUPPORTED_IMAGE_TYPES.some((type) => type === value);
}

/**
 * 将跨浏览器或 jsdom Realm 抛出的中止异常识别为 AbortError。
 *
 * @param value fetch 或响应流抛出的未知异常。
 * @returns 异常对象声明 name=AbortError 时返回 true。
 * @sideEffects 无。
 * @failure 非对象或无 name 字段时安全返回 false。
 */
function isAbortError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    value.name === "AbortError"
  );
}

/** 检查上传文件是否为允许的图片且未超过套餐单文件限制。 */
function validateImageFile(file: File, maxFileSizeBytes: number): void {
  if (file.size <= 0) throw new Error("图片文件不能为空");
  if (!isSupportedImageType(file.type)) {
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
function getImageFileExtension(type: SupportedImageType): string {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  return "png";
}

/**
 * 将不可信来源名称收窄为浏览器 File 可用的安全文件名。
 *
 * @param sourceName 图库元数据或近期记录生成的原始名称。
 * @param type 已验证的图片 MIME 类型。
 * @returns 去除路径与控制字符、长度受限且扩展名匹配 MIME 的文件名。
 * @sideEffects 无。
 * @failure 名称清理后为空时回退为 reference。
 */
function createReferenceFileName(
  sourceName: string,
  type: SupportedImageType
): string {
  const extension = getImageFileExtension(type);
  const normalized = [...sourceName.trim()]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return character === "/" ||
        character === "\\" ||
        codePoint < 32 ||
        codePoint === 127
        ? "-"
        : character;
    })
    .join("")
    .replace(/\.(?:png|jpe?g|webp)$/i, "")
    .slice(0, 120);
  return `${normalized || "reference"}.${extension}`;
}

/**
 * 在构造 Blob 前按上传上限读取响应流，避免超限媒体先完整占用浏览器内存。
 *
 * @param response 已成功返回且由站内存储提供的图片响应。
 * @param maxBytes 当前套餐单文件与总上传限制中的较小值。
 * @returns MIME 已收窄、大小未超过上限的图片 Blob。
 * @sideEffects 消费响应体；超限时主动取消剩余响应流。
 * @failure MIME 非法、响应为空或流式读取超限时抛出面向用户的错误。
 */
async function readReferenceImageBlob(
  response: Response,
  maxBytes: number
): Promise<Blob> {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (!contentType || !isSupportedImageType(contentType)) {
    throw new Error("参考图片不是可用的 PNG、JPEG 或 WebP 文件");
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("参考图片超过当前套餐上传限制");
  }

  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > maxBytes) {
      throw new Error("参考图片超过当前套餐上传限制");
    }
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("参考图片超过当前套餐上传限制");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: contentType });
}

/**
 * 下载一张参考图并复用本地上传的 MIME、单文件和总大小边界。
 *
 * @param source 已由调用方授权或由服务端返回的图片来源。
 * @param maxFileSizeBytes 套餐允许的单文件字节上限。
 * @param maxUploadBytes 套餐允许的请求总上传字节上限。
 * @param abortController 初始交接可传入控制器，以便用户操作使旧下载失效。
 * @returns 可直接加入 multipart 编辑请求的浏览器 File。
 * @sideEffects 发起一次图片 GET；跨站来源不会携带浏览器凭据。
 * @failure 下载失败、超时、类型非法、空文件或超限时抛出面向用户的错误。
 */
async function loadReferenceImageFile(
  source: ReferenceImageSource,
  maxFileSizeBytes: number,
  maxUploadBytes: number,
  abortController = new AbortController()
): Promise<File> {
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, REFERENCE_IMAGE_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(source.imageUrl, {
      credentials: "same-origin",
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new Error(`参考图片读取失败，${source.retryHint}`);
    }
    const blob = await readReferenceImageBlob(
      response,
      Math.min(maxFileSizeBytes, maxUploadBytes)
    );
    if (!isSupportedImageType(blob.type)) {
      throw new Error("参考图片不是可用的 PNG、JPEG 或 WebP 文件");
    }
    const file = new File(
      [blob],
      createReferenceFileName(source.sourceName, blob.type),
      { type: blob.type }
    );
    validateImageFile(file, maxFileSizeBytes);
    validateTotalUploadSize([file], null, maxUploadBytes);
    return file;
  } catch (caught) {
    if (timedOut && isAbortError(caught)) {
      throw new Error(`参考图片读取超时，${source.retryHint}`);
    }
    throw caught;
  } finally {
    window.clearTimeout(timeoutId);
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
  maxUploadBytes,
  maxEditImages,
  moderationEnabled,
  onCreditsConsumed,
  recent,
  selectedBackendGroupId,
  initialSelection = null,
  initialReference = null,
  onInitialReferenceConsumed,
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
  const initialReferenceLoadRef = useRef<InitialReferenceLoad | null>(null);
  const consumedInitialReferenceIdRef = useRef<string | null>(null);

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
  const selectModelForMode = useCallback(
    (nextMode: ImageCreateMode): boolean => {
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
    },
    [catalog.groups, model, selectedGroup]
  );

  /**
   * 最多消费一次指定图库交接，避免失效与 Promise finally 重复清理 URL。
   *
   * @param referenceId 一次性交接的稳定意图 ID。
   * @returns 无。
   * @sideEffects 首次消费时调用父组件的 URL 清理回调。
   * @failure 回调缺失或 ID 已消费时安全返回。
   */
  const consumeInitialReference = useCallback(
    (referenceId: string): void => {
      if (consumedInitialReferenceIdRef.current === referenceId) return;
      consumedInitialReferenceIdRef.current = referenceId;
      onInitialReferenceConsumed?.();
    },
    [onInitialReferenceConsumed]
  );

  /**
   * 使仍在下载的初始交接失效，保证后续用户操作拥有最后写入权。
   *
   * @returns 无。
   * @sideEffects 中止下载、清除加载状态并消费一次性交接 URL。
   * @failure 没有活动下载或下载已结束时安全返回。
   */
  const invalidateInitialReferenceLoad = useCallback((): void => {
    const load = initialReferenceLoadRef.current;
    if (!load || load.settled) return;
    load.settled = true;
    load.controller.abort();
    setReferenceLoadingId(null);
    consumeInitialReference(load.id);
  }, [consumeInitialReference]);

  useEffect(() => {
    if (!initialReference) return;

    let load = initialReferenceLoadRef.current;
    if (!load || load.id !== initialReference.id) {
      const controller = new AbortController();
      load = {
        controller,
        id: initialReference.id,
        promise: loadReferenceImageFile(
          {
            imageUrl: initialReference.imageUrl,
            retryHint: "请返回图库后重试",
            sourceName: initialReference.sourceName,
          },
          maxFileSizeBytes,
          maxUploadBytes,
          controller
        ),
        settled: false,
      };
      initialReferenceLoadRef.current = load;
    }
    if (load.settled) return;

    let active = true;
    setReferenceLoadingId(initialReference.sourceId);
    setError(null);
    void load.promise
      .then((file) => {
        if (
          !active ||
          load.settled ||
          initialReferenceLoadRef.current !== load
        ) {
          return;
        }
        load.settled = true;
        setSourceImages([file]);
        setMask(null);
        setMode("edit");
        if (!selectModelForMode("edit")) {
          setError("当前套餐没有支持图生图的模型");
        }
      })
      .catch((caught: unknown) => {
        if (
          !active ||
          load.settled ||
          initialReferenceLoadRef.current !== load
        ) {
          return;
        }
        load.settled = true;
        setError(
          caught instanceof Error ? caught.message : "图库参考图加载失败"
        );
      })
      .finally(() => {
        if (!active || initialReferenceLoadRef.current !== load) return;
        setReferenceLoadingId(null);
        consumeInitialReference(load.id);
      });

    return () => {
      active = false;
    };
  }, [
    initialReference,
    consumeInitialReference,
    maxFileSizeBytes,
    maxUploadBytes,
    selectModelForMode,
  ]);

  /** 追加来源图片并在客户端校验，失败时保留已经选择的参考图。 */
  const changeSourceImages = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    invalidateInitialReferenceLoad();
    try {
      const knownFiles = new Set(sourceImages.map(getReferenceFileFingerprint));
      const addedFiles = Array.from(files).filter((file) => {
        const fingerprint = getReferenceFileFingerprint(file);
        if (knownFiles.has(fingerprint)) return false;
        knownFiles.add(fingerprint);
        return true;
      });
      if (addedFiles.length === 0) {
        throw new Error("所选图片已在参考图中");
      }
      const nextFiles = [...sourceImages, ...addedFiles];
      if (nextFiles.length > maxEditImages) {
        throw new Error(`参考图最多可添加 ${maxEditImages} 张`);
      }
      for (const file of addedFiles) validateImageFile(file, maxFileSizeBytes);
      validateTotalUploadSize(nextFiles, null, maxUploadBytes);
      setSourceImages(nextFiles);
      setMask(null);
      setMode("edit");
      selectModelForMode("edit");
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片校验失败");
    }
  };

  /** 删除单张参考图；移除主参考图时同时清理与其像素坐标绑定的蒙版。 */
  const removeSourceImage = (index: number) => {
    if (busy || index < 0 || index >= sourceImages.length) return;
    const nextFiles = sourceImages.filter(
      (_file, candidateIndex) => candidateIndex !== index
    );
    const nextMask = index === 0 ? null : mask;
    setSourceImages(nextFiles);
    setMask(nextMask);
    const nextMode =
      nextFiles.length === 0 ? "generate" : nextMask ? "mask" : "edit";
    setMode(nextMode);
    selectModelForMode(nextMode);
    setError(null);
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
    invalidateInitialReferenceLoad();
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
    if (sourceImages.length >= maxEditImages) {
      setError(`参考图最多可添加 ${maxEditImages} 张`);
      return false;
    }
    setReferenceLoadingId(image.id);
    setError(null);
    try {
      const safeId =
        image.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "image";
      const file = await loadReferenceImageFile(
        {
          imageUrl: image.imageUrl,
          retryHint: "请刷新后重试",
          sourceName: `recent-${safeId}`,
        },
        maxFileSizeBytes,
        maxUploadBytes
      );
      const nextFiles = [...sourceImages, file];
      if (nextFiles.length > maxEditImages) {
        throw new Error(`参考图最多可添加 ${maxEditImages} 张`);
      }
      validateTotalUploadSize(nextFiles, null, maxUploadBytes);
      setSourceImages(nextFiles);
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
    if (busy || referenceLoadingId) return;
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
      maxEditImages={maxEditImages}
      maxUploadBytes={maxUploadBytes}
      mode={mode}
      model={model}
      onBackgroundChange={setBackground}
      onMaskChange={changeMask}
      onModelSelectionChange={selectModelGroup}
      onPromptChange={setPrompt}
      onQualityChange={setQuality}
      onRecentReferenceSelect={selectRecentReference}
      onRemoveReference={removeReference}
      onRemoveSourceImage={removeSourceImage}
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
