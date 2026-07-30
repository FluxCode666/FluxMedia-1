/**
 * 公开模型广场的客户端浏览器。
 *
 * 使用方是 `/models` Server Component；本组件只对公开 DTO 做本地搜索、类别与厂商
 * 筛选、Clipboard 反馈和详情 Dialog 编排，不重新请求目录或解释展示配置。
 */
"use client";

import type { ModelMarketplacePublicItem } from "@repo/shared/model-marketplace";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@repo/ui/components/sheet";
import { ListFilter, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ModelMarketplaceCard } from "./model-card";
import { ModelDetailDialog } from "./model-detail-dialog";
import { ModelMarketplaceFilterControls } from "./model-marketplace-filter-controls";
import {
  copyModelMarketplaceId,
  filterModelMarketplaceModels,
  getAvailableModelMarketplaceProviders,
  type ModelMarketplaceCategoryFilter,
  type ModelMarketplaceProviderFilter,
} from "./model-marketplace-view-model";

/**
 * 渲染可搜索、可筛选的模型卡片目录。
 *
 * @param props - Server Component 交付的公开模型数组。
 * @returns 桌面侧栏三列网格、移动筛选 Sheet 和受控详情 Dialog。
 * @sideEffects 用户可写剪贴板、打开 Dialog、修改本地筛选状态或导航到创作页。
 * @failure Clipboard 失败显示反馈；本地筛选为空显示稳定空状态。
 */
export function ModelMarketplaceBrowser({
  models,
}: {
  models: ModelMarketplacePublicItem[];
}) {
  const t = useTranslations("ModelMarketplace");
  const [query, setQuery] = useState("");
  const [category, setCategory] =
    useState<ModelMarketplaceCategoryFilter>("all");
  const [provider, setProvider] =
    useState<ModelMarketplaceProviderFilter>("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedModel, setSelectedModel] =
    useState<ModelMarketplacePublicItem | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const availableProviders = useMemo(
    () => getAvailableModelMarketplaceProviders(models),
    [models]
  );
  const filteredModels = useMemo(
    () => filterModelMarketplaceModels(models, query, category, provider),
    [category, models, provider, query]
  );

  /** 写入完整 ID 并显示不会泄露异常细节的成功或失败反馈。 */
  const handleCopy = async (modelId: string): Promise<void> => {
    const clipboardWriter = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : null;
    const copied = await copyModelMarketplaceId(modelId, clipboardWriter);
    if (copied) toast.success(t("actions.copySuccess"));
    else toast.error(t("actions.copyFailure"));
  };

  /** 保存选中模型后打开受控 Dialog，关闭动画期间继续保留当前 DTO。 */
  const handleViewDetails = (model: ModelMarketplacePublicItem): void => {
    setSelectedModel(model);
    setDetailsOpen(true);
  };

  return (
    <>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-md">
            <Label className="sr-only" htmlFor="model-marketplace-search">
              {t("filters.searchLabel")}
            </Label>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-11 pl-9"
              id="model-marketplace-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("filters.searchPlaceholder")}
              type="search"
              value={query}
            />
          </div>
          <div className="flex items-center justify-between gap-3 sm:justify-end">
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {t("resultCount", { count: filteredModels.length })}
            </p>
            <Button
              type="button"
              className="lg:hidden"
              onClick={() => setFiltersOpen(true)}
              variant="outline"
            >
              <ListFilter className="size-4" />
              {t("filters.open")}
            </Button>
          </div>
        </div>

        <div className="grid items-start gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="sticky top-24 hidden rounded-xl border bg-card p-4 lg:block">
            <ModelMarketplaceFilterControls
              availableProviders={availableProviders}
              category={category}
              idPrefix="desktop"
              onCategoryChange={setCategory}
              onProviderChange={setProvider}
              provider={provider}
            />
          </aside>

          {filteredModels.length > 0 ? (
            <div className="grid min-w-0 gap-5 md:grid-cols-2 xl:grid-cols-3">
              {filteredModels.map((model, index) => (
                <ModelMarketplaceCard
                  key={`${model.category}:${model.configKey}`}
                  eagerCover={index < 3}
                  model={model}
                  onCopy={(modelId) => void handleCopy(modelId)}
                  onViewDetails={handleViewDetails}
                />
              ))}
            </div>
          ) : (
            <div className="flex min-h-80 items-center justify-center rounded-xl border border-dashed bg-muted/20 px-6 text-center">
              <div className="max-w-sm">
                <h2 className="font-serif text-2xl font-medium">
                  {t("filteredEmpty.title")}
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {t("filteredEmpty.description")}
                </p>
                <Button
                  type="button"
                  className="mt-5"
                  onClick={() => {
                    setQuery("");
                    setCategory("all");
                    setProvider("all");
                  }}
                  variant="outline"
                >
                  {t("filters.clear")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <Sheet open={filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent className="w-[min(22rem,88vw)]" side="right">
          <SheetHeader className="text-left">
            <SheetTitle>{t("filters.title")}</SheetTitle>
            <SheetDescription>{t("filters.description")}</SheetDescription>
          </SheetHeader>
          <div className="mt-7">
            <ModelMarketplaceFilterControls
              availableProviders={availableProviders}
              category={category}
              idPrefix="mobile"
              onCategoryChange={(value) => {
                setCategory(value);
                setFiltersOpen(false);
              }}
              onProviderChange={(value) => {
                setProvider(value);
                setFiltersOpen(false);
              }}
              provider={provider}
            />
          </div>
        </SheetContent>
      </Sheet>

      <ModelDetailDialog
        model={selectedModel}
        onCopy={(modelId) => void handleCopy(modelId)}
        onOpenChange={setDetailsOpen}
        open={detailsOpen}
      />
    </>
  );
}
