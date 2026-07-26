"use client";

/**
 * 模型配置编辑弹窗的封面选择与 3:2 本地预览字段。
 *
 * 使用方是 ModelConfigurationDialog；本组件只管理浏览器对象 URL 生命周期、单次图片
 * 回退和文件选择，不上传、不读取图片字节，也不把失败预览伪装成已保存状态。
 */
import { MAX_MODEL_MARKETPLACE_COVER_BYTES } from "@repo/shared/model-marketplace";
import { Button } from "@repo/ui/components/button";
import { Label } from "@repo/ui/components/label";
import { cn } from "@repo/ui/utils";
import { ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { getDefaultModelMarketplaceCoverPath } from "@/features/model-marketplace/assets";

import type { ModelConfigurationCoverDraft } from "./model-configuration-draft";
import { resolveModelConfigurationCoverAfterError } from "./model-configuration-view-model";

const ACCEPTED_COVER_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type ModelCoverFieldProps = {
  category: "image" | "video";
  currentCoverUrl: string;
  usesDefaultCover: boolean;
  value: ModelConfigurationCoverDraft;
  disabled: boolean;
  onChange: (value: ModelConfigurationCoverDraft) => void;
};

/**
 * 渲染封面预览、替换、移除与恢复当前值操作。
 *
 * @param props - 当前服务端封面、草稿动作、权限与变更回调。
 * @returns 固定 3:2 预览和仅在可编辑时出现的文件操作。
 * @sideEffects 选择文件时创建对象 URL；替换、恢复和卸载时及时 revoke；不发网络请求。
 * @failure 浏览器 MIME/大小预检失败只提示并保留旧草稿；图片加载失败最多回退一次本地封面。
 */
export function ModelCoverField({
  category,
  currentCoverUrl,
  usesDefaultCover,
  value,
  disabled,
  onChange,
}: ModelCoverFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const requestedSource =
    value.action === "replace" && previewUrl
      ? previewUrl
      : value.action === "remove"
        ? getDefaultModelMarketplaceCoverPath(category)
        : currentCoverUrl;
  const [renderSource, setRenderSource] = useState<string | null>(
    requestedSource
  );

  useEffect(() => {
    setRenderSource(requestedSource);
  }, [requestedSource]);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  /** 释放旧对象 URL，避免多次选择大图后占用浏览器内存。 */
  const replaceObjectUrl = (nextUrl: string | null): void => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = nextUrl;
    setPreviewUrl(nextUrl);
  };

  /** 校验并接收用户选择的唯一封面文件。 */
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!ACCEPTED_COVER_TYPES.has(file.type)) {
      toast.error("请选择 JPEG、PNG 或 WebP 图片");
      return;
    }
    if (file.size <= 0 || file.size > MAX_MODEL_MARKETPLACE_COVER_BYTES) {
      toast.error("封面文件必须在 5 MB 以内");
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    replaceObjectUrl(objectUrl);
    onChange({ action: "replace", file });
  };

  /** 标记保存后移除自定义封面，并立即预览本地默认封面。 */
  const handleRemove = (): void => {
    replaceObjectUrl(null);
    onChange({ action: "remove", file: null });
  };

  /** 放弃未保存的封面动作并恢复服务端当前引用。 */
  const handleReset = (): void => {
    replaceObjectUrl(null);
    onChange({ action: "keep", file: null });
  };

  /** 图片解码或读取失败后仅回退一次内置封面。 */
  const handleImageError = (): void => {
    if (!renderSource) return;
    setRenderSource(
      resolveModelConfigurationCoverAfterError(renderSource, category)
    );
  };

  const hasPendingChange = value.action !== "keep";
  const canRemove = value.action === "replace" || !usesDefaultCover;

  return (
    <div className="space-y-2">
      <Label>模型广场封面</Label>
      <div className="overflow-hidden rounded-lg border bg-muted/30">
        <div className="aspect-[3/2] w-full">
          {renderSource ? (
            // biome-ignore lint/performance/noImgElement: blob 预览和运行时存储 URL 需要原生错误回退。
            <img
              src={renderSource}
              alt={`${category === "image" ? "图像" : "视频"}模型封面预览`}
              className="h-full w-full object-cover"
              onError={handleImageError}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              封面暂不可用
            </div>
          )}
        </div>
      </div>
      {!disabled ? (
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={handleFileChange}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
          >
            <ImagePlus className="mr-2 h-4 w-4" />
            {value.action === "replace" || !usesDefaultCover ? "替换" : "上传"}
          </Button>
          {canRemove ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRemove}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              移除
            </Button>
          ) : null}
          {hasPendingChange ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleReset}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              恢复当前封面
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className={cn("text-xs text-muted-foreground", disabled && "mt-1")}>
        JPEG、PNG 或 WebP，最大 5 MB；保存后统一裁为 3:2 WebP。
      </p>
    </div>
  );
}
