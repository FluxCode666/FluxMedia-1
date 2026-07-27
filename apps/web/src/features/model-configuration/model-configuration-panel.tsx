"use client";

/**
 * 管理端模型配置页签的读取、筛选与 Dialog 编排组件。
 *
 * 使用方是管理员设置页；本组件仅调用读取 Server Action、持有共享快照并把单条保存交给
 * Dialog 的 multipart Route，不访问数据库、不在客户端合并价格或推断权限。
 */
import type {
  ModelConfigurationEntry,
  ModelConfigurationSnapshot,
} from "@repo/shared/model-marketplace";
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
import { AlertTriangle, Loader2, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { getModelConfigurationAction } from "./actions";
import { ModelConfigurationDialog } from "./model-configuration-dialog";
import { ModelConfigurationTable } from "./model-configuration-table";
import {
  filterModelConfigurationEntries,
  type ModelConfigurationCategoryFilter,
} from "./model-configuration-view-model";

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
export function ModelConfigurationPanel() {
  const [snapshot, setSnapshot] = useState<ModelConfigurationSnapshot | null>(
    null
  );
  const [query, setQuery] = useState("");
  const [category, setCategory] =
    useState<ModelConfigurationCategoryFilter>("all");
  const [selected, setSelected] = useState<SelectedModelIdentity | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** 读取唯一 UOL 管理快照，并可供冲突重载返回最新条目。 */
  const loadSnapshot =
    useCallback(async (): Promise<ModelConfigurationSnapshot | null> => {
      setIsLoading(true);
      try {
        const result = await getModelConfigurationAction();
        if (!result?.data) {
          setLoadError(result?.serverError ?? "模型配置暂不可用");
          return null;
        }
        setSnapshot(result.data);
        setLoadError(null);
        return result.data;
      } catch {
        setLoadError("模型配置暂不可用");
        return null;
      } finally {
        setIsLoading(false);
      }
    }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const filteredEntries = useMemo(
    () =>
      filterModelConfigurationEntries(snapshot?.entries ?? [], query, category),
    [category, query, snapshot?.entries]
  );
  const selectedEntry = useMemo(() => {
    if (!selected || !snapshot) return null;
    return (
      snapshot.entries.find(
        (entry) =>
          entry.category === selected.category &&
          entry.configKey === selected.configKey
      ) ?? null
    );
  }, [selected, snapshot]);

  /** 打开当前行的查看或编辑 Dialog。 */
  const handleSelect = (entry: ModelConfigurationEntry): void => {
    setSelected({ category: entry.category, configKey: entry.configKey });
    setDialogOpen(true);
  };

  /** 保存完成后刷新列表；刷新失败保留 Dialog 的成功事实并提供页签重试。 */
  const handleSaved = async (): Promise<void> => {
    const latest = await loadSnapshot();
    if (!latest) toast.error("配置已保存，但列表刷新失败");
  };

  /** 冲突时读取同一模型最新 DTO，供 Dialog 在新 revision 上重放草稿。 */
  const handleReloadEntry =
    async (): Promise<ModelConfigurationEntry | null> => {
      if (!selected) return null;
      const latest = await loadSnapshot();
      return (
        latest?.entries.find(
          (entry) =>
            entry.category === selected.category &&
            entry.configKey === selected.configKey
        ) ?? null
      );
    };

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>模型配置</CardTitle>
            <CardDescription>
              按模型维护全局价格、模型广场展示信息和 3:2
              封面。展示开关不会改变调度、创作目录或实际计费。
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isLoading}
            onClick={() => void loadSnapshot()}
          >
            {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="flex flex-col gap-3 px-4 pb-4 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索模型 ID 或名称"
              aria-label="搜索模型 ID 或名称"
              className="pl-9"
            />
          </div>
          <Select
            value={category}
            onValueChange={(value) => setCategory(parseCategoryFilter(value))}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="筛选模型类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="image">图像模型</SelectItem>
              <SelectItem value="video">视频模型</SelectItem>
            </SelectContent>
          </Select>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {filteredEntries.length} 个结果
          </span>
        </div>

        {snapshot?.runtimeCatalogStatus === "unavailable" ? (
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

        {loadError && !snapshot ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 border-t px-4 text-center">
            <p className="text-sm text-muted-foreground">{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadSnapshot()}
            >
              重新加载
            </Button>
          </div>
        ) : isLoading && !snapshot ? (
          <div className="flex min-h-48 items-center justify-center border-t text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在加载模型配置
          </div>
        ) : (
          <ModelConfigurationTable
            entries={filteredEntries}
            canEdit={snapshot?.canEdit ?? false}
            onSelect={handleSelect}
          />
        )}
      </CardContent>

      {selectedEntry && snapshot ? (
        <ModelConfigurationDialog
          entry={selectedEntry}
          canEdit={snapshot.canEdit}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onReloadEntry={handleReloadEntry}
          onSaved={handleSaved}
        />
      ) : null}
    </Card>
  );
}
