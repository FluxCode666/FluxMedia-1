"use client";

import { Button } from "@repo/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@repo/ui/components/dialog";
import { Eraser, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";

type Point = { x: number; y: number };
type Stroke = { color: string; width: number; points: Point[] };

const COLORS = ["#171717", "#dc2626", "#2563eb", "#16a34a"] as const;
const CANVAS_SIZE = 1024;

type ImageWhiteboardProps = {
  onClose: () => void;
  onSave: (file: File) => boolean;
};

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke): void {
  const first = stroke.points[0];
  if (!first) return;
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineWidth = stroke.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of stroke.points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.stroke();
  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2);
    context.fill();
  }
}

export function ImageWhiteboard({ onClose, onSave }: ImageWhiteboardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const activePointerRef = useRef<number | null>(null);
  const [color, setColor] = useState<string>(COLORS[0]);
  const [brushSize, setBrushSize] = useState(8);
  const [strokeCount, setStrokeCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function redraw(): void {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokesRef.current) drawStroke(context, stroke);
  }

  const initializeCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokesRef.current) drawStroke(context, stroke);
  }, []);

  function pointerPosition(
    event: React.PointerEvent<HTMLCanvasElement>
  ): Point | null {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * CANVAS_SIZE,
      y: ((event.clientY - bounds.top) / bounds.height) * CANVAS_SIZE,
    };
  }

  function startStroke(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (saving || activePointerRef.current !== null) return;
    const point = pointerPosition(event);
    if (!point) return;
    const context = event.currentTarget.getContext("2d");
    if (!context) {
      setError("浏览器无法创建画板");
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerRef.current = event.pointerId;
    const stroke = { color, width: brushSize, points: [point] };
    strokesRef.current.push(stroke);
    drawStroke(context, stroke);
    setStrokeCount(strokesRef.current.length);
    setError(null);
  }

  function continueStroke(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (saving || activePointerRef.current !== event.pointerId) return;
    const point = pointerPosition(event);
    const stroke = strokesRef.current.at(-1);
    if (!point || !stroke) return;
    event.preventDefault();
    const previous = stroke.points.at(-1);
    const context = event.currentTarget.getContext("2d");
    if (!previous || !context) return;
    stroke.points.push(point);
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.width;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function stopStroke(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (activePointerRef.current !== event.pointerId) return;
    activePointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  async function save(): Promise<void> {
    if (saving || strokesRef.current.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    setError(null);
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error("无法保存画板，请重试"));
        }, "image/png");
      });
      const file = new File([blob], `whiteboard-${crypto.randomUUID()}.png`, {
        type: "image/png",
      });
      if (onSave(file)) onClose();
      else setError("添加参考图失败，请检查文件大小或数量限制");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "无法保存画板，请重试"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[95dvh] w-[calc(100vw-1.5rem)] max-w-3xl gap-3 overflow-y-auto p-4 sm:p-6"
      >
        <DialogTitle>手绘参考图</DialogTitle>
        <p className="text-sm text-muted-foreground">
          在白色画板上绘制草图，保存后将作为图生图参考图。
        </p>
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">画笔工具</legend>
          {COLORS.map((value) => (
            <button
              key={value}
              type="button"
              aria-label={`画笔颜色 ${value}`}
              aria-pressed={color === value}
              onClick={() => setColor(value)}
              className="size-8 rounded-full border-2 border-background shadow-[0_0_0_1px_var(--border)] focus-visible:outline-2 focus-visible:outline-primary"
              style={{
                backgroundColor: value,
                outline:
                  color === value ? "2px solid var(--primary)" : undefined,
              }}
            />
          ))}
          <Button
            type="button"
            size="sm"
            variant={color === "#ffffff" ? "secondary" : "outline"}
            onClick={() => setColor("#ffffff")}
            aria-label="橡皮擦"
          >
            <Eraser className="mr-1 size-4" />
            橡皮擦
          </Button>
          <label className="ml-auto flex items-center gap-2 text-sm">
            画笔粗细
            <input
              type="range"
              min="2"
              max="40"
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.target.value))}
              aria-label="画笔粗细"
            />
          </label>
        </fieldset>
        <canvas
          ref={initializeCanvas}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          aria-label="手绘画板"
          className="mx-auto aspect-square w-full max-w-[55dvh] cursor-crosshair touch-none rounded-lg border border-border bg-white"
          onPointerDown={startStroke}
          onPointerMove={continueStroke}
          onPointerUp={stopStroke}
          onPointerCancel={stopStroke}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving || strokeCount === 0}
              onClick={() => {
                strokesRef.current.pop();
                setStrokeCount(strokesRef.current.length);
                redraw();
              }}
            >
              <RotateCcw className="mr-1 size-4" />
              撤销
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving || strokeCount === 0}
              onClick={() => {
                strokesRef.current = [];
                setStrokeCount(0);
                redraw();
              }}
            >
              <Trash2 className="mr-1 size-4" />
              清空
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={saving}
            >
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void save()}
              disabled={saving || strokeCount === 0}
            >
              {saving ? "保存中…" : "保存为参考图"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
