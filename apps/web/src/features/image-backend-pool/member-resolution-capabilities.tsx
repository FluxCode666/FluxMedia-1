"use client";

import type { ApiVideoInputCapabilitiesByModel } from "@repo/shared/image-backend/api-upstream-adaptation";
/**
 * 供应商账号按模型配置输入与分辨率能力。
 *
 * 每个模型可以继承模型配置页的全局能力，或保存一份账号级子集。缺失模型键表示
 * 继承；切回继承会删除账号级覆盖，避免把当前全局值固化为账号配置。
 */
import { Badge } from "@repo/ui/components/badge";
import { Checkbox } from "@repo/ui/components/checkbox";
import { Label } from "@repo/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@repo/ui/components/radio-group";
import { useId } from "react";
import { toast } from "sonner";

import type { BackendMemberModelOption } from "./member-model-options";

export type MemberResolutionCapabilities = Record<string, string[]>;
export type MemberResolutionCapabilityMode = "inherit" | "custom";

interface ResolutionSelectionResult {
  capabilities: MemberResolutionCapabilities;
  rejected: boolean;
}

/**
 * 更新一个模型的参考媒体能力；两项均关闭时移除稀疏配置。
 *
 * @param capabilities 当前账号按模型保存的输入能力。
 * @param modelId 当前平台视频模型 ID。
 * @param capability 要更新的参考视频或参考音频能力。
 * @param enabled 是否允许该输入。
 * @returns 保留其他模型且模型键规范为小写的新对象。
 * @sideEffects 无；从不原地修改输入。
 */
export function setMemberVideoInputCapability(
  capabilities: Readonly<ApiVideoInputCapabilitiesByModel>,
  modelId: string,
  capability: "referenceVideos" | "referenceAudios",
  enabled: boolean
): ApiVideoInputCapabilitiesByModel {
  const key = modelId.trim().toLowerCase();
  const remaining = Object.fromEntries(
    Object.entries(capabilities).filter(
      ([candidate]) => candidate.trim().toLowerCase() !== key
    )
  );
  const next = {
    referenceVideos: capabilities[key]?.referenceVideos ?? false,
    referenceAudios: capabilities[key]?.referenceAudios ?? false,
    [capability]: enabled,
  };
  return next.referenceVideos || next.referenceAudios
    ? { ...remaining, [key]: next }
    : remaining;
}

/** 把只读能力快照复制为 React 表单可写状态。 */
function cloneMemberResolutionCapabilities(
  capabilities: Readonly<Record<string, readonly string[]>>
): MemberResolutionCapabilities {
  return Object.fromEntries(
    Object.entries(capabilities).map(([modelId, resolutions]) => [
      modelId,
      [...resolutions],
    ])
  );
}

/** 返回大小写无关的账号级模型覆盖。 */
export function getMemberResolutionOverride(
  capabilities: Readonly<Record<string, readonly string[]>>,
  modelId: string
): readonly string[] | undefined {
  const key = modelId.trim().toLowerCase();
  return Object.entries(capabilities).find(
    ([candidate]) => candidate.trim().toLowerCase() === key
  )?.[1];
}

/** 删除指定模型的既有键，其他模型的配置与顺序保持不变。 */
function withoutModelResolutionOverride(
  capabilities: Readonly<Record<string, readonly string[]>>,
  modelId: string
): MemberResolutionCapabilities {
  const key = modelId.trim().toLowerCase();
  return Object.fromEntries(
    Object.entries(capabilities).flatMap(([candidate, resolutions]) =>
      candidate.trim().toLowerCase() === key
        ? []
        : [[candidate, [...resolutions]]]
    )
  );
}

/**
 * 切换一个模型的账号能力模式。
 *
 * 进入自定义时以当前全局能力为初值；回到继承时彻底移除该模型的账号键。
 */
export function setMemberResolutionCapabilityMode(
  capabilities: Readonly<Record<string, readonly string[]>>,
  modelId: string,
  globalResolutions: readonly string[],
  mode: MemberResolutionCapabilityMode
): MemberResolutionCapabilities {
  const key = modelId.trim().toLowerCase();
  const remaining = withoutModelResolutionOverride(capabilities, modelId);
  if (mode === "inherit") return remaining;

  const existing = getMemberResolutionOverride(capabilities, modelId);
  return {
    ...remaining,
    [key]: [...(existing?.length ? existing : globalResolutions)],
  };
}

