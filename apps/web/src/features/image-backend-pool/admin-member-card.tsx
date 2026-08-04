"use client";

/**
 * 账号池供应商账号卡片。
 *
 * 使用方：ImageBackendPoolAdminPanel 的供应商账号 Tab。组件展示统一调度事实、模型、
 * 创建时间和脱敏凭据状态，并把启停、重置、编辑、删除意图回传父级动作编排器。
 */
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Switch } from "@repo/ui/components/switch";
import { Loader2, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { AdobeCredentialHealthView } from "./adobe-credential-health-view";
import { normalizeBackendMemberModelIdsForDisplay } from "./member-model-options";
import type {
  BackendMemberAdminSummary,
  RedactedAdobeMemberConfig,
} from "./member-service";
import { MemberSupportedModels } from "./member-supported-models";

type RedactedAdobeDirectConfig = Extract<
  RedactedAdobeMemberConfig,
  { mode: "direct" }
>;

/** 供应商账号卡片共享的写操作状态。 */
export interface BackendMemberCardMutationState {
  isDeleting: boolean;
  isResetting: boolean;
  isUpdating: boolean;
  resettingMemberId: string | null;
  updatingMemberId: string | null;
}

/** 格式化后台时间，非法或空值显示短横线。 */
function formatAdminTime(value: string | null, timeZone: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

/** 返回成员的人类可读类型与模式。 */
function getMemberTypeLabel(member: BackendMemberAdminSummary): string {
  if (member.type === "api") return "API";
  return member.config.mode === "direct" ? "Adobe Direct" : "Adobe Gateway";
}

/** 判断统一成员是否为 Adobe direct 顶层账号。 */
export function isAdobeDirectMember(
  member: BackendMemberAdminSummary
): boolean {
  return member.type === "adobe" && member.config.mode === "direct";
}

/** 根据成员运行状态选择稳定的 Badge 样式。 */
function getMemberStatusVariant(
  member: BackendMemberAdminSummary
): "secondary" | "destructive" | "outline" {
  if (!member.isEnabled || member.status === "error") return "destructive";
  if (member.healthStatus === "healthy") return "secondary";
  return "outline";
}

/** 返回凭据配置事实的人类可读标签，不混入凭据健康或业务额度。 */
function getMemberCredentialLabel(member: BackendMemberAdminSummary): string {
  if (member.type === "api" && member.config.authentication?.mode === "none") {
    return "无需凭据";
  }
  if (member.type === "api") {
    return member.config.hasApiKey ? "密钥已配置" : "缺失";
  }
  if (member.config.mode === "direct") {
    return member.config.hasCookie ? "Cookie 已配置" : "缺失";
  }
  return member.config.hasApiKey ? "密钥已配置" : "缺失";
}

/** 展示 Adobe direct 账号身份、Firefly 余额与凭据错误，不暴露任何 secret。 */
function AdobeDirectAccountFacts({
  config,
  timeZone,
}: {
  config: RedactedAdobeDirectConfig;
  timeZone: string;
}) {
  const hasKnownBalance =
    config.creditsAvailable !== null || config.creditsTotal !== null;
  return (
    <>
      <span>Adobe 账号：{config.displayName || config.email || "未识别"}</span>
      <span>
        {config.creditsError
          ? "Firefly 余额：读取失败"
          : hasKnownBalance
            ? `Firefly 余额：${config.creditsAvailable ?? "?"} / ${config.creditsTotal ?? "?"}`
            : "Firefly 余额：未知（刷新后获取）"}
      </span>
      {config.creditsUsed !== null ? (
        <span>Firefly 已用：{config.creditsUsed}</span>
      ) : null}
      <span>
        余额更新：{formatAdminTime(config.creditsUpdatedAt, timeZone)}
      </span>
      <details className="basis-full rounded-md border p-2">
        <summary className="cursor-pointer">
          查看缓存 Token 状态（不代表账号凭据健康）
        </summary>
        <div className="mt-1 grid gap-1 sm:grid-cols-2">
          <span>Express Token：{config.credentialStatus}</span>
          <span>
            Express 刷新：{formatAdminTime(config.lastRefreshAt, timeZone)}
          </span>
          {config.fireflyCredentialStatus ? (
            <span>Firefly Token：{config.fireflyCredentialStatus}</span>
          ) : null}
          {config.fireflyLastRefreshAt ? (
            <span>
              Firefly 刷新：
              {formatAdminTime(config.fireflyLastRefreshAt, timeZone)}
            </span>
          ) : null}
        </div>
      </details>
      {config.lastRefreshError ? (
        <details className="basis-full rounded-md border border-destructive/30 p-2 text-destructive">
          <summary className="cursor-pointer">
            查看凭据刷新错误（默认折叠）
          </summary>
          <p className="mt-1 break-words">{config.lastRefreshError}</p>
        </details>
      ) : null}
      {config.fireflyLastRefreshError ? (
        <details className="basis-full rounded-md border border-destructive/30 p-2 text-destructive">
          <summary className="cursor-pointer">
            查看历史 Firefly 凭据刷新错误（默认折叠）
          </summary>
          <p className="mt-1 break-words">{config.fireflyLastRefreshError}</p>
        </details>
      ) : null}
      {config.creditsError ? (
        <details className="basis-full rounded-md border border-destructive/30 p-2 text-destructive">
          <summary className="cursor-pointer">
            查看余额读取错误（默认折叠）
          </summary>
          <p className="mt-1 break-words">{config.creditsError}</p>
        </details>
      ) : null}
    </>
  );
}

/**
 * 渲染一张供应商账号卡片及受控写操作。
 *
 * @param props 账号摘要、分组名称、时区、权限、共享写状态和动作回调。
 * @returns 完整账号事实卡；只读模式不渲染任何写控件。
 * @sideEffects 重置与删除先弹浏览器确认；其余操作直接回传父组件。
 */
export function BackendMemberCard({
  member,
  groupNameById,
  timeZone,
  readOnly,
  mutationState,
  onEnabledChange,
  onReset,
  onEdit,
  onDelete,
}: {
  member: BackendMemberAdminSummary;
  groupNameById: ReadonlyMap<string, string>;
  timeZone: string;
  readOnly: boolean;
  mutationState: BackendMemberCardMutationState;
  onEnabledChange: (isEnabled: boolean) => void;
  onReset: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isWritePending =
    mutationState.isUpdating ||
    mutationState.isResetting ||
    mutationState.isDeleting;

  return (
    <Card className="min-w-0 gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>{member.name}</span>
          <Badge variant="outline">{getMemberTypeLabel(member)}</Badge>
          <Badge variant={getMemberStatusVariant(member)}>
            {member.isEnabled ? member.status : "disabled"}
          </Badge>
        </CardTitle>
        <CardDescription>
          {member.groupIds.map((id) => groupNameById.get(id) ?? id).join("、")}
        </CardDescription>
        {!readOnly ? (
          <CardAction className="flex flex-wrap justify-end gap-1">
            <div className="flex items-center gap-2 px-2 text-sm">
              <span>启用</span>
              <Switch
                aria-busy={
                  mutationState.isUpdating &&
                  mutationState.updatingMemberId === member.id
                }
                aria-label={`启用账号“${member.name}”`}
                checked={member.isEnabled}
                disabled={isWritePending}
                onCheckedChange={onEnabledChange}
              />
            </div>
            <Button
              aria-busy={
                mutationState.isResetting &&
                mutationState.resettingMemberId === member.id
              }
              disabled={isWritePending}
              onClick={() => {
                if (
                  window.confirm(
                    `确认重置账号“${member.name}”的运行状态？\n\n这会清除健康降级、失败连击、冷却和最近错误，不会修改凭据、累计指标或运行中租约。`
                  )
                ) {
                  onReset();
                }
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {mutationState.isResetting &&
              mutationState.resettingMemberId === member.id ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RotateCcw />
              )}
              重置状态
            </Button>
            <Button
              aria-label={`编辑账号“${member.name}”`}
              disabled={isWritePending}
              onClick={onEdit}
              size="icon"
              title="编辑账号"
              type="button"
              variant="ghost"
            >
              <Pencil />
            </Button>
            <Button
              aria-label={`删除账号“${member.name}”`}
              disabled={isWritePending}
              onClick={() => {
                if (window.confirm(`确认删除成员“${member.name}”？`)) {
                  onDelete();
                }
              }}
              size="icon"
              title="删除账号"
              type="button"
              variant="ghost"
            >
              <Trash2 />
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="min-w-0 space-y-4 px-4">
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <span>创建时间 {formatAdminTime(member.createdAt, timeZone)}</span>
          <span>优先级 {member.priority}</span>
          <span>
            负载 {member.inflightCount}/{member.concurrency}
          </span>
          <span>累计获租 {member.leaseAcquiredCount}</span>
          <span>最近调用质量 {member.healthStatus}</span>
          <span>
            上次获租 {formatAdminTime(member.lastAcquiredAt, timeZone)}
          </span>
          <span>上次使用 {formatAdminTime(member.lastUsedAt, timeZone)}</span>
        </div>
        <MemberSupportedModels
          modelIds={normalizeBackendMemberModelIdsForDisplay(
            member.supportedModelIds
          )}
        />
        {isAdobeDirectMember(member) ? (
          <AdobeCredentialHealthView
            memberId={member.id}
            readOnly={readOnly}
            timeZone={timeZone}
          />
        ) : null}
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>凭据配置：{getMemberCredentialLabel(member)}</span>
          {member.type === "adobe" && member.config.mode === "direct" ? (
            <AdobeDirectAccountFacts
              config={member.config}
              timeZone={timeZone}
            />
          ) : null}
          <span>失败冷却：{member.failureCooldownEnabled ? "开" : "关"}</span>
          <span>始终活跃：{member.alwaysActive ? "开" : "关"}</span>
        </div>
        {member.lastError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <p className="break-words">最近错误：{member.lastError}</p>
            <p className="mt-1 text-muted-foreground">
              发生时间：{formatAdminTime(member.lastErrorAt, timeZone)}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
