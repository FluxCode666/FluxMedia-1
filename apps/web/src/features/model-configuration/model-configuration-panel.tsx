"use client";

/**
 * 管理端模型配置页签的读取、筛选与 Dialog 编排组件。
 *
 * 使用方是管理员设置页；本组件仅调用读取 Server Action、持有共享快照并把单条保存交给
 * Dialog 的 multipart Route，不访问数据库、不在客户端合并价格或推断权限。
 */
import type {
  ModelConfigurationEntry,
  ModelConfigurationListOutput,
  ModelConfigurationSnapshot,
} from "@repo/shared/model-marketplace";
import type { PaginationConfig } from "@repo/shared/pagination/config";
import { buildPaginationHref } from "@repo/shared/pagination/url-adapter";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { AlertTriangle, Loader2, Plus, RefreshCw, Search } from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";

import { UrlPaginationControls } from "@/features/pagination/pagination-controls";
import { UrlPageSizeSelect } from "@/features/pagination/url-page-size-select";
import { usePathname, useRouter } from "@/i18n/routing";

import {
  getModelConfigurationAction,
  listModelConfigurationsAction,
} from "./actions";
import { CustomModelConfigurationDialog } from "./custom-model-configuration-dialog";
import { ModelConfigurationDialog } from "./model-configuration-dialog";
import {
  MODEL_CONFIGURATION_CATEGORY_PARAM,
  MODEL_CONFIGURATION_PAGINATION_NAMES,
  MODEL_CONFIGURATION_QUERY_PARAM,
  parseModelConfigurationListInput,
} from "./model-configuration-pagination";
import { ModelConfigurationTable } from "./model-configuration-table";
import type { ModelConfigurationCategoryFilter } from "./model-configuration-view-model";

type SelectedModelIdentity = {
  category: ModelConfigurationEntry["category"];
  configKey: string;
};

/** 把 Select 的外部字符串收窄为管理列表允许的筛选值。 */
function parseCategoryFilter(value: string): ModelConfigurationCategoryFilter {
  return value === "image" || value === "video" ? value : "all";
}

/**
 * 渲染模型配置列表并编排单条编辑。
 *
 * @returns 当前主题下的卡片、工具栏、表格、失败状态和受控 Dialog。
 * @sideEffects 首次挂载及刷新时调用读取 Action；Dialog 保存后重新读取完整规范快照。
 * @failure Action 失败显示可重试状态，不回退旧全量价格入口，也不伪造空快照。
 */
