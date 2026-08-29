"use client";

/**
 * 供应商账号数据列表。
 *
 * 使用方：ImageBackendPoolAdminPanel。组件只负责把成员摘要投影为可扫描的语义表格，
 * 账号详情链接和写操作回调仍交由页面编排；不会读取或暴露任何凭据正文。
 */
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Checkbox } from "@repo/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { Switch } from "@repo/ui/components/switch";
import {
  Ellipsis,
  Eye,
  Loader2,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";

import { Link } from "@/i18n/routing";
import type { BackendPoolAdminMemberSummary } from "./actions";
import { normalizeBackendMemberModelIdsForDisplay } from "./member-model-options";
import type { BackendMemberAdminSummary } from "./member-service";

/** 供应商账号列表共享的写操作状态。 */
export interface BackendMemberTableMutationState {
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

/** 返回成员的人类可读类型。 */
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

/** 展示凭据是否已经配置，不返回凭据本身。 */
function getCredentialLabel(member: BackendMemberAdminSummary): string {
  if (member.type === "api" && member.config.authentication?.mode === "none") {
    return "无需凭据";
  }
  if (member.type === "api") {
    return member.config.hasApiKey ? "已配置" : "缺失";
  }
  if (member.config.mode === "direct") {
    return member.config.hasCookie ? "已配置" : "缺失";
  }
  return member.config.hasApiKey ? "已配置" : "缺失";
}

/**
 * 渲染供应商账号数据列表及受控写操作。
 *
 * @param props 成员摘要、分组名称、时区、权限、共享写状态和动作回调。
 * @returns 带详情入口的响应式语义表格；只读模式隐藏写操作并保留详情入口。
 * @sideEffects 删除与重置先弹浏览器确认，其余操作回传父组件动作编排器。
 */
export function BackendMemberTable({
  members,
  groupNameById,
  timeZone,
  readOnly,
  mutationState,
  selectedMemberIds,
  onSelectedChange,
  onEnabledChange,
  onReset,
  onEdit,
  onDelete,
}: {
  members: readonly BackendPoolAdminMemberSummary[];
  groupNameById: ReadonlyMap<string, string>;
  timeZone: string;
  readOnly: boolean;
  mutationState: BackendMemberTableMutationState;
  selectedMemberIds: ReadonlySet<string>;
  onSelectedChange: (
    member: BackendPoolAdminMemberSummary,
    selected: boolean
  ) => void;
  onEnabledChange: (
    member: BackendPoolAdminMemberSummary,
    isEnabled: boolean
  ) => void;
  onReset: (member: BackendPoolAdminMemberSummary) => void;
  onEdit: (member: BackendPoolAdminMemberSummary) => void;
  onDelete: (member: BackendPoolAdminMemberSummary) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[1080px] text-sm">
        <caption className="sr-only">供应商账号列表</caption>
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium" scope="col">
              账号
            </th>
            <th className="px-4 py-3 font-medium" scope="col">
              分组
            </th>
            <th className="px-4 py-3 font-medium" scope="col">
              状态
            </th>
            <th className="px-4 py-3 font-medium" scope="col">
              支持模型
            </th>
            <th className="px-4 py-3 font-medium" scope="col">
              优先级
            </th>
            <th className="px-4 py-3 font-medium" scope="col">
              并发（占用 / 上限）
            </th>
            <th className="px-4 py-3 font-medium" scope="col">
              使用情况
            </th>
            <th className="px-4 py-3 font-medium" scope="col">
              创建时间
            </th>
            <th
              className="sticky right-0 z-20 w-[148px] bg-muted/95 px-4 py-3 text-right font-medium shadow-[-6px_0_8px_-8px_rgba(0,0,0,0.35)]"
              scope="col"
            >
              操作
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {members.map((member) => {
            const isWritePending =
              mutationState.isUpdating ||
              mutationState.isResetting ||
              mutationState.isDeleting;
            const isUpdatingThisMember =
              mutationState.isUpdating &&
              mutationState.updatingMemberId === member.id;
            const isResettingThisMember =
              mutationState.isResetting &&
              mutationState.resettingMemberId === member.id;
            const groups = member.groupIds
              .map((id) => groupNameById.get(id) ?? id)
              .join("、");
            const models =
              normalizeBackendMemberModelIdsForDisplay(
                member.supportedModelIds
              ).join("、") || "未配置";

            return (
              <tr className="align-top" key={member.id}>
                <td className="px-4 py-3">
                  <div className="flex min-w-48 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        aria-label={`选择账号“${member.name}”导出`}
                        checked={selectedMemberIds.has(member.id)}
                        onCheckedChange={(checked) =>
                          onSelectedChange(member, checked === true)
                        }
                      />
                      <span className="font-medium">{member.name}</span>
                      <Badge variant="outline">
                        {getMemberTypeLabel(member)}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {getCredentialLabel(member)}
                    </span>
                  </div>
                </td>
                <td className="max-w-48 whitespace-normal px-4 py-3 text-muted-foreground">
                  {groups || "未分组"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Badge variant={getMemberStatusVariant(member)}>
                      {member.isEnabled ? member.status : "disabled"}
                    </Badge>
                    {!readOnly ? (
                      <Switch
                        aria-busy={isUpdatingThisMember}
                        aria-label={`启用账号“${member.name}”`}
                        checked={member.isEnabled}
                        disabled={isWritePending}
                        onCheckedChange={(checked) =>
                          onEnabledChange(member, checked)
                        }
                      />
                    ) : null}
                  </div>
                </td>
                <td className="max-w-72 whitespace-normal px-4 py-3 text-xs text-muted-foreground">
                  {models}
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                  {member.priority}
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                  {member.inflightCount} / {member.concurrency}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                  累计租约 {member.leaseAcquiredCount} 次
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                  {formatAdminTime(member.createdAt, timeZone)}
                </td>
                <td className="sticky right-0 z-10 w-[148px] bg-background px-4 py-3 shadow-[-6px_0_8px_-8px_rgba(0,0,0,0.25)]">
                  <div className="flex justify-end gap-1">
                    <Button
                      aria-label={`查看账号“${member.name}”详情`}
                      asChild
                      size="icon"
                      title="查看账号详情"
                      variant="ghost"
                    >
                      <Link
                        href={`/dashboard/admin/suppliers/${encodeURIComponent(member.id)}`}
                      >
                        <Eye />
                      </Link>
                    </Button>
                    {!readOnly ? (
                      <Button
                        aria-label={`编辑账号“${member.name}”`}
                        disabled={isWritePending}
                        onClick={() => onEdit(member)}
                        size="icon"
                        title="编辑账号"
                        type="button"
                        variant="ghost"
                      >
                        <Pencil />
                      </Button>
                    ) : null}
                    {!readOnly ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            aria-busy={isResettingThisMember}
                            aria-label={`更多账号“${member.name}”操作`}
                            disabled={isWritePending}
                            size="icon"
                            title="更多操作"
                            type="button"
                            variant="ghost"
                          >
                            {isResettingThisMember ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <Ellipsis />
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={isWritePending}
                            onSelect={() => {
                              if (
                                window.confirm(
                                  `确认重置账号“${member.name}”的运行状态？\n\n这会清除健康降级、失败连击、冷却和最近错误，不会修改凭据、累计指标或运行中租约。`
                                )
                              ) {
                                onReset(member);
                              }
                            }}
                          >
                            <RotateCcw />
                            重置运行状态
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={isWritePending}
                            onSelect={() => {
                              if (
                                window.confirm(`确认删除成员“${member.name}”？`)
                              ) {
                                onDelete(member);
                              }
                            }}
                            variant="destructive"
                          >
                            <Trash2 />
                            删除账号
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
