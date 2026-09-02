"use client";

import type { ApiModelMapping } from "@repo/shared/image-backend/api-upstream-adaptation";
/**
 * 统一媒体后端成员编辑表单。
 *
 * 职责：以 API 单一入口编辑公共调度字段、显式模型能力和适配配置
 * 配置。新增流程只收集账号接入所需的基础信息，适配细节由账号详情页配置。
 * 成员类型在编辑时不可原地切换，secret 留空由服务端保留既有值。
 */
import type { BackendGroupSummary } from "@repo/shared/image-backend/group-contract";
import type { BackendMemberType } from "@repo/shared/image-backend/member-contract";
import {
  isLegacyVideoModelId,
  normalizeSupportedModelIds,
} from "@repo/shared/image-backend/supported-models";
import { normalizeVideoModelId } from "@repo/shared/video-generation";
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
import { Loader2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  listImageSizeConfigsAction,
  saveImageBackendMemberAction,
} from "./actions";
import {
  type ApiUpstreamAdapterFormDraft,
  createDefaultApiUpstreamAdapterFormDraft,
} from "./api-upstream-adapter-draft";
import { ApiUpstreamAdapterForm } from "./api-upstream-adapter-form";
import { BackendBooleanSetting } from "./boolean-setting";
import { MemberDetailSection } from "./member-detail-section";
import {
  acceptsVideoBackendMemberModels,
  type BackendMemberModelOption,
  createExistingMemberModelOption,
} from "./member-model-options";
import {
  type BackendMemberModelOptionStatus,
  BackendMemberModelSelect,
} from "./member-model-select";
import { MemberResolutionCapabilitiesEditor } from "./member-resolution-capabilities";
import type { BackendMemberAdminSummary } from "./member-service";

/** 新建账号在详情配置前使用的安全图像能力占位 ID。 */
const DEFAULT_NEW_MEMBER_MODEL_ID = "gpt-image-2";

