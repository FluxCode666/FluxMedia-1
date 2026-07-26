/**
 * 统一生图表单的内嵌蒙版绘制器。
 *
 * 使用方是 `SimpleImageCreatePanel`。组件在参考图像素坐标系中记录画笔轨迹，将涂抹
 * 区域保存为透明、其余区域为不透明黑色的 PNG，并交回现有蒙版上传链路复验。
 */

"use client";

import { Button } from "@repo/ui/components/button";
import { Eraser, Loader2, Save } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

type MaskPoint = {
  x: number;
  y: number;
  size: number;
};

type ImageDimensions = {
  width: number;
  height: number;
};

type ImageMaskEditorProps = {
  disabled: boolean;
  onClose: () => void;
  onSave: (file: File) => void | Promise<void>;
  open: boolean;
  sourcePreviewUrl: string;
};

/** 将 HTMLCanvasElement.toBlob 转为可等待且显式失败的 Promise。 */
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("保存蒙版失败"));
    }, "image/png");
  });
}

/**
 * 渲染与参考图同坐标系的蒙版画布。
 *
 * @param props 参考图预览、开关状态、保存和关闭回调。
 * @returns 打开时返回内嵌画布和画笔控制，关闭时不渲染。
 * @sideEffects 指针绘制会更新本地轨迹；保存会生成 PNG File 并调用父回调。
 * @failure 图片未解码、画布不可用或 PNG 编码失败时显示就地错误，不提交空蒙版。
 */
export function ImageMaskEditor({
  disabled,
  onClose,
  onSave,
  open,
  sourcePreviewUrl,
}: ImageMaskEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const [points, setPoints] = useState<MaskPoint[]>([]);
  const [brushSize, setBrushSize] = useState(32);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sourcePreviewUrl) return;
    setDimensions(null);
    setPoints([]);
    setError(null);
  }, [sourcePreviewUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dimensions) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(220, 38, 38, 0.46)";
    for (const point of points) {
      context.beginPath();
      context.arc(point.x, point.y, point.size, 0, Math.PI * 2);
      context.fill();
    }
  }, [dimensions, points]);

  if (!open) return null;

  /** 将浏览器指针坐标换算到参考图的原始像素坐标系。 */
  function getPointerPosition(
    event: React.PointerEvent<HTMLCanvasElement>
  ): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    };
  }

  /** 开始绘制并捕获当前指针，避免拖出画布时留下未结束状态。 */
  function startDrawing(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (disabled || saving) return;
    event.preventDefault();
    const point = getPointerPosition(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    lastPointRef.current = point;
    setPoints((current) => [...current, { ...point, size: brushSize }]);
    setError(null);
  }

  /** 在相邻指针事件间插值，避免快速拖动产生断裂的透明区域。 */
  function continueDrawing(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!drawingRef.current || disabled || saving) return;
    event.preventDefault();
    const point = getPointerPosition(event);
    const previous = lastPointRef.current;
    if (!point || !previous) return;
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const angle = Math.atan2(point.y - previous.y, point.x - previous.x);
    const step = Math.max(1, brushSize / 4);
    const additions: MaskPoint[] = [];
    for (let offset = step; offset < distance; offset += step) {
      additions.push({
        x: previous.x + Math.cos(angle) * offset,
        y: previous.y + Math.sin(angle) * offset,
        size: brushSize,
      });
    }
    additions.push({ ...point, size: brushSize });
    setPoints((current) => [...current, ...additions]);
    lastPointRef.current = point;
  }

  /** 结束当前指针轨迹。 */
  function stopDrawing(): void {
    drawingRef.current = false;
    lastPointRef.current = null;
  }

  /** 将红色预览轨迹编码为黑底透明编辑区的原尺寸 PNG 蒙版。 */
  async function saveMask(): Promise<void> {
    if (!dimensions || points.length === 0 || saving) {
      setError("请先在参考图上涂抹需要编辑的区域");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const output = document.createElement("canvas");
      output.width = dimensions.width;
      output.height = dimensions.height;
      const context = output.getContext("2d");
      if (!context) throw new Error("浏览器无法创建蒙版画布");
      context.fillStyle = "#000";
      context.fillRect(0, 0, output.width, output.height);
      context.globalCompositeOperation = "destination-out";
      for (const point of points) {
        context.beginPath();
        context.arc(point.x, point.y, point.size, 0, Math.PI * 2);
        context.fill();
      }
      const blob = await canvasToPngBlob(output);
      await onSave(
        new File([blob], "generated-mask.png", { type: "image/png" })
      );
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存蒙版失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/15 p-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        涂抹需要修改的区域后保存。涂抹区域会在 PNG
        蒙版中变为透明，模型将编辑透明区域。
      </p>
      <div
        className="relative mx-auto w-full max-w-2xl overflow-hidden rounded-lg border bg-muted"
        style={{
          aspectRatio: dimensions
            ? `${dimensions.width} / ${dimensions.height}`
            : "1 / 1",
        }}
      >
        <Image
          src={sourcePreviewUrl}
          alt="用于绘制蒙版的参考图"
          fill
          sizes="(max-width: 1024px) 100vw, 640px"
          className="object-contain"
          unoptimized
          onLoad={(event) => {
            const width = event.currentTarget.naturalWidth;
            const height = event.currentTarget.naturalHeight;
            if (width > 0 && height > 0) setDimensions({ width, height });
          }}
          onError={() => setError("参考图加载失败，无法绘制蒙版")}
        />
        {dimensions ? (
          <canvas
            ref={canvasRef}
            width={dimensions.width}
            height={dimensions.height}
            className="absolute inset-0 size-full cursor-crosshair touch-none"
            onPointerDown={startDrawing}
            onPointerMove={continueDrawing}
            onPointerUp={stopDrawing}
            onPointerCancel={stopDrawing}
            role="img"
            aria-label="蒙版绘制区域；键盘用户可使用上传蒙版按钮选择 PNG 文件"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <LabelWithRange
          value={brushSize}
          disabled={disabled || saving}
          onChange={setBrushSize}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setPoints([]);
              setError(null);
            }}
            disabled={disabled || saving || points.length === 0}
          >
            <Eraser className="mr-1.5 size-3.5" />
            清除
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void saveMask()}
            disabled={disabled || saving || points.length === 0}
          >
            {saving ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 size-3.5" />
            )}
            保存蒙版
          </Button>
        </div>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** 渲染带可见当前值的蒙版画笔大小控制。 */
function LabelWithRange({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean;
  onChange: (value: number) => void;
  value: number;
}) {
  return (
    <label
      htmlFor="simple-mask-brush-size"
      className="flex items-center gap-2 text-xs font-medium text-muted-foreground"
    >
      画笔 {value}px
      <input
        id="simple-mask-brush-size"
        type="range"
        min={4}
        max={128}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        disabled={disabled}
        className="w-40 accent-primary"
      />
    </label>
  );
}
