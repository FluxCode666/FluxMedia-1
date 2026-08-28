"use client";

import type { ApiModelMapping } from "@repo/shared/image-backend/api-upstream-adaptation";
/**
 * 统一媒体后端成员编辑表单。
 *
 * 职责：以 `api | adobe` 单一入口编辑公共调度字段、显式模型能力和类型专属
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

import { saveImageBackendMemberAction } from "./actions";
import {
  type ApiUpstreamAdapterFormDraft,
  createDefaultApiUpstreamAdapterFormDraft,
} from "./api-upstream-adapter-draft";
import { ApiUpstreamAdapterForm } from "./api-upstream-adapter-form";
import { BackendBooleanSetting } from "./boolean-setting";
import {
  type AdobeMemberMode,
  acceptsVideoBackendMemberModels,
  type BackendMemberModelOption,
  createExistingMemberModelOption,
  DEFAULT_ADOBE_MEMBER_MODE,
  removeVideoBackendMemberModelIds,
} from "./member-model-options";
import {
  type BackendMemberModelOptionStatus,
  BackendMemberModelSelect,
} from "./member-model-select";
import { MemberResolutionCapabilitiesEditor } from "./member-resolution-capabilities";
import type { BackendMemberAdminSummary } from "./member-service";

/** 新建账号在详情配置前使用的安全图像能力占位 ID。 */
const DEFAULT_NEW_MEMBER_MODEL_ID = "gpt-image-2";

