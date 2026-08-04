"use client";

/**
 * 统一媒体后端号池管理面板。
 *
 * 职责：在“供应商账号 / 分组”独立页签加载和筛选 `api | adobe` 统一成员与分组，
 * 打开对应编辑表单、就地修改成员启用状态、执行运行状态重置和安全删除，并展示
 * Adobe direct 成员的一对一凭据状态。旧三池分页不再进入此组件。
 */
import type { BackendGroupSummary } from "@repo/shared/image-backend/group-contract";
import { isLegacyVideoModelId } from "@repo/shared/image-backend/supported-models";
import { normalizeVideoModelId } from "@repo/shared/video-generation";
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import {
  Activity,
  Boxes,
  Database,
  Loader2,
  Plus,
  RefreshCw,
  Users,
} from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { getModelConfigurationAction } from "@/features/model-configuration/actions";
import {
  type BackendPoolAdminMemberSummary,
  deleteImageBackendGroupAction,
  deleteImageBackendMemberAction,
  getAdminImageBackendPoolAction,
  resetImageBackendMemberStatusAction,
  setImageBackendMemberEnabledAction,
} from "./actions";
import { BackendGroupList } from "./admin-group-list";
import { BackendMemberCard, isAdobeDirectMember } from "./admin-member-card";
import {
  BackendGroupFilterBar,
  BackendMemberFilterBar,
  type BackendMemberFilterModelOption,
} from "./admin-pool-filter-bars";
import {
  type BackendMemberFilters,
  EMPTY_BACKEND_MEMBER_FILTERS,
  filterBackendGroups,
  filterBackendMembers,
  hasBackendGroupFilter,
  hasBackendMemberFilters,
  hasInvalidBackendMemberDateRange,
} from "./admin-pool-view-model";
import { BackendGroupFormDialog } from "./group-form";
import { BackendMemberFormDialog } from "./member-form";
import {
  type BackendMemberModelOption,
  buildBackendMemberModelOptions,
  normalizeBackendMemberModelIdsForDisplay,
} from "./member-model-options";
import type { BackendMemberModelOptionStatus } from "./member-model-select";

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

