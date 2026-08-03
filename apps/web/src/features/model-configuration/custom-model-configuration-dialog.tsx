"use client";

/**
 * 自定义模型创建 Dialog。
 *
 * 使用方是模型配置面板；本组件收集真实模型 ID、媒体类别、分辨率与初始价格，并复用
 * 单模型 multipart Route 原子创建配置。服务端仍负责 ID 唯一性、权限、幂等与持久化校验。
 */
import {
  MAX_MODEL_MARKETPLACE_CONFIG_KEY_LENGTH,
  modelMarketplaceCustomModelSchema,
} from "@repo/shared/model-marketplace";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Loader2 } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  ModelConfigurationDraftError,
  parseModelConfigurationPrice,
} from "./model-configuration-draft";
import { getModelConfigurationSaveErrorMessage } from "./model-configuration-view-model";

type CustomModelCategory = "image" | "video";

const INITIAL_IMAGE_RESOLUTIONS = "1k, 2k, 4k";
const INITIAL_VIDEO_RESOLUTIONS = "720p, 1080p";

/** 从未知错误响应中读取前端允许展示的稳定 code。 */
async function readStableErrorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      typeof body.code === "string"
    ) {
      return body.code;
    }
  } catch {
    // 非 JSON 响应统一映射为通用失败，不向管理员展示代理正文。
  }
  return null;
}

/**
 * 解析管理员输入的逗号分隔分辨率。
 *
 * @param value - 例如 `1k, 2k, 4k` 的文本。
 * @param modelId - 当前自定义模型 ID，只用于共享定义 schema 的完整校验。
 * @param category - 图像或视频类别。
 * @returns 保持输入顺序的严格分辨率数组。
 * @throws ModelConfigurationDraftError - 空值、重复项或非法标签时失败。
 */
function parseSupportedResolutions(
  value: string,
  modelId: string,
  category: CustomModelCategory
): string[] {
  const supportedResolutions = value
    .split(",")
    .map((resolution) => resolution.trim())
    .filter(Boolean);
  const parsed = modelMarketplaceCustomModelSchema.safeParse({
    modelId,
    category,
    supportedResolutions,
  });
  if (!parsed.success) {
    throw new ModelConfigurationDraftError(
      "请填写 1 至 20 个不重复的分辨率，使用英文逗号分隔"
    );
  }
  return parsed.data.supportedResolutions;
}

/**
 * 渲染自定义模型创建表单。
 *
 * @param props.open - Dialog 是否打开。
 * @param props.onOpenChange - 受控开关回调。
 * @param props.onCreated - 创建成功后的管理快照刷新回调。
 * @returns 可创建图像或视频模型的严格表单。
 * @sideEffects 提交同源 multipart 请求，成功后刷新配置列表。
 * @failure 客户端字段错误直接提示；服务端错误只展示稳定文案并保留草稿。
 */
