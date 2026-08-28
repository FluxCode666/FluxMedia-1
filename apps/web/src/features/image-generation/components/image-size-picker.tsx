/**
 * 简易生图页的弹窗式画面尺寸选择器。
 *
 * 使用方是统一生图表单。组件恢复自动、预设比例、自定义比例和自定义宽高交互，最终
 * 只向父组件提交统一管线可校验的 `auto` 或 `WIDTHxHEIGHT` 字符串。
 */

"use client";

import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { Info } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getImageSizeForRatio,
  IMAGE_ASPECT_RATIOS,
  IMAGE_SIZE_BASES,
  type ImageAspectRatio,
  type ImageSizeBase,
  type ImageSizeMode,
  parseImageAspectRatioInput,
  resolveImageSizeSelectionState,
} from "@/features/image-generation/image-size-selection";
import {
  AUTO_IMAGE_SIZE,
  IMAGE_DIMENSION_STEP,
  MAX_IMAGE_DIMENSION,
  MIN_IMAGE_DIMENSION,
  normalizeValidImageSize,
  validateImageSize,
} from "@/features/image-generation/resolution";

type ImageSizePickerProps = {
  disabled: boolean;
  onChange: (size: string) => void;
  size: string;
  supportsAutoSize?: boolean;
};

/** 按当前尺寸方向绘制与旧版按钮一致的简洁画幅图标。 */
function SizeRatioIcon({ size }: { size: string }) {
  const rawDimensions = size.split("x").map(Number);
  const width = rawDimensions[0] ?? 1;
  const height = rawDimensions[1] ?? 1;
  const frameClass =
    width === height ? "size-5" : width > height ? "h-3 w-5" : "h-5 w-3";
  return (
    <span
      aria-hidden="true"
      className={`${frameClass} shrink-0 rounded-[3px] border border-current opacity-60`}
    />
  );
}

/** 将当前尺寸格式化为按钮和弹窗中的中文可读值。 */
function formatImageSize(size: string): string {
  return size.trim().toLowerCase() === AUTO_IMAGE_SIZE
    ? "自动"
    : size.replace("x", " × ");
}

/**
 * 渲染弹窗式画面尺寸选择器。
 *
 * @param props 当前尺寸、禁用状态和确认回调。
 * @returns 可键盘操作的尺寸按钮及其受控弹窗。
 * @sideEffects 打开弹窗时从当前尺寸重置草稿；确认后更新父表单尺寸。
 * @failure 非法比例或空宽高会阻止确认，并在预览区显示可定位错误。
 */