/** 渲染 API 成员的新增/编辑弹窗。 */
export function BackendMemberFormDialog({
  open,
  onOpenChange,
  member,
  groups,
  modelOptions,
  modelOptionStatus,
  onSaved,
  inline = false,
  detailsOnly = false,
  readOnly = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: BackendMemberAdminSummary | null;
  groups: BackendGroupSummary[];
  modelOptions: readonly BackendMemberModelOption[];
  modelOptionStatus: BackendMemberModelOptionStatus;
  onSaved: () => void | Promise<void>;
  /** 在账号详情页内联渲染，不创建 Dialog。 */
  inline?: boolean;
  /** 详情页只展示适配细节，公共账号字段沿用已有成员值。 */
  detailsOnly?: boolean;
  /** 观察员角色只读时禁用表单控件和保存按钮。 */
  readOnly?: boolean;
}) {
  const [type, setType] = useState<BackendMemberType>("api");
  const [name, setName] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [supportedResolutionsByModel, setSupportedResolutionsByModel] =
    useState<Record<string, string[]>>({});
  const [contentSafetyEnabled, setContentSafetyEnabled] = useState(true);
  const [isEnabled, setIsEnabled] = useState(true);
  const [alwaysActive, setAlwaysActive] = useState(true);
  const [failureCooldownEnabled, setFailureCooldownEnabled] = useState(false);
  const [priority, setPriority] = useState("50");
  const [concurrency, setConcurrency] = useState("10");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiUseStream, setApiUseStream] = useState(false);
  const [imageSizeConfigs, setImageSizeConfigs] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [imageSizeConfigId, setImageSizeConfigId] = useState("");
  const [imageSizeConfigIdsByModel, setImageSizeConfigIdsByModel] = useState<
    Record<string, string>
  >({});
  const [modelMappings, setModelMappings] = useState<ApiModelMapping[]>([]);
  const [apiAdapterDraft, setApiAdapterDraft] =
    useState<ApiUpstreamAdapterFormDraft>(() =>
      createDefaultApiUpstreamAdapterFormDraft()
    );

  useEffect(() => {
    if (!open) return;
    setType("api");
    setName(member?.name ?? "");
    setGroupIds(member?.groupIds ?? (groups[0] ? [groups[0].id] : []));
    const defaultModelId =
      modelOptions.find((option) => option.category === "image")?.id ??
      DEFAULT_NEW_MEMBER_MODEL_ID;
    setSelectedModelIds(member?.supportedModelIds ?? [defaultModelId]);
    setSupportedResolutionsByModel(member?.supportedResolutionsByModel ?? {});
    setContentSafetyEnabled(member?.contentSafetyEnabled ?? true);
    setIsEnabled(member?.isEnabled ?? true);
    setAlwaysActive(member?.alwaysActive ?? true);
    setFailureCooldownEnabled(member?.failureCooldownEnabled ?? false);
    setPriority(String(member?.priority ?? 50));
    setConcurrency(String(member?.concurrency ?? 10));
    if (member?.type === "api") {
      const legacyVideoInputCapabilities = member.config
        .videoInputCapabilities ?? {
        referenceVideos: false,
        referenceAudios: false,
      };
      const savedVideoInputCapabilitiesByModel =
        member.config.videoInputCapabilitiesByModel ?? {};
      const videoInputCapabilitiesByModel = Object.fromEntries(
        member.supportedModelIds.flatMap((modelId) => {
          const normalizedModelId = modelId.trim().toLowerCase();
          const option = modelOptions.find(
            (candidate) =>
              candidate.id.trim().toLowerCase() === normalizedModelId
          );
          if (option?.category !== "video" && !normalizeVideoModelId(modelId)) {
            return [];
          }
          const capabilities =
            savedVideoInputCapabilitiesByModel[normalizedModelId] ??
            legacyVideoInputCapabilities;
          return capabilities.referenceVideos || capabilities.referenceAudios
            ? [[normalizedModelId, capabilities]]
            : [];
        })
      );
      setApiBaseUrl(member.config.baseUrl);
      setApiUseStream(member.config.useStream);
      setModelMappings(member.config.modelMappings);
      setApiAdapterDraft({
        convertReferenceImagesToPublicUrl:
          member.config.convertReferenceImagesToPublicUrl ?? false,
        authentication: member.config.authentication ?? { mode: "bearer" },
        videoSubmissionRetryCount: member.config.videoSubmissionRetryCount,
        videoProtocolMode: member.config.videoProtocolMode ?? "custom",
        videoInputFormat: member.config.videoInputFormat ?? "url",
        videoInputCapabilities: legacyVideoInputCapabilities,
        videoInputCapabilitiesByModel,
        operations:
          member.config.operations ??
          createDefaultApiUpstreamAdapterFormDraft().operations,
        ...(member.config.currentAdapterVersion
          ? {
              expectedCurrentVersionId: member.config.currentAdapterVersion.id,
            }
          : {}),
      });
    } else {
      setApiBaseUrl("");
      setApiUseStream(false);
      setModelMappings([]);
      setApiAdapterDraft(createDefaultApiUpstreamAdapterFormDraft());
    }
    setApiKey("");
    setImageSizeConfigId(
      member?.type === "api" ? (member.config.imageSizeConfig?.id ?? "") : ""
    );
    setImageSizeConfigIdsByModel(
      member?.type === "api"
        ? Object.fromEntries(
            Object.entries(member.config.imageSizeConfigsByModel ?? {}).map(
              ([modelId, config]) => [modelId.trim().toLowerCase(), config.id]
            )
          )
        : {}
    );
  }, [groups, member, modelOptions, open]);

  const acceptsVideo = acceptsVideoBackendMemberModels(type);
  const selectableModelOptions = useMemo(() => {
    const configuredOptions = modelOptions.filter(
      (option) =>
        option.category === "image" ||
        (acceptsVideo && option.category === "video")
    );
    const knownIds = new Set(
      modelOptions.map((option) => option.id.trim().toLowerCase())
    );
    const existingOptions = selectedModelIds.flatMap((modelId) => {
      const normalizedId = modelId.trim().toLowerCase();
      if (!normalizedId || knownIds.has(normalizedId)) return [];
      const realVideoModelId = normalizeVideoModelId(modelId);
      if (isLegacyVideoModelId(modelId) || realVideoModelId) return [];
      knownIds.add(normalizedId);
      return [createExistingMemberModelOption(modelId, "image")];
    });
    return [...configuredOptions, ...existingOptions];
  }, [acceptsVideo, modelOptions, selectedModelIds]);

  // 详情页才编辑高级适配配置；新增和列表编辑共用同一套基础表单。
  const showAdvancedConfiguration = detailsOnly;

  const { execute: saveMember, isPending } = useAction(
    saveImageBackendMemberAction,
    {
      onSuccess: async () => {
        // 保存完成后先等待父级重新读取供应商快照，避免关闭弹窗后列表仍显示旧配置。
        await onSaved();
        toast.success(member ? "成员已更新" : "成员已创建");
        if (!inline) onOpenChange(false);
      },
      onError: ({ error }) => toast.error(error.serverError || "保存成员失败"),
    }
  );

  const { execute: loadImageSizeConfigs } = useAction(
    listImageSizeConfigsAction,
    {
      onSuccess: ({ data }) =>
        setImageSizeConfigs(
          data?.configs?.map(({ id, name }) => ({ id, name })) ?? []
        ),
    }
  );

  useEffect(() => {
    if (open) loadImageSizeConfigs();
  }, [open, loadImageSizeConfigs]);

  /** 切换成员所属分组。 */
  function toggleGroup(groupId: string, checked: boolean): void {
    setGroupIds((current) =>
      checked
        ? Array.from(new Set([...current, groupId]))
        : current.filter((id) => id !== groupId)
    );
  }

  /** 更新一个已选择平台模型的供应商模型 ID；留空表示同名透传。 */
  function updateUpstreamModelId(
    modelId: string,
    upstreamModelId: string
  ): void {
    setModelMappings((current) => {
      const remaining = current.filter(
        (mapping) => mapping.modelId.toLowerCase() !== modelId.toLowerCase()
      );
      const normalized = upstreamModelId.trim();
      return normalized
        ? [...remaining, { modelId, upstreamModelId: normalized }]
        : remaining;
    });
  }

  /** 选择新模型时保留已有账号级分辨率覆盖，移除孤儿覆盖。 */
  function handleSelectedModelIdsChange(nextModelIds: string[]): void {
    setSelectedModelIds(nextModelIds);
    const nextModelKeys = new Set(
      nextModelIds.map((modelId) => modelId.trim().toLowerCase())
    );
    setSupportedResolutionsByModel((current) =>
      Object.fromEntries(
        nextModelIds.flatMap((modelId) => {
          const key = modelId.toLowerCase();
          const existing = current[key];
          return existing?.length ? [[key, existing]] : [];
        })
      )
    );
    setApiAdapterDraft((current) => ({
      ...current,
      videoInputCapabilitiesByModel: Object.fromEntries(
        Object.entries(current.videoInputCapabilitiesByModel).filter(
          ([modelId]) => nextModelKeys.has(modelId.trim().toLowerCase())
        )
      ),
    }));
  }

  /** 校验客户端草稿并提交严格的类型专属成员输入。 */
  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const defaultModelId =
      modelOptions.find((option) => option.category === "image")?.id ??
      DEFAULT_NEW_MEMBER_MODEL_ID;
    const supportedModelIds = normalizeSupportedModelIds(
      selectedModelIds.length > 0
        ? selectedModelIds
        : defaultModelId
          ? [defaultModelId]
          : []
    );
    if (groupIds.length === 0) {
      toast.error("至少选择一个分组");
      return;
    }
    if (supportedModelIds.length === 0) {
      toast.error("至少声明一个支持的模型 ID");
      return;
    }

    const common = {
      ...(member ? { id: member.id } : {}),
      name,
      groupIds,
      supportedModelIds,
      supportedResolutionsByModel: Object.fromEntries(
        supportedModelIds.flatMap((modelId) => {
          const resolutions =
            supportedResolutionsByModel[modelId.toLowerCase()];
          return resolutions?.length ? [[modelId, resolutions]] : [];
        })
      ),
      contentSafetyEnabled,
      isEnabled,
      alwaysActive,
      failureCooldownEnabled,
      priority: Number(priority),
      concurrency: Number(concurrency),
    };
    if (type === "api") {
      const selectedModelKeys = new Set(
        supportedModelIds.map((modelId) => modelId.toLowerCase())
      );
      saveMember({
        ...common,
        type: "api",
        config: {
          baseUrl: apiBaseUrl,
          ...(apiAdapterDraft.authentication.mode !== "none" && apiKey.trim()
            ? { apiKey: apiKey.trim() }
            : {}),
          useStream: apiUseStream,
          imageSizeConfigId: imageSizeConfigId || null,
          imageSizeConfigIdsByModel: Object.fromEntries(
            Object.entries(imageSizeConfigIdsByModel).filter(
              ([modelId, configId]) =>
                selectedModelKeys.has(modelId) && Boolean(configId)
            )
          ),
          convertReferenceImagesToPublicUrl:
            apiAdapterDraft.convertReferenceImagesToPublicUrl,
          videoSubmissionRetryCount: apiAdapterDraft.videoSubmissionRetryCount,
          videoProtocolMode: apiAdapterDraft.videoProtocolMode,
          videoInputFormat: apiAdapterDraft.videoInputFormat,
          // 旧账号级标签保持关闭；参考媒体能力只按平台模型 ID 声明。
          videoInputCapabilities: {
            referenceVideos: false,
            referenceAudios: false,
          },
          videoInputCapabilitiesByModel: Object.fromEntries(
            Object.entries(
              apiAdapterDraft.videoInputCapabilitiesByModel
            ).filter(([modelId]) =>
              selectedModelKeys.has(modelId.toLowerCase())
            )
          ),
          modelMappings: modelMappings.filter((mapping) =>
            selectedModelKeys.has(mapping.modelId.toLowerCase())
          ),
          authentication: apiAdapterDraft.authentication,
          operations: apiAdapterDraft.operations,
          ...(apiAdapterDraft.expectedCurrentVersionId
            ? {
                expectedCurrentVersionId:
                  apiAdapterDraft.expectedCurrentVersionId,
              }
            : {}),
        },
      });
      return;
    }
  }

  const imageSizeConfiguration = (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="image-size-config">供应商默认尺寸配置</Label>
        <select
          id="image-size-config"
          className="flex h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={imageSizeConfigId}
          onChange={(event) => setImageSizeConfigId(event.target.value)}
        >
          <option value="">不使用尺寸配置，原样透传比例和分辨率</option>
          {imageSizeConfigs.map((config) => (
            <option key={config.id} value={config.id}>
              {config.name}
            </option>
          ))}
        </select>
      </div>
      {selectedModelIds.filter(
        (modelId) =>
          !isLegacyVideoModelId(modelId) && !normalizeVideoModelId(modelId)
      ).length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {selectedModelIds
            .filter(
              (modelId) =>
                !isLegacyVideoModelId(modelId) &&
                !normalizeVideoModelId(modelId)
            )
            .map((modelId) => {
              const key = modelId.trim().toLowerCase();
              return (
                <div key={key} className="space-y-2">
                  <Label htmlFor={`image-size-config-${key}`}>
                    {modelId} 尺寸配置
                  </Label>
                  <select
                    id={`image-size-config-${key}`}
                    className="flex h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={imageSizeConfigIdsByModel[key] ?? ""}
                    onChange={(event) =>
                      setImageSizeConfigIdsByModel((current) => {
                        const next = { ...current };
                        if (event.target.value) next[key] = event.target.value;
                        else delete next[key];
                        return next;
                      })
                    }
                  >
                    <option value="">跟随供应商默认配置</option>
                    {imageSizeConfigs.map((config) => (
                      <option key={config.id} value={config.id}>
                        {config.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    未覆盖时继承供应商默认配置
                  </p>
                </div>
              );
            })}
        </div>
      ) : null}
    </div>
  );

  const formContent = (
    <form
      className={detailsOnly ? "space-y-10 pb-28" : "space-y-6"}
      onSubmit={handleSubmit}
    >
      <fieldset className="contents" disabled={readOnly}>
        {inline && detailsOnly ? null : inline ? (
          <header className="space-y-1">
            <h2 className="text-lg font-medium leading-none tracking-tight">
              {detailsOnly ? "账号适配详情" : member ? "编辑成员" : "新增成员"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {detailsOnly
                ? "配置该账号的模型能力、上游映射、视频协议、脚本和分辨率能力。"
                : member
                  ? "模型 ID 是唯一能力声明；调度不会根据名称前缀预先选择账号类型。"
                  : "先保存账号基础信息，适配细节可在账号详情页继续配置。"}
            </p>
          </header>
        ) : (
          <DialogHeader>
            <DialogTitle>
              {detailsOnly ? "账号适配详情" : member ? "编辑成员" : "新增成员"}
            </DialogTitle>
            <DialogDescription>
              {detailsOnly
                ? "配置该账号的模型能力、上游映射、视频协议、脚本和分辨率能力。"
                : member
                  ? "模型 ID 是唯一能力声明；调度不会根据名称前缀预先选择账号类型。"
                  : "先保存账号基础信息，适配细节可在账号详情页继续配置。"}
            </DialogDescription>
          </DialogHeader>
        )}

        {!detailsOnly ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="member-name">名称</Label>
                <Input
                  id="member-name"
                  autoComplete="off"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <Label>所属分组</Label>
                <p className="text-xs text-muted-foreground">
                  同一成员可加入多个分组，调度不会跨出请求指定的分组。
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {groups.map((group) => (
                  <label
                    key={group.id}
                    htmlFor={`member-group-${group.id}`}
                    className="flex items-center gap-2 rounded-md border p-3 text-sm"
                  >
                    <Checkbox
                      id={`member-group-${group.id}`}
                      checked={groupIds.includes(group.id)}
                      onCheckedChange={(checked) =>
                        toggleGroup(group.id, checked === true)
                      }
                    />
                    <span className="truncate">{group.name}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="member-priority">优先级</Label>
                <Input
                  id="member-priority"
                  type="number"
                  min="0"
                  max="10000"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="member-concurrency">并发上限</Label>
                <Input
                  id="member-concurrency"
                  type="number"
                  min="1"
                  max="10000"
                  value={concurrency}
                  onChange={(event) => setConcurrency(event.target.value)}
                  required
                />
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <BackendBooleanSetting
                id="member-enabled"
                label="启用成员"
                description="停用后不再获得新租约。"
                checked={isEnabled}
                onCheckedChange={setIsEnabled}
              />
              <BackendBooleanSetting
                id="member-safety"
                label="成员内容安全"
                description="分组选择继承时使用此值。"
                checked={contentSafetyEnabled}
                onCheckedChange={setContentSafetyEnabled}
              />
              <BackendBooleanSetting
                id="member-always-active"
                label="始终活跃"
                description="仅显式运维场景使用，不因普通失败自动排除。"
                checked={alwaysActive}
                onCheckedChange={setAlwaysActive}
              />
              <BackendBooleanSetting
                id="member-cooldown"
                label="失败冷却"
                description="可切换失败后暂时退出候选。"
                checked={failureCooldownEnabled}
                onCheckedChange={setFailureCooldownEnabled}
              />
            </div>
          </>
        ) : null}

        {detailsOnly ? (
          <MemberDetailSection
            title="模型能力"
            description="先声明账号支持的平台模型，再按模型配置供应商 ID、参考媒体输入和分辨率能力。"
          >
            <div className="space-y-2">
              <Label htmlFor="member-models">支持的模型</Label>
              <BackendMemberModelSelect
                options={selectableModelOptions}
                value={selectedModelIds}
                onChange={handleSelectedModelIdsChange}
                status={modelOptionStatus}
                disabled={isPending}
              />
            </div>
            {type === "api" ? (
              <div className="space-y-2">
                <Label>上游模型 ID 映射</Label>
                <p className="text-xs text-muted-foreground">
                  平台模型 ID
                  用于调度、计费和任务记录；仅实际请求当前账号时替换为供应商
                  ID。留空表示同名透传。
                </p>
                {selectedModelIds.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    请先选择账号支持的模型。
                  </p>
                ) : (
                  <div className="space-y-2">
                    {selectedModelIds.map((modelId) => (
                      <div
                        key={modelId}
                        className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                      >
                        <code className="truncate rounded-md bg-muted px-3 py-2 text-xs">
                          {modelId}
                        </code>
                        <Input
                          aria-label={`${modelId} 的上游模型 ID`}
                          value={
                            modelMappings.find(
                              (mapping) =>
                                mapping.modelId.toLowerCase() ===
                                modelId.toLowerCase()
                            )?.upstreamModelId ?? ""
                          }
                          onChange={(event) =>
                            updateUpstreamModelId(modelId, event.target.value)
                          }
                          placeholder={`默认：${modelId}`}
                          maxLength={240}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
            {selectedModelIds.length > 0 ? (
              <MemberResolutionCapabilitiesEditor
                disabled={isPending}
                modelIds={selectedModelIds}
                modelOptions={selectableModelOptions}
                onChange={setSupportedResolutionsByModel}
                onVideoInputCapabilitiesChange={
                  type === "api"
                    ? (videoInputCapabilitiesByModel) =>
                        setApiAdapterDraft({
                          ...apiAdapterDraft,
                          videoInputCapabilitiesByModel,
                        })
                    : undefined
                }
                value={supportedResolutionsByModel}
                videoInputCapabilitiesByModel={
                  apiAdapterDraft.videoInputCapabilitiesByModel
                }
              />
            ) : null}
            <p className="text-xs text-muted-foreground">
              API 账号可选择图片和视频的真实模型 ID。
            </p>
          </MemberDetailSection>
        ) : null}

        {detailsOnly && type === "api" ? (
          <MemberDetailSection
            title="图片尺寸映射"
            description="按模型维护比例与分辨率的尺寸映射；模型未单独覆盖时继承供应商默认配置，未选择配置则原样透传。"
          >
            {imageSizeConfiguration}
          </MemberDetailSection>
        ) : null}

        {type === "api" ? (
          <section
            className={
              detailsOnly
                ? "space-y-5 border-b border-border/70 pb-8"
                : "space-y-4 rounded-md border p-4"
            }
          >
            <header className={detailsOnly ? "space-y-1" : ""}>
              <h3
                className={
                  detailsOnly
                    ? "text-base font-semibold tracking-tight"
                    : "font-medium"
                }
              >
                {detailsOnly ? "请求响应处理" : "API 配置"}
              </h3>
              <p
                className={
                  detailsOnly
                    ? "max-w-3xl text-sm leading-6 text-muted-foreground"
                    : "text-xs text-muted-foreground"
                }
              >
                图片使用 Images 兼容协议，视频使用 Videos 兼容协议；不含
                Responses 或 Chat。
              </p>
            </header>
            <div className={detailsOnly ? "space-y-6" : "contents"}>
              {!detailsOnly ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="api-base-url">Base URL</Label>
                    <Input
                      id="api-base-url"
                      type="url"
                      value={apiBaseUrl}
                      onChange={(event) => setApiBaseUrl(event.target.value)}
                      placeholder="https://api.example.com/v1"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="api-key">API Key</Label>
                    <Input
                      id="api-key"
                      type="password"
                      autoComplete="new-password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={
                        apiAdapterDraft.authentication.mode === "none"
                          ? "无认证模式无需填写"
                          : member
                            ? "留空保留现有凭据"
                            : "必填"
                      }
                      required={
                        !member &&
                        apiAdapterDraft.authentication.mode !== "none"
                      }
                      disabled={apiAdapterDraft.authentication.mode === "none"}
                    />
                  </div>
                </>
              ) : null}
              {!detailsOnly ? imageSizeConfiguration : null}
              {showAdvancedConfiguration ? (
                <>
                  <BackendBooleanSetting
                    id="api-use-stream-details"
                    label="Images 流式响应"
                    description="向兼容的 Images 上游发送 stream 与 partial_images 参数。"
                    checked={apiUseStream}
                    onCheckedChange={setApiUseStream}
                  />
                  <ApiUpstreamAdapterForm
                    value={apiAdapterDraft}
                    onChange={setApiAdapterDraft}
                    disabled={isPending}
                  />
                </>
              ) : (
                <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  账号创建后，可在账号详情中配置模型映射、参考图 URL
                  转换、视频协议和脚本处理模块。
                </p>
              )}
            </div>
          </section>
        ) : null}

        <DialogFooter
          className={
            detailsOnly
              ? "fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 py-3 shadow-lg backdrop-blur sm:px-6"
              : undefined
          }
        >
          <div
            className={
              detailsOnly
                ? "mx-auto flex w-full max-w-7xl justify-end gap-2"
                : "contents"
            }
          >
            <Button
              className={detailsOnly ? "w-full sm:w-auto" : undefined}
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              className={detailsOnly ? "w-full sm:w-auto" : undefined}
              type="submit"
              disabled={isPending || groups.length === 0}
            >
              {isPending && <Loader2 className="size-4 animate-spin" />}
              保存成员
            </Button>
          </div>
        </DialogFooter>
      </fieldset>
    </form>
  );

  if (inline) {
    return <div className="space-y-6">{formContent}</div>;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        {formContent}
      </DialogContent>
    </Dialog>
  );
}