export function CustomModelConfigurationDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}) {
  const [category, setCategory] = useState<CustomModelCategory>("image");
  const [modelId, setModelId] = useState("");
  const [resolutions, setResolutions] = useState(INITIAL_IMAGE_RESOLUTIONS);
  const [imagePrices, setImagePrices] = useState({
    base1024Credits: "1.27",
    base1kCredits: "1.27",
    base2kCredits: "5.07",
    base4kCredits: "10",
  });
  const [videoPrice, setVideoPrice] = useState("30");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCategory("image");
    setModelId("");
    setResolutions(INITIAL_IMAGE_RESOLUTIONS);
    setImagePrices({
      base1024Credits: "1.27",
      base1kCredits: "1.27",
      base2kCredits: "5.07",
      base4kCredits: "10",
    });
    setVideoPrice("30");
  }, [open]);

  /** 切换媒体类别并提供该类别常用的初始分辨率。 */
  function handleCategoryChange(value: string): void {
    const nextCategory: CustomModelCategory =
      value === "video" ? "video" : "image";
    setCategory(nextCategory);
    setResolutions(
      nextCategory === "image"
        ? INITIAL_IMAGE_RESOLUTIONS
        : INITIAL_VIDEO_RESOLUTIONS
    );
  }

  /** 构造严格 multipart 并创建新的自定义模型定义与初始价格。 */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedModelId = modelId.trim();
    let supportedResolutions: string[];
    try {
      supportedResolutions = parseSupportedResolutions(
        resolutions,
        normalizedModelId,
        category
      );
    } catch (error) {
      toast.error(
        error instanceof ModelConfigurationDraftError
          ? error.message
          : "自定义模型配置无效"
      );
      return;
    }

    const formData = new FormData();
    formData.append("category", category);
    formData.append("configKey", normalizedModelId);
    formData.append("expectedRevision", "0");
    formData.append("clientRequestId", crypto.randomUUID());
    formData.append("isCustom", "true");
    formData.append("visible", "false");
    formData.append("homepageVisible", "false");
    formData.append("homepagePriority", "5");
    formData.append("description", "");
    formData.append("coverChange", "keep");

    try {
      if (category === "image") {
        formData.append(
          "supportedResolutions",
          JSON.stringify(supportedResolutions)
        );
        for (const [field, value] of Object.entries(imagePrices)) {
          formData.append(field, String(parseModelConfigurationPrice(value)));
        }
      } else {
        const price = parseModelConfigurationPrice(videoPrice);
        formData.append(
          "creditsPerSecondByResolution",
          JSON.stringify(
            Object.fromEntries(
              supportedResolutions.map((resolution) => [resolution, price])
            )
          )
        );
      }
    } catch (error) {
      toast.error(
        error instanceof ModelConfigurationDraftError
          ? error.message
          : "请检查初始价格"
      );
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch("/api/admin/model-configuration", {
        method: "POST",
        body: formData,
        credentials: "same-origin",
      });
      if (!response.ok) {
        toast.error(
          getModelConfigurationSaveErrorMessage(
            await readStableErrorCode(response)
          )
        );
        return;
      }
      toast.success("自定义模型已创建");
      await onCreated();
      onOpenChange(false);
    } catch {
      toast.error("网络异常，请稍后重试");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form className="space-y-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>新增自定义模型</DialogTitle>
            <DialogDescription>
              模型 ID 会作为平台调度身份；账号只能从这里已配置的模型中选择。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="custom-model-id">模型 ID</Label>
              <Input
                id="custom-model-id"
                value={modelId}
                maxLength={MAX_MODEL_MARKETPLACE_CONFIG_KEY_LENGTH}
                placeholder="vendor-model-id"
                disabled={isSaving}
                required
                onChange={(event) => setModelId(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-model-category">模型类型</Label>
              <Select
                value={category}
                disabled={isSaving}
                onValueChange={handleCategoryChange}
              >
                <SelectTrigger id="custom-model-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="image">生图模型</SelectItem>
                  <SelectItem value="video">生视频模型</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="custom-model-resolutions">支持的分辨率</Label>
            <Input
              id="custom-model-resolutions"
              value={resolutions}
              disabled={isSaving}
              placeholder={category === "image" ? "1k, 2k, 4k" : "720p, 1080p"}
              required
              onChange={(event) => setResolutions(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              使用英文逗号分隔；账号选择器会同时显示这些能力。
            </p>
          </div>

          {category === "image" ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(
                [
                  ["base1024Credits", "1024 档"],
                  ["base1kCredits", "1K 档"],
                  ["base2kCredits", "2K 档"],
                  ["base4kCredits", "4K 档"],
                ] as const
              ).map(([field, label]) => (
                <div className="space-y-2" key={field}>
                  <Label htmlFor={`custom-${field}`}>{label}</Label>
                  <Input
                    id={`custom-${field}`}
                    type="number"
                    min="0.0001"
                    step="0.0001"
                    value={imagePrices[field]}
                    disabled={isSaving}
                    required
                    onChange={(event) =>
                      setImagePrices((current) => ({
                        ...current,
                        [field]: event.target.value,
                      }))
                    }
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="max-w-xs space-y-2">
              <Label htmlFor="custom-video-price">初始每秒积分</Label>
              <Input
                id="custom-video-price"
                type="number"
                min="0.0001"
                step="0.0001"
                value={videoPrice}
                disabled={isSaving}
                required
                onChange={(event) => setVideoPrice(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                创建后可在模型详情中分别调整每个分辨率的价格。
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? <Loader2 className="animate-spin" /> : null}
              创建模型
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
