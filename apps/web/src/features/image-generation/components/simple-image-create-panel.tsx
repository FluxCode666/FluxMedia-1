/**
 * 简易生图页的旧版统一视觉布局。
 *
 * 使用方是 `ImageCreatePanel` 的 simple 变体。本组件只负责呈现统一文字输入、参考图、
 * 模型与生成设置、结果和最近图片；模型权限、文件校验、计费与请求提交仍由父组件负责。
 */

"use client";

import { formatCredits } from "@repo/shared/credits/format";
import { Button } from "@repo/ui/components/button";
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
import {
  Brush,
  Coins,
  ImageIcon,
  ImagePlus,
  Loader2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ImageGenerationModelCatalog } from "@/features/image-backend-pool/image-generation-model-catalog";
import { getRecentImageDisplayUrl } from "@/features/image-generation/recent-image-display";
import { DEFAULT_IMAGE_MODEL } from "@/features/image-generation/resolution";

import { ImageMaskEditor } from "./image-mask-editor";
import { ImageSizePicker } from "./image-size-picker";

type ImageCreateMode = "generate" | "edit" | "mask";

type RecentImage = {
  id: string;
  imageUrl: string | null;
  prompt: string;
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
  mode: ImageCreateMode;
  model: string;
  onBackgroundChange: (value: string) => void;
  onMaskChange: (file: File | null) => void | Promise<void>;
  onModelSelectionChange: (groupId: string, modelId: string) => void;
  onPromptChange: (value: string) => void;
  onQualityChange: (value: string) => void;
  onRecentReferenceSelect: (image: RecentImage) => Promise<boolean>;
  onRemoveReference: () => void;
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
function useSourcePreview(file: File | undefined): string | null {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    setPreviewUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  return previewUrl;
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
  const sourcePreviewUrl = useSourcePreview(props.sourceImages[0]);
  const [maskEditorOpen, setMaskEditorOpen] = useState(false);
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
    props.busy || !props.prompt.trim() || !props.hasAvailableModel;
  const recentImages = useMemo(
    () =>
      props.recent
        .filter((item): item is RecentImage & { imageUrl: string } =>
          Boolean(item.imageUrl)
        )
        .slice(0, 6),
    [props.recent]
  );

  useEffect(() => {
    if (props.sourceImages.length === 0 || !props.maskAvailable) {
      setMaskEditorOpen(false);
    }
  }, [props.maskAvailable, props.sourceImages.length]);

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

  /** 将近期成品设为参考图，成功后返回统一输入卡片方便继续编辑。 */
  async function selectRecentReference(image: RecentImage): Promise<void> {
    const selected = await props.onRecentReferenceSelect(image);
    if (!selected) return;
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="space-y-8">
      <form ref={formRef} className="space-y-5" onSubmit={handleSubmit}>
        <section className="overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
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
                    disabled={props.busy}
                  >
                    <ImagePlus className="mr-1.5 size-4" />
                    添加参考图
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    可选。添加后会在原位切换为图生图。
                  </span>
                </>
              ) : (
                <div className="flex w-full flex-wrap items-center gap-2">
                  <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/20 p-1.5 pr-2.5">
                    <span className="relative size-10 shrink-0 overflow-hidden rounded-md border bg-muted">
                      {sourcePreviewUrl ? (
                        <Image
                          src={sourcePreviewUrl}
                          alt="主参考图"
                          fill
                          sizes="40px"
                          className="object-cover"
                          unoptimized
                        />
                      ) : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-foreground">
                        主参考图
                      </span>
                      <span className="block max-w-48 truncate text-[11px] text-muted-foreground">
                        {props.sourceImages.length > 1
                          ? `已选择 ${props.sourceImages.length} 张图片`
                          : props.sourceImages[0]?.name}
                      </span>
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => sourceInputRef.current?.click()}
                    disabled={props.busy}
                  >
                    <Upload className="mr-1.5 size-3.5" />
                    更换
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setMaskEditorOpen(false);
                      props.onRemoveReference();
                    }}
                    disabled={props.busy}
                  >
                    <X className="mr-1.5 size-3.5" />
                    移除
                  </Button>
                  <span className="h-5 w-px bg-border" aria-hidden="true" />
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
                        : "当前套餐没有支持蒙版编辑的模型"
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
                        : "当前套餐没有支持蒙版编辑的模型"
                    }
                  >
                    <Upload className="mr-1.5 size-3.5" />
                    {props.mask ? "更换蒙版" : "上传蒙版"}
                  </Button>
                  {props.mask ? (
                    <div className="ml-auto flex items-center gap-1.5 rounded-lg border border-border bg-muted/25 p-1 pl-2">
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
              )}
              <input
                ref={sourceInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
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
            {maskEditorOpen && sourcePreviewUrl ? (
              <ImageMaskEditor
                open={maskEditorOpen}
                sourcePreviewUrl={sourcePreviewUrl}
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
                    当前套餐没有支持此操作的生图模型。
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
                />
              </div>

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

      {props.busy && props.resultUrls.length === 0 ? (
        <div
          role="status"
          className="flex min-h-64 max-w-2xl items-center justify-center rounded-lg border border-dashed bg-muted/30 text-sm text-muted-foreground"
        >
          <Loader2 className="mr-2 size-5 animate-spin" />
          正在生成图片…
        </div>
      ) : null}

      {props.resultUrls.length > 0 ? (
        <section aria-labelledby="simple-image-results-title">
          <h2
            id="simple-image-results-title"
            className="mb-3 text-sm font-semibold text-foreground"
          >
            本次结果
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {props.resultUrls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">
                <Image
                  src={url}
                  alt="生成图片"
                  width={768}
                  height={768}
                  unoptimized
                  className="h-auto w-full rounded-lg border object-contain"
                />
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="simple-recent-images-title">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2
            id="simple-recent-images-title"
            className="text-sm font-semibold text-foreground"
          >
            最近图片
          </h2>
          <span className="text-xs text-muted-foreground">
            点击图片即可添加为参考图
          </span>
        </div>
        {recentImages.length === 0 ? (
          <div className="flex min-h-36 flex-col items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            <ImageIcon className="mb-2 size-7" />
            暂无可用图片
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {recentImages.map((item) => (
              <button
                key={item.id}
                type="button"
                className="group relative aspect-square overflow-hidden rounded-lg border bg-muted text-left outline-none transition hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onClick={() => void selectRecentReference(item)}
                disabled={props.busy || props.referenceLoadingId !== null}
                aria-label={`将最近图片添加为参考图：${item.prompt}`}
                title="添加为参考图"
              >
                <Image
                  src={getRecentImageDisplayUrl(item.imageUrl)}
                  alt={item.prompt}
                  fill
                  sizes="(max-width: 640px) 33vw, (max-width: 768px) 25vw, 160px"
                  unoptimized
                  className="object-contain transition duration-200 group-hover:scale-[1.02]"
                />
                <span className="absolute inset-x-0 bottom-0 bg-background/90 px-2 py-1 text-center text-[11px] font-medium text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  作为参考图
                </span>
                {props.referenceLoadingId === item.id ? (
                  <div
                    className="absolute inset-0 flex items-center justify-center bg-background/70"
                    role="status"
                  >
                    <Loader2 className="size-5 animate-spin" />
                    <span className="sr-only">正在添加参考图</span>
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
