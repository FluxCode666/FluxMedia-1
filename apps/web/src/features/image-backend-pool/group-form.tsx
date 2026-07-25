"use client";

/**
 * 统一媒体后端分组编辑表单。
 *
 * 职责：编辑分组公共属性、套餐门槛、层级关系以及图像/视频计费覆盖，并通过单一
 * saveGroup Action 持久化。组件只维护表单草稿，最终校验由共享契约和 UOL 完成。
 */
import { ADOBE_VIDEO_PRICING_FAMILIES } from "@repo/shared/adobe";
import type { BackendGroupSummary } from "@repo/shared/image-backend/group-contract";
import { DEFAULT_IMAGE_CREDIT_PRICING } from "@repo/shared/image-backend/group-image-pricing";
import { Button } from "@repo/ui/components/button";
import { Checkbox } from "@repo/ui/components/checkbox";
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
import { Textarea } from "@repo/ui/components/textarea";
import { Loader2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { saveImageBackendGroupAction } from "./actions";
import { BackendBooleanSetting } from "./boolean-setting";
import {
  type ImageCreditPricingDraft,
  ImageCreditPricingEditor,
  imageCreditOverridesToDraft,
  imageCreditPricingDraftToOverrides,
  updateImageCreditPricingDraft,
} from "./image-credit-pricing-editor";
import {
  updateVideoCreditPricingDraft,
  type VideoCreditPricingDraft,
  VideoCreditPricingEditor,
  videoCreditOverridesToDraft,
  videoCreditPricingDraftToOverrides,
} from "./video-credit-pricing-editor";

const PLAN_OPTIONS = [
  ["free", "Free"],
  ["starter", "Starter"],
  ["pro", "Pro"],
  ["ultra", "Ultra"],
  ["enterprise", "Enterprise"],
] as const;

/** 渲染新增或编辑分组的受控弹窗。 */
export function BackendGroupFormDialog({
  open,
  onOpenChange,
  group,
  groups,
  imageModelIds,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: BackendGroupSummary | null;
  groups: BackendGroupSummary[];
  imageModelIds: string[];
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("50");
  const [isEnabled, setIsEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [isUserSelectable, setIsUserSelectable] = useState(true);
  const [contentSafety, setContentSafety] = useState<
    "inherit" | "enabled" | "disabled"
  >("inherit");
  const [minPlan, setMinPlan] = useState<
    "free" | "starter" | "pro" | "ultra" | "enterprise"
  >("free");
  const [childGroupIds, setChildGroupIds] = useState<string[]>([]);
  const [imagePricing, setImagePricing] = useState<ImageCreditPricingDraft>({});
  const [videoPricing, setVideoPricing] = useState<VideoCreditPricingDraft>({});

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? "");
    setDescription(group?.description ?? "");
    setPriority(String(group?.priority ?? 50));
    setIsEnabled(group?.isEnabled ?? true);
    setIsDefault(group?.isDefault ?? groups.length === 0);
    setIsUserSelectable(group?.isUserSelectable ?? true);
    setContentSafety(group?.contentSafety ?? "inherit");
    setMinPlan(group?.minPlan ?? "free");
    setChildGroupIds(group?.childGroupIds ?? []);
    setImagePricing(
      imageCreditOverridesToDraft(
        group?.imageCreditOverrides ?? { version: 1, byModel: {} }
      )
    );
    setVideoPricing(
      videoCreditOverridesToDraft(
        ADOBE_VIDEO_PRICING_FAMILIES,
        group?.videoCreditOverrides ?? {}
      )
    );
  }, [group, groups.length, open]);

  const displayedImageModels = useMemo(
    () =>
      Array.from(
        new Set([...imageModelIds, ...Object.keys(imagePricing)])
      ).sort(),
    [imageModelIds, imagePricing]
  );

  const { execute: saveGroup, isPending } = useAction(
    saveImageBackendGroupAction,
    {
      onSuccess: () => {
        toast.success(group ? "分组已更新" : "分组已创建");
        onOpenChange(false);
        onSaved();
      },
      onError: ({ error }) => toast.error(error.serverError || "保存分组失败"),
    }
  );

  /** 切换一个子分组选择。 */
  function toggleChildGroup(groupId: string, checked: boolean): void {
    setChildGroupIds((current) =>
      checked
        ? Array.from(new Set([...current, groupId]))
        : current.filter((id) => id !== groupId)
    );
  }

  /** 将表单草稿提交给严格的统一分组 Action。 */
  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    saveGroup({
      ...(group ? { id: group.id } : {}),
      name,
      description,
      isEnabled,
      isDefault,
      isUserSelectable,
      contentSafety,
      minPlan,
      imageCreditOverrides: imageCreditPricingDraftToOverrides(imagePricing),
      videoCreditOverrides: videoCreditPricingDraftToOverrides(videoPricing),
      childGroupIds,
      priority: Number(priority),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <form className="space-y-6" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{group ? "编辑分组" : "新增分组"}</DialogTitle>
            <DialogDescription>
              分组只控制访问、内容安全和计费覆盖，不再划分 Web 或 Responses
              调度车道。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="group-name">名称</Label>
              <Input
                id="group-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-priority">优先级</Label>
              <Input
                id="group-priority"
                type="number"
                min="0"
                max="10000"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="group-description">说明</Label>
              <Textarea
                id="group-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={500}
              />
            </div>
            <div className="space-y-2">
              <Label>最低套餐</Label>
              <Select
                value={minPlan}
                onValueChange={(value) => setMinPlan(value as typeof minPlan)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_OPTIONS.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>内容安全</Label>
              <Select
                value={contentSafety}
                onValueChange={(value) =>
                  setContentSafety(value as typeof contentSafety)
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">继承成员</SelectItem>
                  <SelectItem value="enabled">强制开启</SelectItem>
                  <SelectItem value="disabled">强制关闭</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <BackendBooleanSetting
              id="group-enabled"
              label="启用分组"
              description="停用后新请求不会选择此组。"
              checked={isEnabled}
              onCheckedChange={setIsEnabled}
            />
            <BackendBooleanSetting
              id="group-default"
              label="默认分组"
              description="保存后自动取消其他默认组。"
              checked={isDefault}
              onCheckedChange={setIsDefault}
            />
            <BackendBooleanSetting
              id="group-selectable"
              label="用户可选择"
              description="允许具备套餐能力的用户手动选择。"
              checked={isUserSelectable}
              onCheckedChange={setIsUserSelectable}
            />
          </div>

          <div className="space-y-3">
            <div>
              <Label>子分组</Label>
              <p className="text-xs text-muted-foreground">
                可选层级关系会做自引用与循环检测。
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {groups
                .filter((candidate) => candidate.id !== group?.id)
                .map((candidate) => (
                  <label
                    key={candidate.id}
                    htmlFor={`child-group-${candidate.id}`}
                    className="flex items-center gap-2 rounded-md border p-3 text-sm"
                  >
                    <Checkbox
                      id={`child-group-${candidate.id}`}
                      checked={childGroupIds.includes(candidate.id)}
                      onCheckedChange={(checked) =>
                        toggleChildGroup(candidate.id, checked === true)
                      }
                    />
                    {candidate.name}
                  </label>
                ))}
              {groups.filter((candidate) => candidate.id !== group?.id)
                .length === 0 && (
                <p className="text-sm text-muted-foreground">
                  当前没有其他分组。
                </p>
              )}
            </div>
          </div>

          <details className="rounded-md border p-4">
            <summary className="cursor-pointer font-medium">
              图像模型积分覆盖
            </summary>
            <div className="mt-4">
              {displayedImageModels.length > 0 ? (
                <ImageCreditPricingEditor
                  models={displayedImageModels}
                  draft={imagePricing}
                  inheritanceLabel="继承全局价格"
                  resolveInheritedPricing={() => DEFAULT_IMAGE_CREDIT_PRICING}
                  onChange={(model, field, value) =>
                    setImagePricing((current) =>
                      updateImageCreditPricingDraft(
                        current,
                        model,
                        field,
                        value
                      )
                    )
                  }
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  保存成员并声明图像模型后，可在此配置分组覆盖价格。
                </p>
              )}
            </div>
          </details>

          <details className="rounded-md border p-4">
            <summary className="cursor-pointer font-medium">
              视频模型每秒积分覆盖
            </summary>
            <div className="mt-4">
              <VideoCreditPricingEditor
                families={ADOBE_VIDEO_PRICING_FAMILIES}
                draft={videoPricing}
                inheritanceLabel="继承全局价格"
                resolveInheritedPrice={() => 30}
                onChange={(family, value) =>
                  setVideoPricing((current) =>
                    updateVideoCreditPricingDraft(current, family, value)
                  )
                }
              />
            </div>
          </details>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              保存分组
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
