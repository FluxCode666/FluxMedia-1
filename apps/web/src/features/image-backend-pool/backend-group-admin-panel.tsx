"use client";

/**
 * 统一媒体后端分组管理面板。
 *
 * 使用方是独立分组管理页面；组件复用既有分组 Action、筛选、分页、语义列表和计费
 * 覆盖表单，不拥有权限事实，也不直接访问数据库或调度服务。
 */
import type { BackendGroupSummary } from "@repo/shared/image-backend/group-contract";
import { isLegacyVideoModelId } from "@repo/shared/image-backend/supported-models";
import type { PaginationConfig } from "@repo/shared/pagination/config";
import { buildPaginationHref } from "@repo/shared/pagination/url-adapter";
import { normalizeVideoModelId } from "@repo/shared/video-generation";
import { Button } from "@repo/ui/components/button";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { getModelConfigurationAction } from "@/features/model-configuration/actions";
import { UrlPaginationControls } from "@/features/pagination/pagination-controls";
import { UrlPageSizeSelect } from "@/features/pagination/url-page-size-select";
import { usePathname, useRouter } from "@/i18n/routing";
import {
  type BackendPoolAdminMemberSummary,
  deleteImageBackendGroupAction,
  getAdminImageBackendPoolAction,
  listAdminImageBackendGroupsAction,
} from "./actions";
import { BackendGroupList } from "./admin-group-list";
import { BackendGroupFilterBar } from "./admin-pool-filter-bars";
import {
  ADMIN_POOL_GROUP_NAME_PARAM,
  ADMIN_POOL_GROUP_PAGINATION_NAMES,
  parseAdminPoolGroupListInput,
} from "./admin-pool-pagination";
import { hasBackendGroupFilter } from "./admin-pool-view-model";
import { BackendGroupFormDialog } from "./group-form";
import type { VideoCreditPricingModel } from "./video-credit-pricing-editor";

type BackendGroupPage = {
  records: BackendGroupSummary[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};

/** 展示分组明细首次加载时的稳定骨架。 */
function GroupListLoadingState() {
  return (
    <div
      aria-busy="true"
      aria-label="正在加载供应商分组"
      className="h-40 animate-pulse rounded-lg border bg-muted/30"
      role="status"
    />
  );
}

/**
 * 渲染分组筛选、分页、语义列表和编辑表单。
 *
 * @param props 分页配置、页面标题、只读状态与只读提示。
 * @returns 独立分组管理面板；只读时不渲染创建、编辑或删除入口。
 * @sideEffects 读取既有 Action 快照，写入仍由 adminAction/UOL 校验。
 * @failure 读取或写入失败时保留当前快照并显示可定位 toast。
 */
export function BackendGroupAdminPanel({
  paginationConfig,
  readOnly = false,
  title = "分组管理",
  readOnlyNotice = "当前角色仅可查看分组，写操作已禁用。",
}: {
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
  const groupListInput = useMemo(
    () => parseAdminPoolGroupListInput(currentSearchParams, paginationConfig),
    [currentSearchParams, paginationConfig]
  );
  const [groups, setGroups] = useState<BackendGroupSummary[]>([]);
  const [members, setMembers] = useState<BackendPoolAdminMemberSummary[]>([]);
  const [groupPage, setGroupPage] = useState<BackendGroupPage | null>(null);
  const [videoPricingModels, setVideoPricingModels] = useState<
    VideoCreditPricingModel[]
  >([]);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<BackendGroupSummary | null>(
    null
  );

  const { execute: loadPool, isPending: isLoadingPool } = useAction(
    getAdminImageBackendPoolAction,
    {
      onSuccess: ({ data }) => {
        setGroups(data?.groups ?? []);
        setMembers(data?.members ?? []);
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "加载分组管理失败"),
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
  const { execute: loadModelConfiguration, isPending: isLoadingModels } =
    useAction(getModelConfigurationAction, {
      onSuccess: ({ data }) => {
        setVideoPricingModels(
          data?.entries.flatMap((entry) =>
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
          ) ?? []
        );
      },
      onError: ({ error }) => {
        setVideoPricingModels([]);
        toast.error(error.serverError || "加载模型配置失败");
      },
    });
  const { execute: deleteGroup, isPending: isDeletingGroup } = useAction(
    deleteImageBackendGroupAction,
    {
      onSuccess: () => {
        toast.success("分组已删除");
        reloadGroupSnapshots();
      },
      onError: ({ error }) => toast.error(error.serverError || "删除分组失败"),
    }
  );

  /** 分组写入后同步完整辅助快照和分页明细。 */
  function reloadGroupSnapshots(): void {
    loadPool();
    loadGroupPage(groupListInput);
  }

  useEffect(() => {
    loadPool();
    loadModelConfiguration();
  }, [loadModelConfiguration, loadPool]);

  useEffect(() => {
    loadGroupPage(groupListInput);
  }, [groupListInput, loadGroupPage]);

  const memberCountByGroup = useMemo(() => {
    const counts = new Map<string, number>();
    for (const member of members) {
      for (const groupId of member.groupIds) {
        counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
      }
    }
    return counts;
  }, [members]);
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

  const filteredGroups = groupPage?.records ?? [];
  const isRefreshing = isLoadingPool || isLoadingModels;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            分组控制访问、内容安全、计费覆盖和任务队列优先级。
          </p>
        </div>
        <Button
          disabled={isRefreshing}
          onClick={() => {
            reloadGroupSnapshots();
            loadModelConfiguration();
          }}
          type="button"
          variant="outline"
        >
          {isRefreshing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          刷新
        </Button>
      </div>

      {readOnly ? (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {readOnlyNotice}
        </div>
      ) : null}

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
          name={groupListInput.name}
          onChange={updateGroupNameFilter}
          resultCount={groupPage?.totalCount ?? 0}
          totalCount={groups.length}
        />
        {isLoadingGroupPage && !groupPage ? (
          <GroupListLoadingState />
        ) : (
          <div
            className="overflow-hidden rounded-lg border bg-background"
            id="backend-group-list"
            tabIndex={-1}
          >
            <BackendGroupList
              allGroups={groups}
              groups={filteredGroups}
              hasNameFilter={hasBackendGroupFilter(groupListInput.name)}
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

      <BackendGroupFormDialog
        group={editingGroup}
        groups={groups}
        imageModelIds={imageModelIds}
        onOpenChange={setGroupDialogOpen}
        onSaved={reloadGroupSnapshots}
        open={groupDialogOpen}
        videoPricingModels={videoPricingModels}
      />
    </div>
  );
}