/** 展示账号或分组快照首次加载时的稳定骨架。 */
function PoolListLoadingState({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="grid gap-3 md:grid-cols-2"
      role="status"
    >
      <div className="h-40 animate-pulse rounded-lg border bg-muted/30" />
      <div className="h-40 animate-pulse rounded-lg border bg-muted/30" />
    </div>
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
  const [members, setMembers] = useState<BackendPoolAdminMemberSummary[]>([]);
  const [modelOptions, setModelOptions] = useState<BackendMemberModelOption[]>(
    []
  );
  const [modelOptionStatus, setModelOptionStatus] =
    useState<BackendMemberModelOptionStatus>("loading");
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<BackendGroupSummary | null>(
    null
  );
  const [editingMember, setEditingMember] =
    useState<BackendPoolAdminMemberSummary | null>(null);
  const [memberFilters, setMemberFilters] = useState<BackendMemberFilters>(
    EMPTY_BACKEND_MEMBER_FILTERS
  );
  const [groupNameFilter, setGroupNameFilter] = useState("");
  const [resettingMemberId, setResettingMemberId] = useState<string | null>(
    null
  );
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null);
  const pendingMemberEnabledRef = useRef<{
    id: string;
    previous: boolean;
  } | null>(null);

  const { execute: loadPool, isPending: isLoading } = useAction(
    getAdminImageBackendPoolAction,
    {
      onSuccess: ({ data }) => {
        setGroups(data?.groups ?? []);
        setMembers(data?.members ?? []);
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "加载账号池失败"),
    }
  );
  const { execute: loadModelOptions, isPending: isLoadingModelOptions } =
    useAction(getModelConfigurationAction, {
      onSuccess: ({ data }) => {
        if (!data) {
          setModelOptions([]);
          setModelOptionStatus("unavailable");
          return;
        }
        setModelOptions(buildBackendMemberModelOptions(data));
        setModelOptionStatus(
          data.runtimeCatalogStatus === "ready" ? "ready" : "degraded"
        );
      },
      onError: ({ error }) => {
        setModelOptions([]);
        setModelOptionStatus("unavailable");
        toast.error(error.serverError || "加载模型配置失败");
      },
    });
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
  const { execute: resetMemberStatus, isPending: isResettingMember } =
    useAction(resetImageBackendMemberStatusAction, {
      onSuccess: () => {
        setResettingMemberId(null);
        toast.success("账号运行状态已重置");
        loadPool();
      },
      onError: ({ error }) => {
        setResettingMemberId(null);
        toast.error(error.serverError || "重置账号运行状态失败");
      },
    });
  const { execute: setMemberEnabled, isPending: isUpdatingMember } = useAction(
    setImageBackendMemberEnabledAction,
    {
      onSuccess: ({ data }) => {
        pendingMemberEnabledRef.current = null;
        setUpdatingMemberId(null);
        toast.success(data?.isEnabled ? "账号已启用" : "账号已停用");
        loadPool();
      },
      onError: ({ error }) => {
        const pending = pendingMemberEnabledRef.current;
        if (pending) {
          setMembers((current) =>
            current.map((member) =>
              member.id === pending.id
                ? { ...member, isEnabled: pending.previous }
                : member
            )
          );
        }
        pendingMemberEnabledRef.current = null;
        setUpdatingMemberId(null);
        toast.error(error.serverError || "修改账号启用状态失败");
      },
    }
  );

  useEffect(() => {
    loadPool();
    loadModelOptions();
  }, [loadModelOptions, loadPool]);

  const groupNameById = useMemo(
    () => new Map(groups.map((group) => [group.id, group.name])),
    [groups]
  );
  const memberCountByGroup = useMemo(() => {
    const counts = new Map<string, number>();
    for (const member of members) {
      for (const groupId of member.groupIds) {
        counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
      }
    }
    return counts;
  }, [members]);
  const memberModelFilterOptions = useMemo<
    BackendMemberFilterModelOption[]
  >(() => {
    const configuredLabelById = new Map(
      modelOptions.map((option) => [option.id.toLowerCase(), option.label])
    );
    return normalizeBackendMemberModelIdsForDisplay(
      members.flatMap((member) => member.supportedModelIds)
    )
      .sort((left, right) => left.localeCompare(right))
      .map((id) => {
        const label = configuredLabelById.get(id.toLowerCase());
        return { id, label: label && label !== id ? `${label} · ${id}` : id };
      });
  }, [members, modelOptions]);
  const filteredMembers = useMemo(
    () => filterBackendMembers(members, memberFilters, timeZone),
    [memberFilters, members, timeZone]
  );
  const filteredGroups = useMemo(
    () => filterBackendGroups(groups, groupNameFilter),
    [groupNameFilter, groups]
  );
  const invalidMemberDateRange =
    hasInvalidBackendMemberDateRange(memberFilters);
  const imageModelIds = useMemo(
    () =>
      Array.from(
        new Set(
          members.flatMap((member) =>
            member.supportedModelIds.filter(
              (modelId) =>
                !normalizeVideoModelId(modelId) &&
                !isLegacyVideoModelId(modelId)
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
      toast.error("请先创建至少一个账号池分组");
      return;
    }
    if (
      modelOptionStatus === "loading" ||
      modelOptionStatus === "unavailable"
    ) {
      toast.error("模型配置尚未就绪，请刷新后重试");
      return;
    }
    if (modelOptions.length === 0) {
      toast.error("模型配置中暂无可供成员选择的模型");
      return;
    }
    setEditingMember(null);
    setMemberDialogOpen(true);
  }

  /** 乐观更新列表中的开关；失败时恢复原值并提示管理员。 */
  function handleMemberEnabledChange(
    member: BackendPoolAdminMemberSummary,
    isEnabled: boolean
  ): void {
    // WHY：ref 在 React 下一次渲染前也能同步挡住快速双击，避免并发请求互相回滚。
    if (pendingMemberEnabledRef.current) return;
    pendingMemberEnabledRef.current = {
      id: member.id,
      previous: member.isEnabled,
    };
    setUpdatingMemberId(member.id);
    setMembers((current) =>
      current.map((item) =>
        item.id === member.id ? { ...item, isEnabled } : item
      )
    );
    setMemberEnabled({ id: member.id, isEnabled });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">账号池</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            API 与 Adobe 成员共享分组、模型能力、优先级、并发、健康和调度指标。
            模型 ID 只做能力匹配，不再按前缀分流。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={isLoading || isLoadingModelOptions}
          onClick={() => {
            setModelOptionStatus("loading");
            loadPool();
            loadModelOptions();
          }}
        >
          {isLoading || isLoadingModelOptions ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          刷新
        </Button>
      </div>

      {readOnly && (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          当前为只读视图。只有管理员可以修改分组和成员。
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
          title="可用账号"
          value={activeMemberCount}
          description={`总计 ${members.length} 个供应商账号`}
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
          description="一名成员对应一个 Adobe 账号"
          icon={Users}
        />
      </div>

      <Tabs className="w-full" defaultValue="members">
        <TabsList
          aria-label="账号池管理内容"
          className="h-auto flex-wrap justify-start bg-transparent p-0"
        >
          <TabsTrigger
            className="gap-2 rounded-md border border-transparent px-3 py-2 data-[state=active]:border-foreground/20 data-[state=active]:bg-foreground/5 data-[state=active]:shadow-none"
            value="members"
          >
            供应商账号
            <span className="text-xs tabular-nums text-muted-foreground">
              {members.length}
            </span>
          </TabsTrigger>
          <TabsTrigger
            className="gap-2 rounded-md border border-transparent px-3 py-2 data-[state=active]:border-foreground/20 data-[state=active]:bg-foreground/5 data-[state=active]:shadow-none"
            value="groups"
          >
            分组
            <span className="text-xs tabular-nums text-muted-foreground">
              {groups.length}
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent className="mt-4" value="members">
          <section className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">供应商账号</h3>
                <p className="text-sm text-muted-foreground">
                  所有类型进入同一候选集合，再按全局策略排序和原子获租。
                </p>
              </div>
              {!readOnly ? (
                <Button onClick={openNewMember} type="button">
                  <Plus />
                  新增供应商账号
                </Button>
              ) : null}
            </div>
            <BackendMemberFilterBar
              filters={memberFilters}
              invalidDateRange={invalidMemberDateRange}
              modelOptions={memberModelFilterOptions}
              onChange={setMemberFilters}
              resultCount={filteredMembers.length}
              timeZone={timeZone}
              totalCount={members.length}
            />
            {isLoading && members.length === 0 ? (
              <PoolListLoadingState label="正在加载供应商账号" />
            ) : (
              <div className="grid gap-3 xl:grid-cols-2">
                {filteredMembers.map((member) => (
                  <BackendMemberCard
                    groupNameById={groupNameById}
                    key={member.id}
                    member={member}
                    mutationState={{
                      isDeleting: isDeletingMember,
                      isResetting: isResettingMember,
                      isUpdating: isUpdatingMember,
                      resettingMemberId,
                      updatingMemberId,
                    }}
                    onDelete={() => deleteMember({ id: member.id })}
                    onEdit={() => {
                      setEditingMember(member);
                      setMemberDialogOpen(true);
                    }}
                    onEnabledChange={(isEnabled) =>
                      handleMemberEnabledChange(member, isEnabled)
                    }
                    onReset={() => {
                      setResettingMemberId(member.id);
                      resetMemberStatus({ id: member.id });
                    }}
                    readOnly={readOnly}
                    timeZone={timeZone}
                  />
                ))}
                {filteredMembers.length === 0 ? (
                  <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground xl:col-span-2">
                    {hasBackendMemberFilters(memberFilters)
                      ? "没有符合当前筛选条件的供应商账号。"
                      : "当前账号池没有供应商账号。"}
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </TabsContent>

        <TabsContent className="mt-4" value="groups">
          <section className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">分组</h3>
                <p className="text-sm text-muted-foreground">
                  调度始终限制在请求指定分组内，默认分组最多一个。
                </p>
              </div>
              {!readOnly ? (
                <Button onClick={openNewGroup} type="button">
                  <Plus />
                  新增分组
                </Button>
              ) : null}
            </div>
            <BackendGroupFilterBar
              name={groupNameFilter}
              onChange={setGroupNameFilter}
              resultCount={filteredGroups.length}
              totalCount={groups.length}
            />
            {isLoading && groups.length === 0 ? (
              <PoolListLoadingState label="正在加载账号池分组" />
            ) : (
              <div className="overflow-hidden rounded-lg border bg-background">
                <BackendGroupList
                  allGroups={groups}
                  groups={filteredGroups}
                  hasNameFilter={hasBackendGroupFilter(groupNameFilter)}
                  isDeleting={isDeletingGroup}
                  memberCountByGroup={memberCountByGroup}
                  onDelete={(id) => deleteGroup({ id })}
                  onEdit={(group) => {
                    setEditingGroup(group);
                    setGroupDialogOpen(true);
                  }}
                  readOnly={readOnly}
                />
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>

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
        modelOptions={modelOptions}
        modelOptionStatus={modelOptionStatus}
        onSaved={loadPool}
      />
    </div>
  );
}
