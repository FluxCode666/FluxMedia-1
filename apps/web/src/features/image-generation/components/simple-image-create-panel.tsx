/**
 * 简易生图页的旧版统一视觉布局。
 *
 * 使用方是 `ImageCreatePanel` 的 simple 变体。本组件只负责呈现统一文字输入、参考图、
 * 模型与生成设置、结果和最近图片；模型权限、文件校验、计费与请求提交仍由父组件负责。
 */

"use client";

import { formatCredits } from "@repo/shared/credits/format";
import { Button } from "@repo/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@repo/ui/components/dialog";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Textarea } from "@repo/ui/components/textarea";
import { cn } from "@repo/ui/utils";
import {
  Brush,
  Coins,
  Eye,
  ImageIcon,
  ImagePlus,
  Loader2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";
import { getRecentImageDisplayUrl } from "@/features/image-generation/recent-image-display";
import { DEFAULT_IMAGE_MODEL } from "@/features/image-generation/resolution";

import { ImageGenerationResultGallery } from "./image-generation-result-gallery";
import { ImageMaskEditor } from "./image-mask-editor";
import { ImageSizePicker } from "./image-size-picker";

type ImageCreateMode = "generate" | "edit" | "mask";

type RecentImage = {
  id: string;
  imageUrl: string | null;
  prompt: string;
  status?: string;
};

type SimpleImageCreatePanelProps = {
  balance: number;
  background: string;
  busy: boolean;
  catalog: ImageGenerationModelCatalog;
  error: string | null;
  estimatedCredits: number;
  groupId: string;
  hasAvailableModel: boolean;
  mask: File | null;
  maskAvailable: boolean;
  maxEditImages: number;
  maxUploadBytes: number;
  mode: ImageCreateMode;
  model: string;
  supportsQuality?: boolean;
  supportsAutoSize?: boolean;
  onBackgroundChange: (value: string) => void;
  onMaskChange: (file: File | null) => void | Promise<void>;
  onModelSelectionChange: (groupId: string, modelId: string) => void;
  onPromptChange: (value: string) => void;
  onQualityChange: (value: string) => void;
  onRecentReferenceSelect: (image: RecentImage) => Promise<boolean>;
  onRemoveReference: () => void;
  onRemoveSourceImage: (index: number) => void;
  onSizeChange: (value: string) => void;
  onSourceImagesChange: (files: FileList | null) => void;
  onSubmit: () => Promise<void>;
  prompt: string;
  quality: string;
  recent: readonly RecentImage[];
  referenceLoadingId: string | null;
  resultUrls: readonly string[];
  size: string;
  sourceImages: readonly File[];
};

/** 为同一分组中的模型构造只在当前下拉生命周期内使用的稳定值。 */
function createModelSelectionValue(groupId: string, modelId: string): string {
  return `${groupId.length}:${groupId}${modelId}`;
}

/** 将当前动作映射为旧版统一表单右上角的模式标签。 */
function getModeLabel(mode: ImageCreateMode): string {
  if (mode === "mask") return "局部编辑";
  if (mode === "edit") return "图生图";
  return "文生图";
}

/** 将当前动作映射为提交按钮文案。 */
function getSubmitLabel(mode: ImageCreateMode): string {
  if (mode === "mask") return "生成局部编辑";
  if (mode === "edit") return "生成图生图";
  return "生成图片";
}

/** 为浏览器本地参考图建立可撤销的预览 URL，文件变化和卸载时立即释放。 */
function useSourcePreviews(files: readonly File[]): readonly string[] {
  const [previewUrls, setPreviewUrls] = useState<readonly string[]>([]);

  useEffect(() => {
    const nextUrls = files.map((file) => URL.createObjectURL(file));
    setPreviewUrls(nextUrls);
    return () => {
      for (const url of nextUrls) URL.revokeObjectURL(url);
    };
  }, [files]);

  return previewUrls;
}

/** 将上传字节数格式化为紧凑的 KB 或 MB 文案。 */
function formatUploadBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * 渲染旧版无模式 Tab 的统一生图表单。
 *
 * @param props 当前草稿、授权目录、回调和只读结果。
 * @returns 统一输入卡片，以及按纵向文档流排列的结果与近期图片。
 * @sideEffects 选择文件时打开系统文件选择器；提交时调用父组件提供的异步回调。
 * @failure 父组件交付的错误会以 `role=alert` 呈现，空目录会阻止提交。
 */
export function SimpleImageCreatePanel(props: SimpleImageCreatePanelProps) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const sourceInputRef = useRef<HTMLInputElement | null>(null);
  const maskInputRef = useRef<HTMLInputElement | null>(null);
  const dragEnterDepthRef = useRef(0);
  const sourcePreviewUrls = useSourcePreviews(props.sourceImages);
  const [maskEditorOpen, setMaskEditorOpen] = useState(false);
  const [isDraggingReference, setIsDraggingReference] = useState(false);
  const [imagePreview, setImagePreview] = useState<
    | { kind: "reference"; index: number }
    | { kind: "recent"; image: RecentImage }
    | null
  >(null);
  const selections = useMemo(
    () =>
      props.catalog.groups.flatMap((group) =>
        group.models
          .filter((item) => Boolean(item.capabilities[props.mode]))
          .map((item) => ({
            groupId: group.id,
            modelId: item.id,
            value: createModelSelectionValue(group.id, item.id),
          }))
      ),
    [props.catalog.groups, props.mode]
  );
  const selectionValue = createModelSelectionValue(props.groupId, props.model);
  const modeLabel = getModeLabel(props.mode);
  const submitLabel = getSubmitLabel(props.mode);
  const submitDisabled =
    props.busy ||
    Boolean(props.referenceLoadingId) ||
    !props.prompt.trim() ||
    !props.hasAvailableModel;
  const referenceInteractionLocked =
    props.busy || Boolean(props.referenceLoadingId);
  const referenceLimitReached =
    props.sourceImages.length >= props.maxEditImages;
  const referenceUploadDisabled =
    referenceInteractionLocked || referenceLimitReached;
  const selectedUploadBytes = props.sourceImages.reduce(
    (total, file) => total + file.size,
    0
  );
  const recentImages = useMemo(
    () =>
      props.recent
        .filter(
          (item) =>
            Boolean(item.imageUrl) ||
            item.status === "queued" ||
            item.status === "pending" ||
            item.status === "processing" ||
            item.status === "failed"
        )
        .slice(0, 12),
    [props.recent]
  );

  useEffect(() => {
    if (props.sourceImages.length === 0 || !props.maskAvailable) {
      setMaskEditorOpen(false);
    }
    if (
      imagePreview?.kind === "reference" &&
      imagePreview.index >= props.sourceImages.length
    ) {
      setImagePreview(null);
    }
  }, [imagePreview, props.maskAvailable, props.sourceImages.length]);

  const referencePreviewUrl =
    imagePreview?.kind === "reference"
      ? sourcePreviewUrls[imagePreview.index]
      : undefined;
  const activeImagePreview =
    imagePreview?.kind === "reference"
      ? referencePreviewUrl
        ? {
            src: referencePreviewUrl,
            alt: `图${imagePreview.index + 1}`,
            title: `预览图${imagePreview.index + 1}`,
            recent: false,
          }
        : null
      : imagePreview?.image.imageUrl
        ? {
            src: getRecentImageDisplayUrl(imagePreview.image.imageUrl),
            alt: imagePreview.image.prompt,
            title: "查看图片",
            recent: true,
          }
        : null;

  /** 只接受当前授权目录生成的下拉值，未知值不会改变父组件状态。 */
  function changeModelSelection(value: string): void {
    const selection = selections.find((item) => item.value === value);
    if (!selection) return;
    props.onModelSelectionChange(selection.groupId, selection.modelId);
  }

  /** 阻止浏览器原生提交并委托父组件执行媒体请求。 */
  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void props.onSubmit();
  }

  /** 文件进入输入卡片时显示明确投放反馈，并过滤文本等非文件拖拽。 */
  function handleReferenceDragEnter(event: React.DragEvent<HTMLElement>): void {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    dragEnterDepthRef.current += 1;
    if (!referenceInteractionLocked) setIsDraggingReference(true);
  }

  /** 允许浏览器把文件投放到卡片；禁用状态仍阻止浏览器直接打开图片。 */
  function handleReferenceDragOver(event: React.DragEvent<HTMLElement>): void {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = referenceUploadDisabled ? "none" : "copy";
  }

  /** 使用进入深度抵消子元素边界事件，避免投放蒙层在卡片内部闪烁。 */
  function handleReferenceDragLeave(event: React.DragEvent<HTMLElement>): void {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    dragEnterDepthRef.current = Math.max(0, dragEnterDepthRef.current - 1);
    if (dragEnterDepthRef.current === 0) setIsDraggingReference(false);
  }

  /** 将投放文件交给父级既有校验与状态切换链路。 */
  function handleReferenceDrop(event: React.DragEvent<HTMLElement>): void {
    event.preventDefault();
    dragEnterDepthRef.current = 0;
    setIsDraggingReference(false);
    if (referenceUploadDisabled || event.dataTransfer.files.length === 0) {
      return;
    }
    props.onSourceImagesChange(event.dataTransfer.files);
  }

  /** 将近期成品设为参考图，成功后返回统一输入卡片方便继续编辑。 */
  async function selectRecentReference(image: RecentImage): Promise<void> {
    const selected = await props.onRecentReferenceSelect(image);
    if (!selected) return;
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="space-y-8">
      <form ref={formRef} className="space-y-5" onSubmit={handleSubmit}>
        <section
          aria-busy={referenceInteractionLocked}
          aria-label="参考图拖拽上传区域"
          className={cn(
            "relative overflow-hidden rounded-2xl border border-border bg-background shadow-sm transition-[border-color,box-shadow]",
            isDraggingReference &&
              "border-primary shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_18%,transparent)]"
          )}
          onDragEnter={handleReferenceDragEnter}
          onDragLeave={handleReferenceDragLeave}
          onDragOver={handleReferenceDragOver}
          onDrop={handleReferenceDrop}
        >
          {isDraggingReference ? (
            <div
              className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center bg-background/92 px-6 text-center backdrop-blur-sm"
              role="status"
            >
              <span className="mb-3 flex size-12 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary shadow-sm">
                <Upload className="size-5" />
              </span>
              <span className="text-sm font-semibold text-foreground">
                {referenceLimitReached
                  ? `已达到 ${props.maxEditImages} 张参考图上限`
                  : props.sourceImages.length > 0
                    ? "松开即可继续添加参考图"
                    : "松开即可添加参考图"}
              </span>
              <span className="mt-1 text-xs text-muted-foreground">
                {referenceLimitReached
                  ? "请先移除一张参考图再继续添加"
                  : "支持 PNG、JPEG 和 WebP，可一次拖入多张"}
              </span>
            </div>
          ) : null}
          <div className="space-y-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label
                htmlFor="simple-image-prompt"
                className="text-sm font-semibold text-foreground"
              >
                文字描述
              </Label>
              <span className="rounded-full border border-border bg-muted/45 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                {modeLabel}
              </span>
            </div>
            <Textarea
              id="simple-image-prompt"
              rows={5}
              maxLength={32_000}
              value={props.prompt}
              onChange={(event) => props.onPromptChange(event.target.value)}
              placeholder="描述你想生成的画面；添加参考图后即可基于它继续创作。"
              disabled={props.busy}
              className="min-h-32 resize-y rounded-xl border-input bg-muted/15 px-3 py-3 text-base leading-relaxed shadow-none focus-visible:bg-background"
            />
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span>支持直接粘贴完整的画面、构图、光线和风格描述。</span>
              <span className="shrink-0">{props.prompt.length}/32000</span>
            </div>

            <div className="flex min-h-12 flex-wrap items-center gap-2 border-t border-border/70 pt-3">
              {props.sourceImages.length === 0 ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full border-dashed bg-muted/20 px-3.5 hover:bg-muted/50"
                    onClick={() => sourceInputRef.current?.click()}
                    disabled={referenceUploadDisabled}
                  >
                    <ImagePlus className="mr-1.5 size-4" />
                    添加参考图
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    可选。点击选择或拖拽到输入卡片，最多添加{" "}
                    {props.maxEditImages} 张。
                  </span>
                </>
              ) : (
                <div className="w-full space-y-2.5">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {props.sourceImages.map((file, index) => {
                      const previewUrl = sourcePreviewUrls[index];
                      const referenceLabel = `图${index + 1}`;
                      return (
                        <div
                          className="group relative aspect-square min-h-28 overflow-hidden rounded-xl border border-border bg-muted shadow-sm transition-shadow hover:shadow-md"
                          key={`${file.name}-${file.size}-${file.type}-${file.lastModified}`}
                          title={file.name}
                        >
                          <button
                            type="button"
                            className="absolute inset-0 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            onClick={() =>
                              setImagePreview({ kind: "reference", index })
                            }
                            aria-label={`放大预览${referenceLabel}`}
                          >
                            {previewUrl ? (
                              <Image
                                alt={`${referenceLabel}${index === 0 ? "（主参考图）" : ""}`}
                                className="object-cover transition duration-200 group-hover:scale-[1.03]"
                                fill
                                sizes="(max-width: 640px) 45vw, (max-width: 1024px) 30vw, 220px"
                                src={previewUrl}
                                unoptimized
                              />
                            ) : null}
                            <span className="absolute inset-x-0 bottom-0 truncate bg-background/88 px-2 py-1.5 text-left text-xs font-semibold text-foreground backdrop-blur-sm">
                              {referenceLabel}
                              {index === 0 ? " · 主参考图" : ""}
                            </span>
                          </button>
                          <Button
                            aria-label={`移除${referenceLabel}：${file.name}`}
                            className="absolute top-2 right-2 size-7 rounded-full border bg-background/92 p-0 opacity-100 shadow-sm sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                            disabled={referenceInteractionLocked}
                            onClick={() => props.onRemoveSourceImage(index)}
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                          >
                            <X className="size-3.5" />
                          </Button>
                        </div>
                      );
                    })}
                    {!referenceLimitReached ? (
                      <button
                        aria-label={`继续添加参考图，最多 ${props.maxEditImages} 张`}
                        className="flex aspect-square min-h-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/15 px-3 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={referenceInteractionLocked}
                        onClick={() => sourceInputRef.current?.click()}
                        type="button"
                      >
                        <ImagePlus className="size-5" />
                        <span>继续添加</span>
                      </button>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>
                      已添加 {props.sourceImages.length}/{props.maxEditImages}{" "}
                      张 · {formatUploadBytes(selectedUploadBytes)} /{" "}
                      {formatUploadBytes(props.maxUploadBytes)}
                      {props.sourceImages.length > 1
                        ? " · 第一张为主参考图"
                        : ""}
                    </span>
                    <Button
                      disabled={referenceInteractionLocked}
                      onClick={() => {
                        setMaskEditorOpen(false);
                        props.onRemoveReference();
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      清空全部
                    </Button>
                  </div>

                  <div className="hidden flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      onClick={() => setMaskEditorOpen((current) => !current)}
                      disabled={props.busy || !props.maskAvailable}
                      title={
                        props.maskAvailable
                          ? "在主参考图上涂抹需要编辑的区域"
                          : "当前没有支持蒙版编辑的模型"
                      }
                    >
                      <Brush className="mr-1.5 size-3.5" />
                      {maskEditorOpen ? "收起蒙版" : "绘制蒙版"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      onClick={() => maskInputRef.current?.click()}
                      disabled={props.busy || !props.maskAvailable}
                      title={
                        props.maskAvailable
                          ? "上传与主参考图尺寸一致的 PNG 蒙版"
                          : "当前没有支持蒙版编辑的模型"
                      }
                    >
                      <Upload className="mr-1.5 size-3.5" />
                      {props.mask ? "更换蒙版" : "上传蒙版"}
                    </Button>
                    {props.mask ? (
                      <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/25 p-1 pl-2">
                        <span
                          className="max-w-40 truncate text-[11px] font-medium text-foreground"
                          title="PNG 透明区域将作为模型编辑区域"
                        >
                          {props.mask.name}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => void props.onMaskChange(null)}
                          disabled={props.busy}
                          aria-label="移除蒙版"
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
              <input
                ref={sourceInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                disabled={referenceUploadDisabled}
                className="sr-only"
                onChange={(event) => {
                  props.onSourceImagesChange(event.target.files);
                  event.target.value = "";
                }}
              />
              <input
                ref={maskInputRef}
                type="file"
                accept="image/png"
                className="sr-only"
                onChange={(event) => {
                  setMaskEditorOpen(false);
                  void props.onMaskChange(event.target.files?.[0] ?? null);
                  event.target.value = "";
                }}
              />
            </div>
            {maskEditorOpen && sourcePreviewUrls[0] ? (
              <ImageMaskEditor
                open={maskEditorOpen}
                sourcePreviewUrl={sourcePreviewUrls[0]}
                disabled={props.busy}
                onClose={() => setMaskEditorOpen(false)}
                onSave={props.onMaskChange}
              />
            ) : null}
          </div>

          <div className="border-t border-border bg-muted/20 p-4 sm:p-5">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-foreground">
                生成设置
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                选择当前操作可用的分组、模型、画幅和输出参数。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-1.5 sm:col-span-2">
                <Label
                  htmlFor="simple-image-model"
                  className="text-xs font-medium text-muted-foreground"
                >
                  分组与模型
                </Label>
                {selections.length > 0 ? (
                  <Select
                    value={selectionValue}
                    onValueChange={changeModelSelection}
                    disabled={props.busy}
                  >
                    <SelectTrigger
                      id="simple-image-model"
                      className="w-full bg-background"
                    >
                      <SelectValue placeholder="选择生图模型" />
                    </SelectTrigger>
                    <SelectContent>
                      {props.catalog.groups.map((group) => {
                        const groupModels = group.models.filter((item) =>
                          Boolean(item.capabilities[props.mode])
                        );
                        if (groupModels.length === 0) return null;
                        return (
                          <SelectGroup key={group.id}>
                            <SelectLabel>{group.name}</SelectLabel>
                            {groupModels.map((item) => (
                              <SelectItem
                                key={createModelSelectionValue(
                                  group.id,
                                  item.id
                                )}
                                value={createModelSelectionValue(
                                  group.id,
                                  item.id
                                )}
                              >
                                {item.id === "default"
                                  ? DEFAULT_IMAGE_MODEL
                                  : item.id}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        );
                      })}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex h-9 items-center rounded-md border border-destructive/40 bg-background px-3 text-sm text-destructive">
                    当前没有支持此操作的生图模型。
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label
                  htmlFor="simple-image-size"
                  className="text-xs font-medium text-muted-foreground"
                >
                  画面比例
                </Label>
                <ImageSizePicker
                  size={props.size}
                  onChange={props.onSizeChange}
                  disabled={props.busy}
                  supportsAutoSize={props.supportsAutoSize === true}
                />
                {props.supportsAutoSize !== true ? (
                  <p className="text-xs leading-4 text-muted-foreground">
                    当前模型不支持传递 auto 尺寸，请选择明确尺寸。
                  </p>
                ) : null}
              </div>

              {props.supportsQuality === true ? (
                <div className="space-y-1.5">
                  <Label
                    htmlFor="simple-image-quality"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    质量
                  </Label>
                  <Select
                    value={props.quality}
                    onValueChange={props.onQualityChange}
                    disabled={props.busy}
                  >
                    <SelectTrigger
                      id="simple-image-quality"
                      className="w-full bg-background"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(
                        [
                          ["auto", "自动"],
                          ["low", "低"],
                          ["medium", "中"],
                          ["high", "高"],
                        ] as const
                      ).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
                <Label
                  htmlFor="simple-image-background"
                  className="text-xs font-medium text-muted-foreground"
                >
                  背景
                </Label>
                <Select
                  value={props.background}
                  onValueChange={props.onBackgroundChange}
                  disabled={props.busy}
                >
                  <SelectTrigger
                    id="simple-image-background"
                    className="w-full bg-background"
                  >
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
            {props.error ? (
              <div
                role="alert"
                className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              >
                {props.error}
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Coins className="size-3.5" />
              <span>
                余额：
                <span className="font-medium text-foreground">
                  {formatCredits(props.balance)}
                </span>{" "}
                · 预计：
                <span className="font-medium text-foreground">
                  {formatCredits(props.estimatedCredits)}
                </span>
              </span>
            </div>
            <Button
              type="submit"
              disabled={submitDisabled}
              className="min-w-30"
            >
              {props.busy ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Wand2 className="mr-2 size-4" />
              )}
              {props.busy ? "生成中" : submitLabel}
            </Button>
          </div>
        </section>
      </form>

      <ImageGenerationResultGallery
        busy={props.busy}
        resultUrls={props.resultUrls}
      />

      <Dialog
        open={imagePreview !== null}
        onOpenChange={(open) => {
          if (!open) setImagePreview(null);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="w-[calc(100vw-1.5rem)] max-w-5xl border-border bg-background/95 p-3 sm:p-5"
        >
          <DialogTitle className="sr-only">
            {activeImagePreview?.title ?? "预览图片"}
          </DialogTitle>
          {activeImagePreview ? (
            <div className="relative flex min-h-[50vh] items-center justify-center overflow-hidden rounded-lg bg-muted/40">
              <Image
                src={activeImagePreview.src}
                alt={activeImagePreview.alt}
                data-recent-image-preview={
                  activeImagePreview.recent ? "true" : undefined
                }
                width={1600}
                height={1600}
                unoptimized
                className="max-h-[78vh] w-auto max-w-full object-contain"
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <section aria-labelledby="simple-recent-images-title">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2
            id="simple-recent-images-title"
            className="text-sm font-semibold text-foreground"
          >
            最近图片
          </h2>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>更多参考图输入，可前往图库选择图片作为输入</span>
            <Link
              className="font-medium text-primary underline-offset-4 hover:underline"
              href="../gallery"
            >
              前往图库
            </Link>
          </div>
        </div>
        {recentImages.length === 0 ? (
          <div className="flex min-h-36 flex-col items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            <ImageIcon className="mb-2 size-7" />
            暂无可用图片
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {recentImages.map((item) => {
              const isPending =
                item.status === "queued" ||
                item.status === "pending" ||
                item.status === "processing";
              const isFailed = item.status === "failed";
              return (
                <div
                  key={item.id}
                  className={cn(
                    "group relative aspect-square overflow-hidden rounded-lg border bg-muted text-left outline-none transition hover:border-primary/60",
                    (isPending || isFailed) && "opacity-70"
                  )}
                >
                  {item.imageUrl ? (
                    <Image
                      src={getRecentImageDisplayUrl(item.imageUrl)}
                      alt={item.prompt}
                      fill
                      sizes="(max-width: 640px) 33vw, (max-width: 768px) 25vw, 160px"
                      unoptimized
                      className="object-contain transition duration-200 group-hover:scale-[1.02]"
                    />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 bg-muted/60 px-2 text-center text-xs text-muted-foreground">
                      {isPending ? (
                        <Loader2 className="size-5 animate-spin" />
                      ) : (
                        <X className="size-5" />
                      )}
                      <span>{isPending ? "生图中" : "生成失败"}</span>
                    </div>
                  )}
                  {item.imageUrl ? (
                    <div className="absolute inset-0 flex flex-col items-stretch justify-center gap-2 bg-background/65 px-3 opacity-100 backdrop-blur-[2px] transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        className="w-full bg-background/95 px-2 shadow-sm"
                        aria-label={`查看图片：${item.prompt}`}
                        onClick={() =>
                          setImagePreview({ kind: "recent", image: item })
                        }
                      >
                        <Eye className="size-3.5" />
                        查看图片
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        className="w-full bg-background/95 px-2 shadow-sm"
                        aria-label={`作为参考图：${item.prompt}`}
                        disabled={
                          props.busy ||
                          props.referenceLoadingId !== null ||
                          referenceLimitReached ||
                          isPending ||
                          isFailed
                        }
                        title={
                          referenceLimitReached
                            ? `最多添加 ${props.maxEditImages} 张参考图`
                            : isPending
                              ? "图片正在生成，完成后可作为参考图"
                              : isFailed
                                ? "图片生成失败"
                                : "添加为参考图"
                        }
                        onClick={() => void selectRecentReference(item)}
                      >
                        <ImagePlus className="size-3.5" />
                        作为参考图
                      </Button>
                    </div>
                  ) : null}
                  {props.referenceLoadingId === item.id ? (
                    <div
                      className="absolute inset-0 flex items-center justify-center bg-background/70"
                      role="status"
                    >
                      <Loader2 className="size-5 animate-spin" />
                      <span className="sr-only">正在添加参考图</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
