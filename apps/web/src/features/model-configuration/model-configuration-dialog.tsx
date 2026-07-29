"use client";

/**
 * 单模型配置查看与编辑 Dialog。
 *
 * 使用方是模型配置列表；本组件只维护本地草稿并调用 Task 5 multipart Route。会话、权限、
 * revision、幂等、价格、封面处理和审计仍由 UOL 服务端最终裁决。
 */
import {
  MAX_MODEL_MARKETPLACE_DESCRIPTION_LENGTH,
  MAX_MODEL_MARKETPLACE_HOMEPAGE_PRIORITY,
  type ModelConfigurationEntry,
} from "@repo/shared/model-marketplace";
import { Badge } from "@repo/ui/components/badge";
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
import { Switch } from "@repo/ui/components/switch";
import { Textarea } from "@repo/ui/components/textarea";
import { Copy, Loader2, RefreshCw } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ModelBrandIcon } from "@/features/model-marketplace/model-brand-icon";

import {
  buildModelConfigurationFormData,
  createModelConfigurationDraft,
  type ModelConfigurationDraft,
  ModelConfigurationDraftError,
  rebaseModelConfigurationDraft,
  renewModelConfigurationDraftRequestId,
} from "./model-configuration-draft";
import {
  getModelConfigurationCategoryLabel,
  getModelConfigurationDialogFields,
  getModelConfigurationSaveErrorMessage,
} from "./model-configuration-view-model";
import { ModelCoverField } from "./model-cover-field";

const IMAGE_PRICE_FIELDS = [
  ["base1024Credits", "1024 档"],
  ["base1kCredits", "1K 档"],
  ["base2kCredits", "2K 档"],
  ["base4kCredits", "4K 档"],
] as const;

export type ModelConfigurationDialogProps = {
  entry: ModelConfigurationEntry;
  canEdit: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReloadEntry: () => Promise<ModelConfigurationEntry | null>;
  onSaved: () => Promise<void>;
};

/** 从未知错误响应中读取稳定 code，不消费或展示服务端内部消息。 */
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
    // 无 JSON 响应按通用保存失败处理，不向用户显示代理或框架返回的正文。
  }
  return null;
}

/**
 * 渲染一项紧凑价格输入。
 *
 * @param props - 唯一字段 ID、标签、值、只读状态与变更回调。
 * @returns 与当前后台主题一致的 label + number input。
 * @sideEffects 用户输入时调用 onChange；不自行保存。
 */