/** 渲染 API 或 Adobe 统一成员的新增/编辑弹窗。 */
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
  const [alwaysActive, setAlwaysActive] = useState(false);
  const [failureCooldownEnabled, setFailureCooldownEnabled] = useState(true);
  const [priority, setPriority] = useState("50");
  const [concurrency, setConcurrency] = useState("10");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiUseStream, setApiUseStream] = useState(false);
  const [modelMappings, setModelMappings] = useState<ApiModelMapping[]>([]);
  const [apiAdapterDraft, setApiAdapterDraft] =
    useState<ApiUpstreamAdapterFormDraft>(() =>
      createDefaultApiUpstreamAdapterFormDraft()
    );
  const [adobeMode, setAdobeMode] = useState<AdobeMemberMode>(
    DEFAULT_ADOBE_MEMBER_MODE
  );
  const [adobeBaseUrl, setAdobeBaseUrl] = useState("");
  const [adobeApiKey, setAdobeApiKey] = useState("");
  const [adobeCookie, setAdobeCookie] = useState("");
  const [adobeScope, setAdobeScope] = useState("");
  const [defaultRatio, setDefaultRatio] = useState("1x1");
  const [defaultResolution, setDefaultResolution] = useState("2k");
  const [gptImageQuality, setGptImageQuality] = useState<
    "low" | "medium" | "high"
  >("high");

  useEffect(() => {
    if (!open) return;
    const nextType = member?.type ?? "api";
    setType(nextType);
    setName(member?.name ?? "");
    setGroupIds(member?.groupIds ?? (groups[0] ? [groups[0].id] : []));
    const defaultModelId =
      modelOptions.find((option) => option.category === "image")?.id ??
      DEFAULT_NEW_MEMBER_MODEL_ID;
    setSelectedModelIds(member?.supportedModelIds ?? [defaultModelId]);
    setSupportedResolutionsByModel(member?.supportedResolutionsByModel ?? {});
    setContentSafetyEnabled(member?.contentSafetyEnabled ?? true);
    setIsEnabled(member?.isEnabled ?? true);
    setAlwaysActive(member?.alwaysActive ?? false);
    setFailureCooldownEnabled(member?.failureCooldownEnabled ?? true);
    setPriority(String(member?.priority ?? 50));
    setConcurrency(String(member?.concurrency ?? 10));
    if (member?.type === "api") {
      setApiBaseUrl(member.config.baseUrl);
      setApiUseStream(member.config.useStream);
      setModelMappings(member.config.modelMappings);
      setApiAdapterDraft({
        authentication: member.config.authentication ?? { mode: "bearer" },
        videoSubmissionRetryCount: member.config.videoSubmissionRetryCount,
        videoProtocolMode: member.config.videoProtocolMode ?? "custom",
        videoInputCapabilities: member.config.videoInputCapabilities ?? {
          referenceVideos: false,
          referenceAudios: false,
        },
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
    if (member?.type === "adobe") {
      setAdobeMode(member.config.mode);
      setDefaultRatio(member.config.defaultRatio);
      setDefaultResolution(member.config.defaultResolution);
      setGptImageQuality(member.config.gptImageQuality);
      setAdobeBaseUrl(
        member.config.mode === "gateway" ? member.config.baseUrl : ""
      );
    } else {
      setAdobeMode(DEFAULT_ADOBE_MEMBER_MODE);
      setAdobeBaseUrl("");
      setDefaultRatio("1x1");
      setDefaultResolution("2k");
      setGptImageQuality("high");
    }
    setAdobeApiKey("");
    setAdobeCookie("");
    setAdobeScope("");
  }, [groups, member, modelOptions, open]);

  const acceptsVideo = acceptsVideoBackendMemberModels(type, adobeMode);
  const selectableModelOptions = useMemo(() => {
    const configuredOptions = modelOptions.filter(
      (option) =>
        option.category === "image" ||
        (acceptsVideo && (type === "api" || normalizeVideoModelId(option.id)))
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
  }, [acceptsVideo, modelOptions, selectedModelIds, type]);

  const showAdvancedConfiguration = Boolean(member) || detailsOnly;

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

  /** 切换账号类型；API 与 Adobe Direct 保留视频，切到 Gateway 时清理。 */
  function handleMemberTypeChange(nextType: BackendMemberType): void {
    setType(nextType);
    if (nextType === "adobe" && adobeMode === "gateway") {
      setSelectedModelIds((current) =>
        removeVideoBackendMemberModelIds(current, modelOptions)
      );
    }
  }

  /** 切换 Adobe 接入模式；Gateway 不具备当前视频执行链，需清理视频能力。 */
  function handleAdobeModeChange(nextMode: typeof adobeMode): void {
    setAdobeMode(nextMode);
    if (nextMode !== "direct") {
      setSelectedModelIds((current) =>
        removeVideoBackendMemberModelIds(current, modelOptions)
      );
    }
  }

  /** 选择新模型时保留已有账号级分辨率覆盖，移除孤儿覆盖。 */
  function handleSelectedModelIdsChange(nextModelIds: string[]): void {
    setSelectedModelIds(nextModelIds);
    setSupportedResolutionsByModel((current) =>
      Object.fromEntries(
        nextModelIds.flatMap((modelId) => {
          const key = modelId.toLowerCase();
          const existing = current[key];
          return existing?.length ? [[key, existing]] : [];
        })
      )
    );
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
          videoSubmissionRetryCount: apiAdapterDraft.videoSubmissionRetryCount,
          videoProtocolMode: apiAdapterDraft.videoProtocolMode,
          videoInputCapabilities: apiAdapterDraft.videoInputCapabilities,
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

    saveMember({
      ...common,
      type: "adobe",
      config:
        adobeMode === "gateway"
          ? {
              mode: "gateway",
              baseUrl: adobeBaseUrl,
              ...(adobeApiKey.trim() ? { apiKey: adobeApiKey.trim() } : {}),
              defaultRatio,
              defaultResolution,
              gptImageQuality,
            }
          : {
              mode: "direct",
              ...(adobeCookie.trim() ? { cookie: adobeCookie.trim() } : {}),
              ...(adobeScope.trim() ? { scope: adobeScope.trim() } : {}),
              defaultRatio,
              defaultResolution,
              gptImageQuality,
            },
    });
  }

  const formContent = (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <fieldset className="contents" disabled={readOnly}>
        {inline ? (
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
                <Label>账号类型</Label>
                <Select
                  value={type}
                  disabled={Boolean(member)}
                  onValueChange={(value) =>
                    handleMemberTypeChange(value as BackendMemberType)
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="api">API</SelectItem>
                    <SelectItem value="adobe">Adobe</SelectItem>
                  </SelectContent>
                </Select>
                {member && (
                  <p className="text-xs text-muted-foreground">
                    已有成员不能原地切换类型；需要时请删除后重建。
                  </p>
                )}
              </div>
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

        {type === "api" ? (
          <div className="space-y-4 rounded-md border p-4">
            <div>
              <h3 className="font-medium">API 配置</h3>
              <p className="text-xs text-muted-foreground">
                图片使用 Images 兼容协议，视频使用 Videos 兼容协议；不含
                Responses 或 Chat。
              </p>
            </div>
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
                      !member && apiAdapterDraft.authentication.mode !== "none"
                    }
                    disabled={apiAdapterDraft.authentication.mode === "none"}
                  />
                </div>
                <BackendBooleanSetting
                  id="api-use-stream"
                  label="Images 流式响应"
                  description="向兼容的 Images 上游发送 stream 与 partial_images 参数。"
                  checked={apiUseStream}
                  onCheckedChange={setApiUseStream}
                />
              </>
            ) : null}
            {showAdvancedConfiguration ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>上游模型 ID 映射</Label>
                  <p className="text-xs text-muted-foreground">
                    平台仍使用左侧真实模型 ID
                    进行调度、计费与任务记录；仅实际请求当前账号时替换为右侧供应商
                    ID。留空表示同名透传。
                  </p>
                  {selectedModelIds.length === 0 ? (
                    <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                      请先在下方选择账号支持的模型。
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
                <ApiUpstreamAdapterForm
                  value={apiAdapterDraft}
                  onChange={setApiAdapterDraft}
                  disabled={isPending}
                />
              </div>
            ) : (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                账号创建后，可在账号详情中配置模型映射、视频协议和脚本处理模块。
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4 rounded-md border p-4">
            <div>
              <h3 className="font-medium">Adobe 配置</h3>
              <p className="text-xs text-muted-foreground">
                Gateway 使用外部兼容接口；Direct 成员自身就是一个 Adobe
                账号，不再包含内部子号池。
              </p>
            </div>
            {!detailsOnly ? (
              <div className="space-y-2">
                <Label>模式</Label>
                <Select
                  value={adobeMode}
                  onValueChange={(value) =>
                    handleAdobeModeChange(value as typeof adobeMode)
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gateway">Gateway</SelectItem>
                    <SelectItem value="direct">Direct</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {!detailsOnly && adobeMode === "gateway" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="adobe-base-url">Gateway Base URL</Label>
                  <Input
                    id="adobe-base-url"
                    type="url"
                    value={adobeBaseUrl}
                    onChange={(event) => setAdobeBaseUrl(event.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="adobe-api-key">Gateway API Key</Label>
                  <Input
                    id="adobe-api-key"
                    type="password"
                    autoComplete="new-password"
                    value={adobeApiKey}
                    onChange={(event) => setAdobeApiKey(event.target.value)}
                    placeholder={member ? "留空保留现有凭据" : "必填"}
                    required={!member}
                  />
                </div>
              </>
            )}
            {!detailsOnly && adobeMode === "direct" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="adobe-cookie">Adobe Cookie</Label>
                  <Textarea
                    id="adobe-cookie"
                    rows={5}
                    autoComplete="off"
                    value={adobeCookie}
                    onChange={(event) => setAdobeCookie(event.target.value)}
                    placeholder={
                      member?.type === "adobe" &&
                      member.config.mode === "direct"
                        ? "留空保留现有 Cookie"
                        : "粘贴已登录 Adobe 账号的完整 Cookie"
                    }
                    required={
                      !member ||
                      (member.type === "adobe" &&
                        member.config.mode !== "direct")
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    保存时会立即验证账号并换取短期 Token；明文不会返回浏览器。
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="adobe-scope">IMS Scope</Label>
                  <Input
                    id="adobe-scope"
                    value={adobeScope}
                    onChange={(event) => setAdobeScope(event.target.value)}
                    placeholder="留空使用默认 Scope"
                  />
                </div>
              </>
            )}
            {showAdvancedConfiguration ? (
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="adobe-ratio">默认比例</Label>
                  <Input
                    id="adobe-ratio"
                    value={defaultRatio}
                    onChange={(event) => setDefaultRatio(event.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="adobe-resolution">默认分辨率</Label>
                  <Input
                    id="adobe-resolution"
                    value={defaultResolution}
                    onChange={(event) =>
                      setDefaultResolution(event.target.value)
                    }
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>GPT 图像质量</Label>
                  <Select
                    value={gptImageQuality}
                    onValueChange={(value) =>
                      setGptImageQuality(value as typeof gptImageQuality)
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {showAdvancedConfiguration ? (
          <div className="space-y-2">
            <Label htmlFor="member-models">支持的模型</Label>
            <BackendMemberModelSelect
              options={selectableModelOptions}
              value={selectedModelIds}
              onChange={handleSelectedModelIdsChange}
              status={modelOptionStatus}
              disabled={isPending}
            />
            {selectedModelIds.length > 0 ? (
              <MemberResolutionCapabilitiesEditor
                disabled={isPending}
                modelIds={selectedModelIds}
                modelOptions={selectableModelOptions}
                onChange={setSupportedResolutionsByModel}
                value={supportedResolutionsByModel}
              />
            ) : null}
            <p className="text-xs text-muted-foreground">
              {acceptsVideo
                ? "API 与 Adobe Direct 账号可选择图片和视频的真实模型 ID；未选择的模型不会进入候选集。"
                : type === "adobe"
                  ? "Adobe Gateway 当前只支持图片模型；切换为 Direct 后可选择视频模型。"
                  : "API 账号可选择图片和视频的真实模型 ID。"}
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="submit" disabled={isPending || groups.length === 0}>
            {isPending && <Loader2 className="size-4 animate-spin" />}
            保存成员
          </Button>
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