/**
 * 更新一个自定义分辨率，并拒绝移除最后一个分辨率。
 */
export function setMemberResolutionSelected(
  capabilities: Readonly<Record<string, readonly string[]>>,
  modelId: string,
  globalResolutions: readonly string[],
  resolution: string,
  selected: boolean
): ResolutionSelectionResult {
  const key = modelId.trim().toLowerCase();
  const current = getMemberResolutionOverride(capabilities, modelId);
  if (!current) {
    return {
      capabilities: cloneMemberResolutionCapabilities(capabilities),
      rejected: false,
    };
  }

  const selectedSet = new Set(current);
  if (selected) selectedSet.add(resolution);
  else selectedSet.delete(resolution);
  const nextResolutions = globalResolutions.filter((candidate) =>
    selectedSet.has(candidate)
  );
  if (nextResolutions.length === 0) {
    return {
      capabilities: cloneMemberResolutionCapabilities(capabilities),
      rejected: true,
    };
  }

  return {
    capabilities: {
      ...withoutModelResolutionOverride(capabilities, modelId),
      [key]: nextResolutions,
    },
    rejected: false,
  };
}

/** 渲染所有已选择模型的继承/自定义账号能力。 */
export function MemberResolutionCapabilitiesEditor({
  modelIds,
  modelOptions,
  value,
  disabled = false,
  onChange,
  videoInputCapabilitiesByModel = {},
  onVideoInputCapabilitiesChange,
}: {
  modelIds: readonly string[];
  modelOptions: readonly BackendMemberModelOption[];
  value: Readonly<Record<string, readonly string[]>>;
  disabled?: boolean;
  onChange: (value: MemberResolutionCapabilities) => void;
  videoInputCapabilitiesByModel?: Readonly<ApiVideoInputCapabilitiesByModel>;
  onVideoInputCapabilitiesChange?: (
    value: ApiVideoInputCapabilitiesByModel
  ) => void;
}) {
  const idPrefix = useId();

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium">模型级能力配置</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          视频和音频输入能力按视频模型独立声明；分辨率默认跟随模型配置页，也可按账号覆盖。
        </p>
      </div>

      <div className="divide-y rounded-md border">
        {modelIds.map((modelId, index) => {
          const option = modelOptions.find(
            (candidate) =>
              candidate.id.trim().toLowerCase() === modelId.trim().toLowerCase()
          );
          const globalResolutions = option?.supportedResolutions ?? [];
          const override = getMemberResolutionOverride(value, modelId);
          const mode: MemberResolutionCapabilityMode = override
            ? "custom"
            : "inherit";
          const modelControlId = `${idPrefix}-${index}`;
          const descriptionId = `${modelControlId}-description`;

          return (
            <section
              aria-labelledby={`${modelControlId}-title`}
              className="space-y-3 p-4 first:rounded-t-md last:rounded-b-md"
              key={modelId}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span
                  className="min-w-0 break-all text-sm font-medium"
                  id={`${modelControlId}-title`}
                >
                  {option?.label ?? modelId}
                </span>
                <Badge variant="outline">
                  {option?.category === "video" ? "视频" : "图片"}
                </Badge>
                {option?.label && option.label !== modelId ? (
                  <code className="break-all text-xs text-muted-foreground">
                    {modelId}
                  </code>
                ) : null}
              </div>

              {option?.category === "video" &&
              onVideoInputCapabilitiesChange ? (
                <div className="space-y-2 rounded-md border bg-background p-3">
                  <div>
                    <span className="text-xs font-medium">参考媒体输入</span>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      只影响当前模型，请按该供应商账号的实际协议能力选择。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    <Label
                      className="flex items-center gap-2 text-xs font-normal"
                      htmlFor={`${modelControlId}-reference-video`}
                    >
                      <Checkbox
                        checked={
                          videoInputCapabilitiesByModel[
                            modelId.trim().toLowerCase()
                          ]?.referenceVideos ?? false
                        }
                        disabled={disabled}
                        id={`${modelControlId}-reference-video`}
                        onCheckedChange={(checked) =>
                          onVideoInputCapabilitiesChange(
                            setMemberVideoInputCapability(
                              videoInputCapabilitiesByModel,
                              modelId,
                              "referenceVideos",
                              checked === true
                            )
                          )
                        }
                      />
                      支持参考视频输入
                    </Label>
                    <Label
                      className="flex items-center gap-2 text-xs font-normal"
                      htmlFor={`${modelControlId}-reference-audio`}
                    >
                      <Checkbox
                        checked={
                          videoInputCapabilitiesByModel[
                            modelId.trim().toLowerCase()
                          ]?.referenceAudios ?? false
                        }
                        disabled={disabled}
                        id={`${modelControlId}-reference-audio`}
                        onCheckedChange={(checked) =>
                          onVideoInputCapabilitiesChange(
                            setMemberVideoInputCapability(
                              videoInputCapabilitiesByModel,
                              modelId,
                              "referenceAudios",
                              checked === true
                            )
                          )
                        }
                      />
                      支持参考音频输入
                    </Label>
                  </div>
                </div>
              ) : null}

              {globalResolutions.length > 0 ? (
                <>
                  <RadioGroup
                    aria-describedby={descriptionId}
                    aria-label={`${modelId} 的分辨率能力模式`}
                    className="grid gap-2 sm:grid-cols-2"
                    disabled={disabled}
                    onValueChange={(nextMode) =>
                      onChange(
                        setMemberResolutionCapabilityMode(
                          value,
                          modelId,
                          globalResolutions,
                          nextMode as MemberResolutionCapabilityMode
                        )
                      )
                    }
                    value={mode}
                  >
                    <Label
                      className="flex cursor-pointer items-start gap-2 rounded-md border bg-background px-3 py-2 font-normal has-[[data-state=checked]]:border-primary"
                      htmlFor={`${modelControlId}-inherit`}
                    >
                      <RadioGroupItem
                        className="mt-0.5"
                        id={`${modelControlId}-inherit`}
                        value="inherit"
                      />
                      <span>
                        <span className="block text-sm font-medium">
                          继承全局
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          全局配置更新后自动生效
                        </span>
                      </span>
                    </Label>
                    <Label
                      className="flex cursor-pointer items-start gap-2 rounded-md border bg-background px-3 py-2 font-normal has-[[data-state=checked]]:border-primary"
                      htmlFor={`${modelControlId}-custom`}
                    >
                      <RadioGroupItem
                        className="mt-0.5"
                        id={`${modelControlId}-custom`}
                        value="custom"
                      />
                      <span>
                        <span className="block text-sm font-medium">
                          自定义
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          仅此账号使用所选分辨率
                        </span>
                      </span>
                    </Label>
                  </RadioGroup>

                  <div id={descriptionId}>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium">
                        {mode === "inherit"
                          ? "全局支持的分辨率"
                          : "该账号支持的分辨率"}
                      </span>
                      <Badge
                        variant={mode === "inherit" ? "secondary" : "outline"}
                      >
                        {mode === "inherit" ? "只读继承" : "账号覆盖"}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {globalResolutions.map((resolution) => {
                        const checked = (
                          override ?? globalResolutions
                        ).includes(resolution);
                        const checkboxId = `${modelControlId}-resolution-${resolution}`;
                        return (
                          <Label
                            className="flex items-center gap-1.5 text-xs font-normal"
                            htmlFor={checkboxId}
                            key={resolution}
                          >
                            <Checkbox
                              aria-label={`${modelId} 支持 ${resolution}`}
                              checked={checked}
                              disabled={disabled || mode === "inherit"}
                              id={checkboxId}
                              onCheckedChange={(next) => {
                                const result = setMemberResolutionSelected(
                                  value,
                                  modelId,
                                  globalResolutions,
                                  resolution,
                                  next === true
                                );
                                if (result.rejected) {
                                  toast.error("至少保留一个支持的分辨率");
                                  return;
                                }
                                onChange(result.capabilities);
                              }}
                            />
                            {resolution}
                          </Label>
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : (
                <p className="rounded-md border border-dashed bg-background px-3 py-2 text-xs text-muted-foreground">
                  模型配置页中没有该模型的分辨率能力，当前账号只能继承全局配置。
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