function PricingInput({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min="0.0001"
        step="0.0001"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/**
 * 渲染单模型价格、展示设置和封面草稿。
 *
 * @param props - 当前条目、服务端权限、受控开关以及重新读取和保存完成回调。
 * @returns 可访问的响应式 Dialog；observer/admin 自动进入完整只读形态。
 * @sideEffects 复制 ID、选择本地文件、POST multipart、重新读取快照和显示 toast。
 * @failure 保存失败保留草稿；冲突禁用重复提交并提供在最新 revision 上重放草稿的操作。
 */
export function ModelConfigurationDialog({
  entry,
  canEdit,
  open,
  onOpenChange,
  onReloadEntry,
  onSaved,
}: ModelConfigurationDialogProps) {
  const [draft, setDraft] = useState<ModelConfigurationDraft>(() =>
    createModelConfigurationDraft(entry)
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [hasConflict, setHasConflict] = useState(false);
  const wasOpenRef = useRef(false);
  const fields = getModelConfigurationDialogFields(entry, canEdit);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setDraft(createModelConfigurationDraft(entry));
      setHasConflict(false);
    }
    wasOpenRef.current = open;
  }, [entry, open]);

  /** 合并一次用户修改并立即轮换下一次主动保存的幂等 UUID。 */
  const updateDraft = (
    updater: (current: ModelConfigurationDraft) => ModelConfigurationDraft
  ): void => {
    setDraft((current) =>
      renewModelConfigurationDraftRequestId(updater(current))
    );
    setHasConflict(false);
  };

  /** 复制完整配置键；按钮仅显示图标并紧随 ID。 */
  const handleCopyModelId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.configKey);
      toast.success("模型 ID 已复制");
    } catch {
      toast.error("复制失败，请手动选择模型 ID");
    }
  };

  /** 在冲突后的最新服务端 revision 上重放本地草稿。 */
  const handleReloadAfterConflict = async (): Promise<void> => {
    setIsReloading(true);
    try {
      const latestEntry = await onReloadEntry();
      if (!latestEntry) {
        toast.error("重新加载失败，请稍后再试");
        return;
      }
      setDraft((current) =>
        rebaseModelConfigurationDraft(current, latestEntry)
      );
      setHasConflict(false);
      toast.success("已加载最新版本，并保留本地草稿");
    } catch {
      toast.error("重新加载失败，请稍后再试");
    } finally {
      setIsReloading(false);
    }
  };

  /** 提交严格 FormData；未修改草稿的网络重试会复用同一 clientRequestId。 */
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canEdit || hasConflict) return;
    let formData: FormData;
    try {
      formData = buildModelConfigurationFormData(draft);
    } catch (error) {
      toast.error(
        error instanceof ModelConfigurationDraftError
          ? error.message
          : "请检查模型配置字段"
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
        const code = await readStableErrorCode(response);
        if (code === "conflict") {
          setHasConflict(true);
          toast.error("模型配置已更新，请重新加载后再保存");
          return;
        }
        toast.error(getModelConfigurationSaveErrorMessage(code));
        return;
      }
      toast.success("模型配置已保存");
      await onSaved();
      onOpenChange(false);
    } catch {
      toast.error("网络异常，重试会继续使用同一保存标识");
    } finally {
      setIsSaving(false);
    }
  };

  const disabled = !canEdit || isSaving || isReloading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          <DialogHeader>
            <div className="flex items-start gap-3 pr-8">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
                <ModelBrandIcon iconKey={entry.iconKey} size={22} />
              </div>
              <div className="min-w-0 space-y-1 text-left">
                <DialogTitle>{entry.displayName}</DialogTitle>
                <div className="flex min-w-0 items-center gap-1">
                  <code className="truncate text-xs text-muted-foreground">
                    {entry.configKey}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="复制模型 ID"
                    title="复制模型 ID"
                    onClick={handleCopyModelId}
                  >
                    <Copy />
                  </Button>
                </div>
              </div>
              <Badge
                variant="outline"
                className="ml-auto hidden sm:inline-flex"
              >
                {getModelConfigurationCategoryLabel(entry)}
              </Badge>
            </div>
            <DialogDescription className="text-left">
              {canEdit
                ? "价格、模型广场与官网首页展示信息会作为一个模型条目原子保存。"
                : "当前账号拥有查看权限，但只有超级管理员可以修改。"}
            </DialogDescription>
          </DialogHeader>

          <section className="space-y-3 rounded-lg border p-4">
            <div>
              <h3 className="text-sm font-medium">计费价格</h3>
              <p className="text-xs text-muted-foreground">
                {entry.category === "video"
                  ? "视频按输出分辨率对应的每秒积分乘以实际生成时长计费。"
                  : "图像按最终输出像素命中对应档位计费。"}
              </p>
            </div>
            {entry.category === "image" &&
            entry.pricingSource === "unconfigured" ? (
              <p
                role="status"
                className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-foreground"
              >
                该模型尚未配置价格，当前不会进入模型广场，也不能执行计费。请填写完整四档价格后保存。
              </p>
            ) : null}
            {fields.showImagePricing && draft.category === "image" ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {IMAGE_PRICE_FIELDS.map(([field, label]) => (
                  <PricingInput
                    key={field}
                    id={`${entry.category}-${entry.configKey}-${field}`}
                    label={label}
                    value={draft.pricing[field]}
                    disabled={disabled}
                    onChange={(value) =>
                      updateDraft((current) => {
                        if (current.category !== "image") return current;
                        return {
                          ...current,
                          pricing: { ...current.pricing, [field]: value },
                        };
                      })
                    }
                  />
                ))}
              </div>
            ) : null}
            {fields.showVideoPricing && draft.category === "video" ? (
              <div className="grid gap-3 sm:grid-cols-3">
                {entry.category === "video"
                  ? entry.supportedResolutions.map((resolution) => (
                      <PricingInput
                        key={resolution}
                        id={`${entry.configKey}-${resolution}-credits-per-second`}
                        label={`${resolution} 每秒积分`}
                        value={
                          draft.creditsPerSecondByResolution[resolution] ?? ""
                        }
                        disabled={disabled}
                        onChange={(value) =>
                          updateDraft((current) =>
                            current.category === "video"
                              ? {
                                  ...current,
                                  creditsPerSecondByResolution: {
                                    ...current.creditsPerSecondByResolution,
                                    [resolution]: value,
                                  },
                                }
                              : current
                          )
                        }
                      />
                    ))
                  : null}
              </div>
            ) : null}
          </section>

          {fields.showMarketplaceFields && entry.marketplaceApplicable ? (
            <section className="grid gap-5 rounded-lg border p-4 md:grid-cols-[minmax(0,1fr)_280px]">
              <div className="space-y-5">
                <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/40 p-3">
                  <div>
                    <Label htmlFor={`${entry.configKey}-visible`}>
                      展示在模型广场
                    </Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      此开关不影响模型调度、创作目录或实际计费。
                    </p>
                  </div>
                  <Switch
                    id={`${entry.configKey}-visible`}
                    checked={draft.visible}
                    disabled={disabled}
                    onCheckedChange={(visible) =>
                      updateDraft((current) => ({
                        ...current,
                        visible,
                        homepageVisible: visible
                          ? current.homepageVisible
                          : false,
                      }))
                    }
                  />
                </div>
                <div className="space-y-3 rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <Label htmlFor={`${entry.configKey}-homepage-visible`}>
                        展示在官网首页
                      </Label>
                      <p className="mt-1 text-xs text-muted-foreground">
                        仅模型广场已展示的模型可以进入首页精选格子。
                      </p>
                    </div>
                    <Switch
                      id={`${entry.configKey}-homepage-visible`}
                      checked={draft.homepageVisible}
                      disabled={disabled || !draft.visible}
                      onCheckedChange={(homepageVisible) =>
                        updateDraft((current) => ({
                          ...current,
                          homepageVisible,
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${entry.configKey}-homepage-priority`}>
                      首页优先级
                    </Label>
                    <Input
                      id={`${entry.configKey}-homepage-priority`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={MAX_MODEL_MARKETPLACE_HOMEPAGE_PRIORITY}
                      step={1}
                      value={draft.homepagePriority}
                      disabled={disabled || !draft.homepageVisible}
                      onChange={(event) =>
                        updateDraft((current) => ({
                          ...current,
                          homepagePriority: event.target.value,
                        }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      数字越小越优先；默认 5。首页格子已满时不展示后续模型。
                    </p>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-4">
                    <Label htmlFor={`${entry.configKey}-description`}>
                      模型简介
                    </Label>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {draft.description.length}/
                      {MAX_MODEL_MARKETPLACE_DESCRIPTION_LENGTH}
                    </span>
                  </div>
                  <Textarea
                    id={`${entry.configKey}-description`}
                    value={draft.description}
                    maxLength={MAX_MODEL_MARKETPLACE_DESCRIPTION_LENGTH}
                    disabled={disabled}
                    rows={5}
                    placeholder="说明该模型适合的任务和主要特点"
                    onChange={(event) =>
                      updateDraft((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                  />
                </div>
              </div>
              <ModelCoverField
                category={draft.category}
                currentCoverUrl={entry.coverUrl ?? ""}
                usesDefaultCover={entry.usesDefaultCover}
                value={draft.cover}
                disabled={!fields.showCoverActions || isSaving || isReloading}
                onChange={(cover) =>
                  updateDraft((current) => ({ ...current, cover }))
                }
              />
            </section>
          ) : null}

          {hasConflict ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
            >
              该模型已被其他管理员更新。重新加载会采用最新
              revision，同时保留当前价格、首页排序、简介和封面草稿。
            </div>
          ) : null}

          <DialogFooter className="gap-2">
            {hasConflict ? (
              <Button
                type="button"
                variant="outline"
                disabled={isReloading}
                onClick={handleReloadAfterConflict}
              >
                {isReloading ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                重新加载最新版本
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              关闭
            </Button>
            {fields.canSave ? (
              <Button type="submit" disabled={disabled || hasConflict}>
                {isSaving ? <Loader2 className="animate-spin" /> : null}
                保存模型配置
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