export function ModelConfigurationPanel({
  paginationConfig,
  title = "模型配置",
  readOnlyNotice = "当前角色仅可查看，写操作已禁用。",
}: {
  paginationConfig: PaginationConfig;
  title?: string;
  readOnlyNotice?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const input = useMemo(
    () =>
      parseModelConfigurationListInput(
        new URLSearchParams(searchParams.toString()),
        paginationConfig
      ),
    [paginationConfig, searchParams]
  );
  const [pageResult, setPageResult] =
    useState<ModelConfigurationListOutput | null>(null);
  const [queryDraft, setQueryDraft] = useState(input.query);
  const [selected, setSelected] = useState<SelectedModelIdentity | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** 按 URL 条件读取当前页，并在服务端收敛越界页后规范化地址。 */
  const loadPage =
    useCallback(async (): Promise<ModelConfigurationListOutput | null> => {
      setIsLoading(true);
      try {
        const result = await listModelConfigurationsAction(input);
        if (!result?.data) {
          setLoadError(result?.serverError ?? "模型配置暂不可用");
          return null;
        }
        setPageResult(result.data);
        setLoadError(null);
        if (result.data.page !== input.page) {
          router.replace(
            buildPaginationHref(
              pathname,
              new URLSearchParams(searchParams.toString()),
              MODEL_CONFIGURATION_PAGINATION_NAMES,
              { page: result.data.page },
              "page"
            )
          );
        }
        return result.data;
      } catch {
        setLoadError("模型配置暂不可用");
        return null;
      } finally {
        setIsLoading(false);
      }
    }, [input, pathname, router, searchParams]);

  useEffect(() => {
    setQueryDraft(input.query);
    void loadPage();
  }, [input.query, loadPage]);

  const selectedEntry = useMemo(() => {
    if (!selected || !pageResult) return null;
    return (
      pageResult.records.find(
        (entry) =>
          entry.category === selected.category &&
          entry.configKey === selected.configKey
      ) ?? null
    );
  }, [pageResult, selected]);

  const pageSizeOptions = useMemo(
    () =>
      paginationConfig.pageSizeOptions.map((pageSize) => ({
        size: pageSize,
        href: buildPaginationHref(
          pathname,
          new URLSearchParams(searchParams.toString()),
          MODEL_CONFIGURATION_PAGINATION_NAMES,
          { pageSize },
          "criteria"
        ),
      })),
    [paginationConfig.pageSizeOptions, pathname, searchParams]
  );

  /** 打开当前行的查看或编辑 Dialog。 */
  const handleSelect = (entry: ModelConfigurationEntry): void => {
    setSelected({ category: entry.category, configKey: entry.configKey });
    setDialogOpen(true);
  };

  /** 保存完成后刷新列表；刷新失败保留 Dialog 的成功事实并提供页签重试。 */
  const handleSaved = async (): Promise<void> => {
    const latest = await loadPage();
    if (!latest) toast.error("配置已保存，但列表刷新失败");
  };

  /** 冲突时读取同一模型最新 DTO，供 Dialog 在新 revision 上重放草稿。 */
  const handleReloadEntry =
    async (): Promise<ModelConfigurationEntry | null> => {
      if (!selected) return null;
      const result = await getModelConfigurationAction();
      const latest: ModelConfigurationSnapshot | null = result?.data ?? null;
      return (
        latest?.entries.find(
          (entry) =>
            entry.category === selected.category &&
            entry.configKey === selected.configKey
        ) ?? null
      );
    };

  /** 提交搜索词并清理旧分页边界。 */
  const handleSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    router.push(
      buildPaginationHref(
        pathname,
        new URLSearchParams(searchParams.toString()),
        MODEL_CONFIGURATION_PAGINATION_NAMES,
        {
          criteria: {
            [MODEL_CONFIGURATION_QUERY_PARAM]: queryDraft.trim() || null,
          },
        },
        "criteria"
      )
    );
  };

  /** 更新媒体类别并回到第一页。 */
  const handleCategoryChange = (value: string): void => {
    const category = parseCategoryFilter(value);
    router.push(
      buildPaginationHref(
        pathname,
        new URLSearchParams(searchParams.toString()),
        MODEL_CONFIGURATION_PAGINATION_NAMES,
        {
          criteria: {
            [MODEL_CONFIGURATION_CATEGORY_PARAM]:
              category === "all" ? null : category,
          },
        },
        "criteria"
      )
    );
  };

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>{title}</CardTitle>
            <CardDescription>
              新增自定义模型
              ID、媒体类型和支持分辨率，并按模型维护全局价格、展示信息与 3:2
              封面。账号只能选择这里已经注册的模型。
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {pageResult?.canEdit ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setCreateDialogOpen(true)}
              >
                <Plus />
                新增自定义模型
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isLoading}
              onClick={() => void loadPage()}
            >
              {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              刷新
            </Button>
          </div>
        </div>
      </CardHeader>
      {pageResult && !pageResult.canEdit ? (
        <div className="mx-4 mb-4 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {readOnlyNotice}
        </div>
      ) : null}
      <CardContent className="p-0">
        <form
          className="flex flex-col gap-3 px-4 pb-4 sm:flex-row sm:items-center"
          onSubmit={handleSearch}
        >
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder="搜索模型 ID 或名称"
              aria-label="搜索模型 ID 或名称"
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            搜索
          </Button>
          <Select value={input.category} onValueChange={handleCategoryChange}>
            <SelectTrigger className="w-full sm:w-40" aria-label="筛选模型类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="image">图像模型</SelectItem>
              <SelectItem value="video">视频模型</SelectItem>
            </SelectContent>
          </Select>
        </form>

        {pageResult?.runtimeCatalogStatus === "unavailable" ? (
          <div className="mx-4 mb-4 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
              aria-hidden="true"
            />
            <p>
              运行时模型目录暂不可用；当前仍展示内置模型和已持久化价格模型，保存前请确认模型身份。
            </p>
          </div>
        ) : null}

        {loadError && !pageResult ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 border-t px-4 text-center">
            <p className="text-sm text-muted-foreground">{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadPage()}
            >
              重新加载
            </Button>
          </div>
        ) : isLoading && !pageResult ? (
          <div className="flex min-h-48 items-center justify-center border-t text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在加载模型配置
          </div>
        ) : (
          <>
            {loadError ? (
              <div className="mx-4 mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {loadError}，当前仍显示上次成功结果。
              </div>
            ) : null}
            <ModelConfigurationTable
              entries={pageResult?.records ?? []}
              canEdit={pageResult?.canEdit ?? false}
              onSelect={handleSelect}
            />
            {pageResult ? (
              <div className="space-y-3 border-t px-4 py-4">
                <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <span>共 {pageResult.totalCount} 条</span>
                  <UrlPageSizeSelect
                    itemSuffix=" 条/页"
                    label="每页条数"
                    options={pageSizeOptions}
                    value={pageResult.pageSize}
                  />
                </div>
                <UrlPaginationControls
                  ariaLabel="模型配置分页"
                  currentPageLabelTemplate="第 {page} 页，当前页"
                  focusTargetId="model-configuration-list"
                  names={MODEL_CONFIGURATION_PAGINATION_NAMES}
                  nextLabel="下一页"
                  page={pageResult.page}
                  pageLabelTemplate="前往第 {page} 页"
                  pageSelectLabel="选择页码"
                  previousLabel="上一页"
                  totalPages={pageResult.totalPages}
                />
              </div>
            ) : null}
          </>
        )}
      </CardContent>

      {selectedEntry && pageResult ? (
        <ModelConfigurationDialog
          entry={selectedEntry}
          canEdit={pageResult.canEdit}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onReloadEntry={handleReloadEntry}
          onSaved={handleSaved}
        />
      ) : null}
      {pageResult?.canEdit ? (
        <CustomModelConfigurationDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          onCreated={handleSaved}
        />
      ) : null}
    </Card>
  );
}
