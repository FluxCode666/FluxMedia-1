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
  modelMarketplaceVideoOutputSizesByResolutionSchema,
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
import { Switch } from "@repo/ui/components/switch";
import { Textarea } from "@repo/ui/components/textarea";
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

const INITIAL_IMAGE_RESOLUTIONS = "1k, 2k, 4k, 8k";
const INITIAL_VIDEO_RESOLUTIONS = "480p, 720p, 1080p, 2k, 4k, 8k";

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

/** 解析自定义视频专属分辨率的输出像素 JSON。 */
function parseVideoOutputSizes(
  value: string,
  modelId: string,
  supportedResolutions: readonly string[]
):
  | Record<string, Record<string, { width: number; height: number }>>
  | undefined {
  if (!value.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ModelConfigurationDraftError("输出像素映射必须是有效 JSON");
  }
  try {
    const outputSizesByResolution =
      modelMarketplaceVideoOutputSizesByResolutionSchema.parse(parsed);
    modelMarketplaceCustomModelSchema.parse({
      modelId,
      category: "video",
      supportedResolutions,
      outputSizesByResolution,
    });
    return outputSizesByResolution;
  } catch {
    throw new ModelConfigurationDraftError(
      "输出像素映射格式无效，键须为分辨率，值须按 1:1/4:3/3:4/16:9/9:16/21:9 提供 width/height"
    );
  }
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
  const [videoOutputSizes, setVideoOutputSizes] = useState("");
  const [imagePrices, setImagePrices] = useState({
    base1024Credits: "1.27",
    base1kCredits: "1.27",
    base2kCredits: "5.07",
    base4kCredits: "10",
    base8kCredits: "20",
  });
  const [supportsQuality, setSupportsQuality] = useState(false);
  const [supportsAutoSize, setSupportsAutoSize] = useState(false);
  const [videoBillingMode, setVideoBillingMode] = useState<
    "per_second" | "per_item"
  >("per_second");
  const [videoPricePerSecond, setVideoPricePerSecond] = useState("30");
  const [videoPricePerItem, setVideoPricePerItem] = useState("3");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCategory("image");
    setModelId("");
    setResolutions(INITIAL_IMAGE_RESOLUTIONS);
    setVideoOutputSizes("");
    setImagePrices({
      base1024Credits: "1.27",
      base1kCredits: "1.27",
      base2kCredits: "5.07",
      base4kCredits: "10",
      base8kCredits: "20",
    });
    setSupportsQuality(false);
    setSupportsAutoSize(false);
    setVideoBillingMode("per_second");
    setVideoPricePerSecond("30");
    setVideoPricePerItem("3");
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
    setVideoOutputSizes("");
  }

  /** 构造严格 multipart 并创建新的自定义模型定义与初始价格。 */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedModelId = modelId.trim();
    let supportedResolutions: string[];
    let outputSizesByResolution:
      | Record<string, Record<string, { width: number; height: number }>>
      | undefined;
    try {
      supportedResolutions = parseSupportedResolutions(
        resolutions,
        normalizedModelId,
        category
      );
      if (category === "video") {
        outputSizesByResolution = parseVideoOutputSizes(
          videoOutputSizes,
          normalizedModelId,
          supportedResolutions
        );
      }
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
    formData.append("enabled", "true");
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
        formData.append("supportsQuality", String(supportsQuality));
        formData.append("supportsAutoSize", String(supportsAutoSize));
        for (const [field, value] of Object.entries(imagePrices)) {
          formData.append(field, String(parseModelConfigurationPrice(value)));
        }
      } else {
        const perSecond = parseModelConfigurationPrice(videoPricePerSecond);
        const perItem = parseModelConfigurationPrice(videoPricePerItem);
        formData.append("billingMode", videoBillingMode);
        formData.append(
          "creditsPerSecondByResolution",
          JSON.stringify(
            Object.fromEntries(
              supportedResolutions.map((resolution) => [resolution, perSecond])
            )
          )
        );
        formData.append(
          "creditsPerItemByResolution",
          JSON.stringify(
            Object.fromEntries(
              supportedResolutions.map((resolution) => [resolution, perItem])
            )
          )
        );
        if (outputSizesByResolution) {
          formData.append(
            "outputSizesByResolution",
            JSON.stringify(outputSizesByResolution)
          );
        }
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
              placeholder={
                category === "image"
                  ? "1k, 2k, 4k, 8k"
                  : "480p, 720p, 1080p, 2k, 4k, 8k"
              }
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
                  ["base1kCredits", "1K 档"],
                  ["base2kCredits", "2K 档"],
                  ["base4kCredits", "4K 档"],
                  ["base8kCredits", "8K 档"],
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
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="custom-video-billing-mode">生效计费模式</Label>
                <Select
                  value={videoBillingMode}
                  disabled={isSaving}
                  onValueChange={(value) =>
                    setVideoBillingMode(
                      value === "per_item" ? "per_item" : "per_second"
                    )
                  }
                >
                  <SelectTrigger id="custom-video-billing-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="per_second">按秒计费</SelectItem>
                    <SelectItem value="per_item">按条计费</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="custom-video-price-per-second">
                  初始每秒积分
                </Label>
                <Input
                  id="custom-video-price-per-second"
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  value={videoPricePerSecond}
                  disabled={isSaving}
                  required
                  onChange={(event) =>
                    setVideoPricePerSecond(event.target.value)
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="custom-video-price-per-item">
                  初始每条积分
                </Label>
                <Input
                  id="custom-video-price-per-item"
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  value={videoPricePerItem}
                  disabled={isSaving}
                  required
                  onChange={(event) => setVideoPricePerItem(event.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-3">
                两套价格都会保存；切换生效模式不会删除另一套价格。
              </p>
              <div className="space-y-2 sm:col-span-3">
                <Label htmlFor="custom-video-output-sizes">
                  专属分辨率输出像素（可选 JSON）
                </Label>
                <Textarea
                  id="custom-video-output-sizes"
                  value={videoOutputSizes}
                  disabled={isSaving}
                  placeholder={
                    '{"studio-hd":{"16:9":{"width":1920,"height":1080}}}'
                  }
                  onChange={(event) => setVideoOutputSizes(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  标准 480p/720p/1080p/2k/4k/8k
                  会自动推导；其它标签必须为每种宽高比提供像素映射。
                </p>
              </div>
            </div>
          )}

          {category === "image" ? (
            <div className="space-y-3 rounded-md border px-3 py-2">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="custom-model-supports-quality">
                    支持质量参数
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    关闭后生图页面不展示质量选项，也不会向供应商传递 quality。
                  </p>
                </div>
                <Switch
                  id="custom-model-supports-quality"
                  checked={supportsQuality}
                  disabled={isSaving}
                  onCheckedChange={setSupportsQuality}
                />
              </div>
              <div className="flex items-center justify-between gap-4 border-t pt-3">
                <div>
                  <Label htmlFor="custom-model-supports-auto-size">
                    支持 auto 尺寸
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    关闭后站内生图必须选择明确尺寸，模型广场会标注不支持传
                    auto。
                  </p>
                </div>
                <Switch
                  id="custom-model-supports-auto-size"
                  checked={supportsAutoSize}
                  disabled={isSaving}
                  onCheckedChange={setSupportsAutoSize}
                />
              </div>
            </div>
          ) : null}

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
