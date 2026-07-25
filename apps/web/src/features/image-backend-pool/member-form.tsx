"use client";

/**
 * 统一媒体后端成员编辑表单。
 *
 * 职责：以 `api | adobe` 单一入口编辑公共调度字段、显式模型能力和类型专属
 * 配置。成员类型在编辑时不可原地切换，secret 留空由服务端保留既有值。
 */
import type { BackendGroupSummary } from "@repo/shared/image-backend/group-contract";
import type { BackendMemberType } from "@repo/shared/image-backend/member-contract";
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
import { Switch } from "@repo/ui/components/switch";
import { Textarea } from "@repo/ui/components/textarea";
import { Loader2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { saveImageBackendMemberAction } from "./actions";
import type { BackendMemberAdminSummary } from "./member-service";

/** 把模型文本解析为保持首次出现顺序的唯一模型 ID。 */
function parseModelIds(value: string): string[] {
  const seen = new Set<string>();
  const modelIds: string[] = [];
  for (const item of value.split(/[\n,]/)) {
    const modelId = item.trim().toLowerCase();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
}

/** 把参数映射显示为每行 `copy|move source target` 的可编辑文本。 */
function formatParameterMappings(
  mappings: Array<{ source: string; target: string; mode: "copy" | "move" }>
): string {
  return mappings
    .map((mapping) => [mapping.mode, mapping.source, mapping.target].join(" "))
    .join("\n");
}

/** 解析参数映射文本；格式错误时返回 null 交由表单提示。 */
function parseParameterMappings(
  value: string
): Array<{ source: string; target: string; mode: "copy" | "move" }> | null {
  const mappings: Array<{
    source: string;
    target: string;
    mode: "copy" | "move";
  }> = [];
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [mode, source, target, ...remaining] = trimmed.split(/\s+/);
    if (
      (mode !== "copy" && mode !== "move") ||
      !source ||
      !target ||
      remaining.length > 0
    ) {
      return null;
    }
    mappings.push({ mode, source, target });
  }
  return mappings;
}

/** 可复用的成员布尔调度设置。 */
function MemberSwitch({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** 渲染 API 或 Adobe 统一成员的新增/编辑弹窗。 */
export function BackendMemberFormDialog({
  open,
  onOpenChange,
  member,
  groups,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: BackendMemberAdminSummary | null;
  groups: BackendGroupSummary[];
  onSaved: () => void;
}) {
  const [type, setType] = useState<BackendMemberType>("api");
  const [name, setName] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [modelIdsText, setModelIdsText] = useState("");
  const [contentSafetyEnabled, setContentSafetyEnabled] = useState(true);
  const [isEnabled, setIsEnabled] = useState(true);
  const [alwaysActive, setAlwaysActive] = useState(false);
  const [failureCooldownEnabled, setFailureCooldownEnabled] = useState(true);
  const [priority, setPriority] = useState("50");
  const [concurrency, setConcurrency] = useState("10");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [parameterMappingsText, setParameterMappingsText] = useState("");
  const [adobeMode, setAdobeMode] = useState<"gateway" | "direct">("gateway");
  const [adobeBaseUrl, setAdobeBaseUrl] = useState("");
  const [adobeApiKey, setAdobeApiKey] = useState("");
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
    setModelIdsText(member?.supportedModelIds.join("\n") ?? "");
    setContentSafetyEnabled(member?.contentSafetyEnabled ?? true);
    setIsEnabled(member?.isEnabled ?? true);
    setAlwaysActive(member?.alwaysActive ?? false);
    setFailureCooldownEnabled(member?.failureCooldownEnabled ?? true);
    setPriority(String(member?.priority ?? 50));
    setConcurrency(String(member?.concurrency ?? 10));
    if (member?.type === "api") {
      setApiBaseUrl(member.config.baseUrl);
      setParameterMappingsText(
        formatParameterMappings(member.config.parameterMappings)
      );
    } else {
      setApiBaseUrl("");
      setParameterMappingsText("");
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
      setAdobeMode("gateway");
      setAdobeBaseUrl("");
      setDefaultRatio("1x1");
      setDefaultResolution("2k");
      setGptImageQuality("high");
    }
    setAdobeApiKey("");
  }, [groups, member, open]);

  const { execute: saveMember, isPending } = useAction(
    saveImageBackendMemberAction,
    {
      onSuccess: () => {
        toast.success(member ? "成员已更新" : "成员已创建");
        onOpenChange(false);
        onSaved();
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

  /** 校验客户端草稿并提交严格的类型专属成员输入。 */
  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const supportedModelIds = parseModelIds(modelIdsText);
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
      contentSafetyEnabled,
      isEnabled,
      alwaysActive,
      failureCooldownEnabled,
      priority: Number(priority),
      concurrency: Number(concurrency),
    };
    if (type === "api") {
      const parameterMappings = parseParameterMappings(parameterMappingsText);
      if (!parameterMappings) {
        toast.error("参数映射每行格式应为：copy|move source target");
        return;
      }
      saveMember({
        ...common,
        type: "api",
        config: {
          baseUrl: apiBaseUrl,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          parameterMappings,
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
              defaultRatio,
              defaultResolution,
              gptImageQuality,
            },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <form className="space-y-6" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{member ? "编辑成员" : "新增成员"}</DialogTitle>
            <DialogDescription>
              模型 ID 是唯一能力声明；调度不会根据名称前缀预先选择账号类型。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>账号类型</Label>
              <Select
                value={type}
                disabled={Boolean(member)}
                onValueChange={(value) => setType(value as BackendMemberType)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="api">API Images</SelectItem>
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

          <div className="space-y-2">
            <Label htmlFor="member-models">支持的模型 ID</Label>
            <Textarea
              id="member-models"
              rows={5}
              value={modelIdsText}
              onChange={(event) => setModelIdsText(event.target.value)}
              placeholder={"gpt-image-2\nfirefly-nano-banana-pro"}
              required
            />
            <p className="text-xs text-muted-foreground">
              每行一个或用逗号分隔。未声明的模型不会进入该成员候选集。
            </p>
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
            <MemberSwitch
              id="member-enabled"
              label="启用成员"
              description="停用后不再获得新租约。"
              checked={isEnabled}
              onCheckedChange={setIsEnabled}
            />
            <MemberSwitch
              id="member-safety"
              label="成员内容安全"
              description="分组选择继承时使用此值。"
              checked={contentSafetyEnabled}
              onCheckedChange={setContentSafetyEnabled}
            />
            <MemberSwitch
              id="member-always-active"
              label="始终活跃"
              description="仅显式运维场景使用，不因普通失败自动排除。"
              checked={alwaysActive}
              onCheckedChange={setAlwaysActive}
            />
            <MemberSwitch
              id="member-cooldown"
              label="失败冷却"
              description="可切换失败后暂时退出候选。"
              checked={failureCooldownEnabled}
              onCheckedChange={setFailureCooldownEnabled}
            />
          </div>

          {type === "api" ? (
            <div className="space-y-4 rounded-md border p-4">
              <div>
                <h3 className="font-medium">API Images 配置</h3>
                <p className="text-xs text-muted-foreground">
                  仅支持 OpenAI Images 风格协议，不含 Responses 或 Chat。
                </p>
              </div>
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
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={member ? "留空保留现有凭据" : "必填"}
                  required={!member}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="parameter-mappings">请求参数映射</Label>
                <Textarea
                  id="parameter-mappings"
                  rows={4}
                  value={parameterMappingsText}
                  onChange={(event) =>
                    setParameterMappingsText(event.target.value)
                  }
                  placeholder="copy input.source output.target"
                />
                <p className="text-xs text-muted-foreground">
                  每行格式：copy|move source target。留空表示不映射。
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4 rounded-md border p-4">
              <div>
                <h3 className="font-medium">Adobe 配置</h3>
                <p className="text-xs text-muted-foreground">
                  Gateway 使用外部兼容接口；Direct 使用内部 Adobe 账号与 token
                  子池。
                </p>
              </div>
              <div className="space-y-2">
                <Label>模式</Label>
                <Select
                  value={adobeMode}
                  onValueChange={(value) =>
                    setAdobeMode(value as typeof adobeMode)
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
              {adobeMode === "gateway" && (
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
                      value={adobeApiKey}
                      onChange={(event) => setAdobeApiKey(event.target.value)}
                      placeholder={member ? "留空保留现有凭据" : "必填"}
                      required={!member}
                    />
                  </div>
                </>
              )}
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
            </div>
          )}

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
        </form>
      </DialogContent>
    </Dialog>
  );
}
