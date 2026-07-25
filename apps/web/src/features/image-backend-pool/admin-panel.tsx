"use client";

/**
 * 统一媒体后端号池管理面板。
 *
 * 职责：在单一页面加载和展示分组及 `api | adobe` 统一成员，打开对应编辑表单、
 * 执行安全删除，并只在 Adobe direct 成员上暴露内部账号子池。注册机、Sub2API、
 * Web/Codex 账号和旧三池分页不再进入此组件。
 */
import { isFireflyVideoModelId } from "@repo/shared/adobe/firefly-direct/video-catalog";
import type { BackendGroupSummary } from "@repo/shared/image-backend/group-contract";
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
import {
  Activity,
  Boxes,
  Database,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
} from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  deleteImageBackendGroupAction,
  deleteImageBackendMemberAction,
  getAdminImageBackendPoolAction,
} from "./actions";
import { AdobeAccountDialog } from "./adobe-account-dialog";
import { BackendGroupFormDialog } from "./group-form";
import { BackendMemberFormDialog } from "./member-form";
import type { BackendMemberAdminSummary } from "./member-service";

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
  if (member.type === "api") return "API Images";
  return member.config.mode === "direct" ? "Adobe Direct" : "Adobe Gateway";
}

/** 判断统一成员是否具备 Adobe direct 子账号管理能力。 */
function isAdobeDirectMember(member: BackendMemberAdminSummary): boolean {
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

/** 显示号池关键容量事实的统计卡。 */
function PoolStatCard({
  title,
  value,
  description,
  icon: Icon,
}: {
  title: string;
  value: number;
  description: string;
  icon: typeof Database;
}) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardDescription>{title}</CardDescription>
        <CardAction>
          <Icon className="size-4 text-muted-foreground" />
        </CardAction>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 text-xs text-muted-foreground">
        {description}
      </CardContent>
    </Card>
  );
}

