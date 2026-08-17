"use client";

/**
 * 统一媒体后端号池管理面板。
 *
 * 职责：在“供应商账号 / 分组”独立页签加载和筛选 `api | adobe` 统一成员与分组，
 * 打开对应编辑表单、把模型配置快照中的视频双价格传给分组编辑器、就地修改成员
 * 启用状态、执行运行状态重置和安全删除，并展示 Adobe direct 成员的一对一凭据状态。
 * 旧三池分页不再进入此组件。
 */
import type { BackendGroupSummary } from "@repo/shared/image-backend/group-contract";
import { isLegacyVideoModelId } from "@repo/shared/image-backend/supported-models";
import type { PaginationConfig } from "@repo/shared/pagination/config";
import { buildPaginationHref } from "@repo/shared/pagination/url-adapter";
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
import { useSearchParams } from "next/navigation";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { getModelConfigurationAction } from "@/features/model-configuration/actions";
import { UrlPaginationControls } from "@/features/pagination/pagination-controls";
import { UrlPageSizeSelect } from "@/features/pagination/url-page-size-select";
import { usePathname, useRouter } from "@/i18n/routing";
import {
  type BackendPoolAdminMemberSummary,
  deleteImageBackendGroupAction,
  deleteImageBackendMemberAction,
  getAdminImageBackendPoolAction,
  listAdminImageBackendGroupsAction,
  listAdminImageBackendMembersAction,
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
  ADMIN_POOL_GROUP_NAME_PARAM,
  ADMIN_POOL_GROUP_PAGINATION_NAMES,
  ADMIN_POOL_MEMBER_FILTER_PARAMS,
  ADMIN_POOL_MEMBER_PAGINATION_NAMES,
  ADMIN_POOL_TAB_PARAM,
  parseAdminPoolGroupListInput,
  parseAdminPoolMemberListInput,
} from "./admin-pool-pagination";
import {
  type BackendMemberFilters,
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
import type { VideoCreditPricingModel } from "./video-credit-pricing-editor";

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
  paginationConfig,
  readOnly = false,
  title = "供应商管理",
  readOnlyNotice = "当前角色仅可查看，写操作已禁用。",
}: {
  timeZone: string;
  paginationConfig: PaginationConfig;
  readOnly?: boolean;
  title?: string;
  readOnlyNotice?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentSearchParams = useMemo(
    () => new URLSearchParams(searchParams.toString()),
    [searchParams]
  );
  const memberListInput = useMemo(
    () =>
      parseAdminPoolMemberListInput(
        currentSearchParams,
        paginationConfig,
        timeZone
      ),
    [currentSearchParams, paginationConfig, timeZone]
  );
  const groupListInput = useMemo(
    () => parseAdminPoolGroupListInput(currentSearchParams, paginationConfig),
    [currentSearchParams, paginationConfig]
  );
  const [groups, setGroups] = useState<BackendGroupSummary[]>([]);
  const [members, setMembers] = useState<BackendPoolAdminMemberSummary[]>([]);
  const [memberPage, setMemberPage] = useState<{
    records: BackendPoolAdminMemberSummary[];
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  } | null>(null);
  const [groupPage, setGroupPage] = useState<{
    records: BackendGroupSummary[];
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  } | null>(null);
  const [modelOptions, setModelOptions] = useState<BackendMemberModelOption[]>(
    []
  );
  const [videoPricingModels, setVideoPricingModels] = useState<
    VideoCreditPricingModel[]
  >([]);
  const [modelOptionStatus, setModelOptionStatus] =
    useState<BackendMemberModelOptionStatus>("loading");
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<BackendGroupSummary | null>(
    null
  );
  const [editingMember, setEditingMember] =
    useState<BackendPoolAdminMemberSummary | null>(null);
  const [resettingMemberId, setResettingMemberId] = useState<string | null>(
    null
  );
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null);
  const pendingMemberEnabledRef = useRef<{
    id: string;
    previous: boolean;
  } | null>(null);

  const memberFilters: BackendMemberFilters = {
    name: memberListInput.name,
    credentialStatus: memberListInput.credentialStatus,
    modelId: memberListInput.modelId,
    createdFrom: memberListInput.createdFrom,
    createdTo: memberListInput.createdTo,
  };
  const groupNameFilter = groupListInput.name;
  const activePoolTab =
    currentSearchParams.get(ADMIN_POOL_TAB_PARAM) === "groups"
      ? "groups"
      : "members";

  const { execute: loadPool, isPending: isLoading } = useAction(
    getAdminImageBackendPoolAction,
    {
      onSuccess: ({ data }) => {
        setGroups(data?.groups ?? []);
        setMembers(data?.members ?? []);
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "加载供应商管理失败"),
    }
  );
  const { execute: loadMemberPage, isPending: isLoadingMemberPage } = useAction(
    listAdminImageBackendMembersAction,
    {
      onSuccess: ({ data }) => {
        if (!data) return;
        setMemberPage(data);
        if (data.page !== memberListInput.page) {
          router.replace(
            buildPaginationHref(
              pathname,
              new URLSearchParams(searchParams.toString()),
              ADMIN_POOL_MEMBER_PAGINATION_NAMES,
              { page: data.page },
              "page"
            )
          );
        }
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "加载供应商账号失败"),
    }
  );
  const { execute: loadGroupPage, isPending: isLoadingGroupPage } = useAction(
    listAdminImageBackendGroupsAction,
    {
      onSuccess: ({ data }) => {
        if (!data) return;
        setGroupPage(data);
        if (data.page !== groupListInput.page) {
          router.replace(
            buildPaginationHref(
              pathname,
              new URLSearchParams(searchParams.toString()),
              ADMIN_POOL_GROUP_PAGINATION_NAMES,
              { page: data.page },
              "page"
            )
          );
        }
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "加载供应商分组失败"),
    }
  );
  const { execute: loadModelOptions, isPending: isLoadingModelOptions } =
    useAction(getModelConfigurationAction, {
      onSuccess: ({ data }) => {
        if (!data) {
          setModelOptions([]);
          setVideoPricingModels([]);
          setModelOptionStatus("unavailable");
          return;
        }
        setModelOptions(buildBackendMemberModelOptions(data));
        setVideoPricingModels(
          data.entries.flatMap((entry) =>
            entry.category === "video"
              ? [
                  {
                    modelId: entry.configKey,
                    displayName: entry.displayName,
                    billingMode: entry.billingMode,
                    supportedResolutions: entry.supportedResolutions,
                    globalCreditsPerSecondByResolution:
                      entry.creditsPerSecondByResolution,
                    globalCreditsPerItemByResolution:
                      entry.creditsPerItemByResolution,
                  },
                ]
              : []
          )
        );
        setModelOptionStatus(
          data.runtimeCatalogStatus === "ready" ? "ready" : "degraded"
        );
      },
      onError: ({ error }) => {
        setModelOptions([]);
        setVideoPricingModels([]);
        setModelOptionStatus("unavailable");
        toast.error(error.serverError || "加载模型配置失败");
      },
    });
  const { execute: deleteGroup, isPending: isDeletingGroup } = useAction(
    deleteImageBackendGroupAction,
    {
      onSuccess: () => {
        toast.success("分组已删除");
        reloadPoolSnapshots();
      },
      onError: ({ error }) => toast.error(error.serverError || "删除分组失败"),
    }
  );
  const { execute: deleteMember, isPending: isDeletingMember } = useAction(
    deleteImageBackendMemberAction,
    {
      onSuccess: () => {
        toast.success("成员已删除");
        reloadPoolSnapshots();
      },
      onError: ({ error }) => toast.error(error.serverError || "删除成员失败"),
    }
  );
  const { execute: resetMemberStatus, isPending: isResettingMember } =
    useAction(resetImageBackendMemberStatusAction, {
      onSuccess: () => {
        setResettingMemberId(null);
        toast.success("账号运行状态已重置");
        reloadPoolSnapshots();
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
        reloadPoolSnapshots();
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
          setMemberPage((current) =>
            current
              ? {
                  ...current,
                  records: current.records.map((member) =>
                    member.id === pending.id
                      ? { ...member, isEnabled: pending.previous }
                      : member
                  ),
                }
              : current
          );
        }
        pendingMemberEnabledRef.current = null;
        setUpdatingMemberId(null);
        toast.error(error.serverError || "修改账号启用状态失败");
      },
    }
  );

  /** 写操作成功后刷新完整辅助快照和两个分页明细。 */
  function reloadPoolSnapshots(): void {
    loadPool();
    loadMemberPage(memberListInput);
    loadGroupPage(groupListInput);
  }

  useEffect(() => {
    loadPool();
    loadModelOptions();
  }, [loadModelOptions, loadPool]);

  useEffect(() => {
    loadMemberPage(memberListInput);
  }, [loadMemberPage, memberListInput]);

  useEffect(() => {
    loadGroupPage(groupListInput);
  }, [groupListInput, loadGroupPage]);

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
  const filteredMembers = memberPage?.records ?? [];
  const filteredGroups = groupPage?.records ?? [];
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

  const memberPageSizeOptions = paginationConfig.pageSizeOptions.map(
    (pageSize) => ({
      size: pageSize,
      href: buildPaginationHref(
        pathname,
        currentSearchParams,
        ADMIN_POOL_MEMBER_PAGINATION_NAMES,
        { pageSize },
        "criteria"
      ),
    })
  );
  const groupPageSizeOptions = paginationConfig.pageSizeOptions.map(
    (pageSize) => ({
      size: pageSize,
      href: buildPaginationHref(
        pathname,
        currentSearchParams,
        ADMIN_POOL_GROUP_PAGINATION_NAMES,
        { pageSize },
        "criteria"
      ),
    })
  );

  /** 用 URL 提交成员筛选并清理旧页码。 */
  function updateMemberFilters(next: BackendMemberFilters): void {
    router.push(
      buildPaginationHref(
        pathname,
        currentSearchParams,
        ADMIN_POOL_MEMBER_PAGINATION_NAMES,
        {
          criteria: {
            [ADMIN_POOL_MEMBER_FILTER_PARAMS.name]: next.name.trim() || null,
            [ADMIN_POOL_MEMBER_FILTER_PARAMS.credentialStatus]:
              next.credentialStatus === "all" ? null : next.credentialStatus,
            [ADMIN_POOL_MEMBER_FILTER_PARAMS.modelId]:
              next.modelId === "all" ? null : next.modelId,
            [ADMIN_POOL_MEMBER_FILTER_PARAMS.createdFrom]:
              next.createdFrom || null,
            [ADMIN_POOL_MEMBER_FILTER_PARAMS.createdTo]: next.createdTo || null,
          },
        },
        "criteria"
      )
    );
  }

  /** 用 URL 提交分组名称筛选并清理旧页码。 */
  function updateGroupNameFilter(name: string): void {
    router.push(
      buildPaginationHref(
        pathname,
        currentSearchParams,
        ADMIN_POOL_GROUP_PAGINATION_NAMES,
        {
          criteria: {
            [ADMIN_POOL_GROUP_NAME_PARAM]: name.trim() || null,
          },
        },
        "criteria"
      )
    );
  }

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
    setMemberPage((current) =>
      current
        ? {
            ...current,
            records: current.records.map((item) =>
              item.id === member.id ? { ...item, isEnabled } : item
            ),
          }
        : current
    );
    setMemberEnabled({ id: member.id, isEnabled });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">{title}</h2>
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
            reloadPoolSnapshots();
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
          {readOnlyNotice}
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

      <Tabs
        className="w-full"
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams.toString());
          if (value === "groups") next.set(ADMIN_POOL_TAB_PARAM, "groups");
          else next.delete(ADMIN_POOL_TAB_PARAM);
          next.sort();
          const query = next.toString();
          router.push(query ? `${pathname}?${query}` : pathname);
        }}
        value={activePoolTab}
      >
        <TabsList
          aria-label="供应商管理内容"
          className="h-auto flex-wrap justify-start bg-transparent p-0"
        >
          <TabsTrigger
            className="gap-2 rounded-md border border-transparent px-3 py-2 data-[state=active]:border-foreground/20 data-[state=active]:bg-foreground/5 data-[state=active]:shadow-none"
            value="members"
          >
            供应商账号
            <span className="text-xs tabular-nums text-muted-foreground">
              {memberPage?.totalCount ?? members.length}
            </span>
          </TabsTrigger>
          <TabsTrigger
            className="gap-2 rounded-md border border-transparent px-3 py-2 data-[state=active]:border-foreground/20 data-[state=active]:bg-foreground/5 data-[state=active]:shadow-none"
            value="groups"
          >
            分组
            <span className="text-xs tabular-nums text-muted-foreground">
              {groupPage?.totalCount ?? groups.length}
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
              onChange={updateMemberFilters}
              resultCount={memberPage?.totalCount ?? 0}
              timeZone={timeZone}
              totalCount={members.length}
            />
            {isLoadingMemberPage && !memberPage ? (
              <PoolListLoadingState label="正在加载供应商账号" />
            ) : (
              <div
                className="grid gap-3 xl:grid-cols-2"
                id="backend-member-list"
                tabIndex={-1}
              >
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
            {memberPage ? (
              <div className="space-y-3 border-t pt-4">
                <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <span>共 {memberPage.totalCount} 条</span>
                  <UrlPageSizeSelect
                    itemSuffix=" 条/页"
                    label="每页条数"
                    options={memberPageSizeOptions}
                    value={memberPage.pageSize}
                  />
                </div>
                <UrlPaginationControls
                  ariaLabel="供应商账号分页"
                  currentPageLabelTemplate="第 {page} 页，当前页"
                  focusTargetId="backend-member-list"
                  names={ADMIN_POOL_MEMBER_PAGINATION_NAMES}
                  nextLabel="下一页"
                  page={memberPage.page}
                  pageLabelTemplate="前往第 {page} 页"
                  pageSelectLabel="选择页码"
                  previousLabel="上一页"
                  totalPages={memberPage.totalPages}
                />
              </div>
            ) : null}
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
              onChange={updateGroupNameFilter}
              resultCount={groupPage?.totalCount ?? 0}
              totalCount={groups.length}
            />
            {isLoadingGroupPage && !groupPage ? (
              <PoolListLoadingState label="正在加载供应商分组" />
            ) : (
              <div
                className="overflow-hidden rounded-lg border bg-background"
                id="backend-group-list"
                tabIndex={-1}
              >
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
            {groupPage ? (
              <div className="space-y-3 border-t pt-4">
                <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <span>共 {groupPage.totalCount} 条</span>
                  <UrlPageSizeSelect
                    itemSuffix=" 条/页"
                    label="每页条数"
                    options={groupPageSizeOptions}
                    value={groupPage.pageSize}
                  />
                </div>
                <UrlPaginationControls
                  ariaLabel="账号池分组分页"
                  currentPageLabelTemplate="第 {page} 页，当前页"
                  focusTargetId="backend-group-list"
                  names={ADMIN_POOL_GROUP_PAGINATION_NAMES}
                  nextLabel="下一页"
                  page={groupPage.page}
                  pageLabelTemplate="前往第 {page} 页"
                  pageSelectLabel="选择页码"
                  previousLabel="上一页"
                  totalPages={groupPage.totalPages}
                />
              </div>
            ) : null}
          </section>
        </TabsContent>
      </Tabs>

      <BackendGroupFormDialog
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
        group={editingGroup}
        groups={groups}
        imageModelIds={imageModelIds}
        videoPricingModels={videoPricingModels}
        onSaved={reloadPoolSnapshots}
      />
      <BackendMemberFormDialog
        open={memberDialogOpen}
        onOpenChange={setMemberDialogOpen}
        member={editingMember}
        groups={groups}
        modelOptions={modelOptions}
        modelOptionStatus={modelOptionStatus}
        onSaved={reloadPoolSnapshots}
      />
    </div>
  );
}