export function ImageSizePicker({
  disabled,
  onChange,
  size,
  supportsAutoSize = false,
}: ImageSizePickerProps) {
  const initial = useMemo(
    () => resolveImageSizeSelectionState(size, supportsAutoSize),
    [size, supportsAutoSize]
  );
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ImageSizeMode>(initial.mode);
  const [base, setBase] = useState<ImageSizeBase>(initial.base);
  const [ratio, setRatio] = useState<ImageAspectRatio>(initial.ratio);
  const [customRatio, setCustomRatio] = useState(initial.customRatio);
  const [customRatioOpen, setCustomRatioOpen] = useState(false);
  const [customWidth, setCustomWidth] = useState(initial.customWidth);
  const [customHeight, setCustomHeight] = useState(initial.customHeight);

  /** 用当前尺寸和模型能力重置弹窗草稿，确保首次显示的标签也正确。 */
  const resetDraft = useCallback((): void => {
    const next = resolveImageSizeSelectionState(size, supportsAutoSize);
    setMode(next.mode);
    setBase(next.base);
    setRatio(next.ratio);
    setCustomRatio(next.customRatio);
    setCustomRatioOpen(false);
    setCustomWidth(next.customWidth);
    setCustomHeight(next.customHeight);
  }, [size, supportsAutoSize]);

  useEffect(() => {
    if (!open) return;
    resetDraft();
  }, [open, resetDraft]);

  const selectedRatio = IMAGE_ASPECT_RATIOS.find(
    (item) => item.value === ratio
  ) ??
    IMAGE_ASPECT_RATIOS[0] ?? { value: "1:1" as const, width: 1, height: 1 };
  const customRatioValue = parseImageAspectRatioInput(customRatio);
  const activeRatio =
    mode === "ratio" && customRatioOpen && customRatioValue
      ? customRatioValue
      : selectedRatio;
  const ratioSize = getImageSizeForRatio(base, activeRatio);
  const customDimensionsValid =
    Number.isFinite(customWidth) &&
    Number.isFinite(customHeight) &&
    customWidth > 0 &&
    customHeight > 0;
  const customSize = customDimensionsValid
    ? normalizeValidImageSize({
        width: customWidth,
        height: customHeight,
      })
    : "";
  const previewSize =
    mode === "auto"
      ? AUTO_IMAGE_SIZE
      : mode === "custom"
        ? customSize
        : ratioSize;
  const previewCheck = previewSize
    ? validateImageSize(previewSize)
    : { valid: false as const, message: "请输入有效的宽度和高度。" };
  const ratioInputValid = !customRatioOpen || Boolean(customRatioValue);
  const canConfirm =
    previewCheck.valid &&
    ratioInputValid &&
    (mode !== "auto" || supportsAutoSize) &&
    (mode !== "custom" || customDimensionsValid);

  /** 确认经过规整和校验的尺寸，未知草稿不会离开弹窗。 */
  function applySize(): void {
    if (!canConfirm) return;
    onChange(previewSize);
    setOpen(false);
  }

  return (
    <>
      <Button
        id="simple-image-size"
        type="button"
        variant="outline"
        className="w-full justify-start bg-background"
        onClick={() => {
          resetDraft();
          setOpen(true);
        }}
        disabled={disabled}
        aria-label={`设置画面比例，当前为${formatImageSize(size)}`}
      >
        <SizeRatioIcon size={size} />
        <span className="ml-2 truncate">{formatImageSize(size)}</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-md gap-0 overflow-y-auto rounded-3xl border-border p-0">
          <div className="space-y-6 p-5 sm:p-6">
            <DialogHeader className="text-left">
              <DialogTitle>设置图像尺寸</DialogTitle>
              <DialogDescription>
                当前：{formatImageSize(size)}
              </DialogDescription>
            </DialogHeader>

            <fieldset className="grid grid-cols-3 rounded-xl bg-muted p-1">
              <legend className="sr-only">尺寸选择方式</legend>
              {(
                [
                  { value: "auto", label: "自动" },
                  { value: "ratio", label: "按比例" },
                  { value: "custom", label: "自定义宽高" },
                ] as const
              ).map((item) => (
                <button
                  key={item.value}
                  type="button"
                  disabled={item.value === "auto" && !supportsAutoSize}
                  onClick={() => {
                    if (item.value === "auto" && !supportsAutoSize) return;
                    setMode(item.value);
                  }}
                  aria-pressed={mode === item.value}
                  className={`h-9 rounded-lg text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    mode === item.value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </fieldset>

            {mode !== "auto" ? (
              <>
                <section className="space-y-3">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    基准分辨率
                  </h3>
                  <div className="grid grid-cols-3 gap-2">
                    {IMAGE_SIZE_BASES.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => setBase(item.value)}
                        aria-pressed={base === item.value}
                        className={`h-10 rounded-xl border text-sm font-medium transition ${
                          base === item.value
                            ? "border-primary bg-primary/5 text-primary"
                            : "border-border bg-background text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </section>

                {mode === "ratio" ? (
                  <section className="space-y-3">
                    <h3 className="text-sm font-medium text-muted-foreground">
                      图像比例
                    </h3>
                    <div className="grid grid-cols-4 gap-2">
                      {IMAGE_ASPECT_RATIOS.map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => {
                            setRatio(item.value);
                            setCustomRatio(item.value);
                            setCustomRatioOpen(false);
                          }}
                          aria-pressed={
                            !customRatioOpen && ratio === item.value
                          }
                          className={`flex h-16 flex-col items-center justify-center gap-1 rounded-xl border text-xs transition ${
                            !customRatioOpen && ratio === item.value
                              ? "border-primary bg-primary/5 text-primary"
                              : "border-border bg-background text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          <SizeRatioIcon
                            size={`${item.width}x${item.height}`}
                          />
                          <span>{item.value}</span>
                        </button>
                      ))}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setCustomRatioOpen(true)}
                      className="w-full border-primary text-primary hover:bg-primary/5 hover:text-primary"
                    >
                      自定义比例
                    </Button>
                    {customRatioOpen ? (
                      <div className="space-y-2 rounded-xl border border-border bg-background p-3">
                        <Label
                          htmlFor="generate-custom-ratio"
                          className="text-xs font-medium text-muted-foreground"
                        >
                          输入自定义比例
                        </Label>
                        <Input
                          id="generate-custom-ratio"
                          value={customRatio}
                          onChange={(event) =>
                            setCustomRatio(event.target.value)
                          }
                          placeholder="16:9"
                          aria-invalid={!customRatioValue}
                        />
                        {!customRatioValue ? (
                          <p className="text-xs text-destructive" role="alert">
                            请使用类似 16:9 的比例。
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                ) : null}

                {mode === "custom" ? (
                  <section className="space-y-3">
                    <h3 className="text-sm font-medium text-muted-foreground">
                      输入自定义宽高
                    </h3>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="generate-custom-width"
                          className="text-xs font-medium text-muted-foreground"
                        >
                          宽度
                        </Label>
                        <Input
                          id="generate-custom-width"
                          type="number"
                          min={MIN_IMAGE_DIMENSION}
                          max={MAX_IMAGE_DIMENSION}
                          step={IMAGE_DIMENSION_STEP}
                          value={customWidth || ""}
                          onChange={(event) =>
                            setCustomWidth(Number(event.target.value) || 0)
                          }
                        />
                      </div>
                      <div className="pb-2 text-muted-foreground">×</div>
                      <div className="space-y-1.5">
                        <Label
                          htmlFor="generate-custom-height"
                          className="text-xs font-medium text-muted-foreground"
                        >
                          高度
                        </Label>
                        <Input
                          id="generate-custom-height"
                          type="number"
                          min={MIN_IMAGE_DIMENSION}
                          max={MAX_IMAGE_DIMENSION}
                          step={IMAGE_DIMENSION_STEP}
                          value={customHeight || ""}
                          onChange={(event) =>
                            setCustomHeight(Number(event.target.value) || 0)
                          }
                        />
                      </div>
                    </div>
                  </section>
                ) : null}
              </>
            ) : null}

            <div className="rounded-2xl bg-muted/30 p-4">
              <p className="text-xs font-medium text-muted-foreground">
                将使用
              </p>
              <p className="mt-2 text-lg font-semibold text-foreground">
                {previewSize ? formatImageSize(previewSize) : "等待输入"}
              </p>
              {!previewCheck.valid ? (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {previewCheck.message || "尺寸不符合模型约束。"}
                </p>
              ) : null}
            </div>

            <div className="flex gap-3 rounded-2xl border border-border bg-muted/20 p-4 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0 text-primary" />
              <p>
                最终输出会自动规整到合法尺寸：宽高均为 16 的倍数，最大边长
                3840px，宽高比不超过 3:1，总像素限制为 655360–8294400。
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setOpen(false)}
                className="h-10 rounded-xl"
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={applySize}
                disabled={!canConfirm}
                className="h-10 rounded-xl"
              >
                确定
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