/** 统一号池主面板；viewer 权限下可通过 readOnly 禁止所有写操作。 */
export function ImageBackendPoolAdminPanel({
  timeZone,
  readOnly = false,
}: {
  timeZone: string;
  readOnly?: boolean;
}) {
  const [groups, setGroups] = useState<BackendGroupSummary[]>([]);
  const [members, setMembers] = useState<BackendMemberAdminSummary[]>([]);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  const [adobeDialogOpen, setAdobeDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<BackendGroupSummary | null>(
    null
  );
  const [editingMember, setEditingMember] =
    useState<BackendMemberAdminSummary | null>(null);
  const [adobeMember, setAdobeMember] =
    useState<BackendMemberAdminSummary | null>(null);

  const { execute: loadPool, isPending: isLoading } = useAction(
    getAdminImageBackendPoolAction,
    {
      onSuccess: ({ data }) => {
        setGroups(data?.groups ?? []);
        setMembers(data?.members ?? []);
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "加载统一号池失败"),
    }
  );
  const { execute: deleteGroup, isPending: isDeletingGroup } = useAction(
    deleteImageBackendGroupAction,
    {
      onSuccess: () => {
        toast.success("分组已删除");
        loadPool();
      },
      onError: ({ error }) => toast.error(error.serverError || "删除分组失败"),
    }
  );
  const { execute: deleteMember, isPending: isDeletingMember } = useAction(
    deleteImageBackendMemberAction,
    {
      onSuccess: () => {
        toast.success("成员已删除");
        loadPool();
      },
      onError: ({ error }) => toast.error(error.serverError || "删除成员失败"),
    }
  );

  useEffect(() => {
    loadPool();
  }, [loadPool]);

  const groupNameById = useMemo(
    () => new Map(groups.map((group) => [group.id, group.name])),
    [groups]
  );
  const imageModelIds = useMemo(
    () =>
      Array.from(
        new Set(
          members.flatMap((member) =>
            member.supportedModelIds.filter(
              (modelId) => !isFireflyVideoModelId(modelId)
            )
          )
        )
      ).sort(),
    [members]
  );
  const activeMemberCount = members.filter(
    (member) => member.isEnabled && member.status !== "error"
  ).length;
  const inflightCount = members.reduce(
    (total, member) => total + member.inflightCount,
    0
  );
  const adobeDirectCount = members.filter(isAdobeDirectMember).length;

  /** 打开新增分组表单。 */
  function openNewGroup(): void {
    setEditingGroup(null);
    setGroupDialogOpen(true);
  }

  /** 打开新增成员表单，并在缺少分组时阻止创建无归属成员。 */
  function openNewMember(): void {
    if (groups.length === 0) {
      toast.error("请先创建至少一个媒体后端分组");
      return;
    }
    setEditingMember(null);
    setMemberDialogOpen(true);
  }

  /** 打开 Adobe direct 子账号面板。 */
  function openAdobeAccounts(member: BackendMemberAdminSummary): void {
    setAdobeMember(member);
    setAdobeDialogOpen(true);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">媒体后端号池</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            API 与 Adobe 成员共享分组、模型能力、优先级、并发、健康和调度指标。
            模型 ID 只做能力匹配，不再按前缀分流。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isLoading}
            onClick={() => loadPool()}
          >
            {isLoading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            刷新
          </Button>
          {!readOnly && (
            <>
              <Button type="button" variant="outline" onClick={openNewGroup}>
                <Plus className="size-4" />
                新增分组
              </Button>
              <Button type="button" onClick={openNewMember}>
                <Plus className="size-4" />
                新增成员
              </Button>
            </>
          )}
        </div>
      </div>

      {readOnly && (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          当前为只读视图。只有管理员可以修改分组、成员和 Adobe 子账号。
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <PoolStatCard
          title="分组"
          value={groups.length}
          description="统一访问与计费边界"
          icon={Boxes}
        />
        <PoolStatCard
          title="可用成员"
          value={activeMemberCount}
          description={`总计 ${members.length} 个统一成员`}
          icon={Database}
        />
        <PoolStatCard
          title="当前租约"
          value={inflightCount}
          description="跨应用副本共享的有效在飞数"
          icon={Activity}
        />
        <PoolStatCard
          title="Adobe Direct"
          value={adobeDirectCount}
          description="具备内部账号与 token 子池"
          icon={Users}
        />
      </div>

      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold">分组</h3>
          <p className="text-sm text-muted-foreground">
            调度始终限制在请求指定分组内，默认组最多一个。
          </p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {groups.map((group) => (
            <Card key={group.id} className="gap-4 py-4">
              <CardHeader className="px-4">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span>{group.name}</span>
                  {group.isDefault && <Badge>默认</Badge>}
                  <Badge variant={group.isEnabled ? "secondary" : "outline"}>
                    {group.isEnabled ? "已启用" : "已停用"}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {group.description || "无说明"}
                </CardDescription>
                {!readOnly && (
                  <CardAction className="flex gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setEditingGroup(group);
                        setGroupDialogOpen(true);
                      }}
                    >
                      <Pencil className="size-4" />
                      <span className="sr-only">编辑分组</span>
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={isDeletingGroup || group.isDefault}
                      onClick={() => {
                        if (window.confirm(`确认删除分组“${group.name}”？`)) {
                          deleteGroup({ id: group.id });
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">删除分组</span>
                    </Button>
                  </CardAction>
                )}
              </CardHeader>
              <CardContent className="grid gap-2 px-4 text-sm sm:grid-cols-2">
                <span>最低套餐：{group.minPlan}</span>
                <span>优先级：{group.priority}</span>
                <span>
                  用户选择：{group.isUserSelectable ? "允许" : "禁止"}
                </span>
                <span>
                  内容安全：
                  {group.contentSafety === "inherit"
                    ? "继承"
                    : group.contentSafety === "enabled"
                      ? "开启"
                      : "关闭"}
                </span>
                <span className="sm:col-span-2">
                  子分组：
                  {group.childGroupIds.length > 0
                    ? group.childGroupIds
                        .map((id) => groupNameById.get(id) ?? id)
                        .join("、")
                    : "无"}
                </span>
              </CardContent>
            </Card>
          ))}
          {!isLoading && groups.length === 0 && (
            <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground lg:col-span-2">
              尚未创建分组。创建第一个分组后才能添加成员。
            </div>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold">统一成员</h3>
          <p className="text-sm text-muted-foreground">
            所有类型进入同一候选集合，再按系统配置的全局策略排序和原子获租。
          </p>
        </div>
        <div className="grid gap-3 xl:grid-cols-2">
          {members.map((member) => (
            <Card key={member.id} className="gap-4 py-4">
              <CardHeader className="px-4">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <span>{member.name}</span>
                  <Badge variant="outline">{getMemberTypeLabel(member)}</Badge>
                  <Badge variant={getMemberStatusVariant(member)}>
                    {member.isEnabled ? member.status : "disabled"}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {member.groupIds
                    .map((id) => groupNameById.get(id) ?? id)
                    .join("、")}
                </CardDescription>
                <CardAction className="flex gap-1">
                  {isAdobeDirectMember(member) && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => openAdobeAccounts(member)}
                    >
                      <KeyRound className="size-4" />
                      <span className="sr-only">Adobe 账号</span>
                    </Button>
                  )}
                  {!readOnly && (
                    <>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => {
                          setEditingMember(member);
                          setMemberDialogOpen(true);
                        }}
                      >
                        <Pencil className="size-4" />
                        <span className="sr-only">编辑成员</span>
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        disabled={isDeletingMember}
                        onClick={() => {
                          if (
                            window.confirm(`确认删除成员“${member.name}”？`)
                          ) {
                            deleteMember({ id: member.id });
                          }
                        }}
                      >
                        <Trash2 className="size-4" />
                        <span className="sr-only">删除成员</span>
                      </Button>
                    </>
                  )}
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-4 px-4">
                <div className="grid gap-2 text-sm sm:grid-cols-3">
                  <span>优先级 {member.priority}</span>
                  <span>
                    负载 {member.inflightCount}/{member.concurrency}
                  </span>
                  <span>累计获租 {member.leaseAcquiredCount}</span>
                  <span>健康 {member.healthStatus}</span>
                  <span>
                    上次获租 {formatAdminTime(member.lastAcquiredAt, timeZone)}
                  </span>
                  <span>
                    上次使用 {formatAdminTime(member.lastUsedAt, timeZone)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {member.supportedModelIds.map((modelId) => (
                    <Badge key={modelId} variant="secondary">
                      {modelId}
                    </Badge>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>
                    凭据：
                    {member.type === "api"
                      ? member.config.hasApiKey
                        ? "已配置"
                        : "缺失"
                      : member.config.mode === "gateway"
                        ? member.config.hasApiKey
                          ? "已配置"
                          : "缺失"
                        : "内部子池"}
                  </span>
                  <span>
                    失败冷却：{member.failureCooldownEnabled ? "开" : "关"}
                  </span>
                  <span>始终活跃：{member.alwaysActive ? "开" : "关"}</span>
                </div>
              </CardContent>
            </Card>
          ))}
          {!isLoading && members.length === 0 && (
            <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground xl:col-span-2">
              当前号池没有成员。
            </div>
          )}
        </div>
      </section>

      <BackendGroupFormDialog
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
        group={editingGroup}
        groups={groups}
        imageModelIds={imageModelIds}
        onSaved={loadPool}
      />
      <BackendMemberFormDialog
        open={memberDialogOpen}
        onOpenChange={setMemberDialogOpen}
        member={editingMember}
        groups={groups}
        onSaved={loadPool}
      />
      <AdobeAccountDialog
        open={adobeDialogOpen}
        onOpenChange={setAdobeDialogOpen}
        member={adobeMember}
        readOnly={readOnly}
      />
    </div>
  );
}
